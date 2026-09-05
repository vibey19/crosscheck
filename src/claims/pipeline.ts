import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getConfig } from '../config.js';
import { getDb } from '../db/client.js';
import {
  claims as claimsTable, documents, embeddingCache, EMBEDDING_DIMS, sections as sectionsTable,
} from '../db/schema.js';
import { embedTexts } from '../llm/gemini.js';
import type { IngestedDocument } from '../ingest/pipeline.js';
import { sectionText } from '../ingest/pipeline.js';
import { createHash } from 'node:crypto';
import { extractClaims, shouldExtract, type LocatedClaim, type SectionForExtraction } from './extract.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ExtractionStats {
  sectionsConsidered: number;
  sectionsFromCache: number;
  /** Generate calls actually spent — the figure the 20-per-day free-tier cap applies to. */
  llmCalls: number;
  claims: number;
  spansResolved: number;
  byType: Record<string, number>;
  /** Vectors served from the durable cache — the figure that reflects quota actually saved. */
  embeddingsFromCache: number;
  /** Distinct texts embedded this run. */
  embeddingsComputed: number;
  /** Claims sharing an identical embedding text within this document, so embedded once. */
  embeddingsDeduplicated: number;
}

/**
 * Texts per embedding request.
 *
 * Bounded by the per-minute TEXT quota rather than a request count, so a bigger batch buys nothing
 * and a rejected one still spends the daily allowance.
 */
const EMBED_BATCH = 40;

/** Claims per insert statement. Postgres parameter limits, not quota. */
const INSERT_BATCH = 100;

/**
 * The text an embedding is computed over.
 *
 * Subject first, then the quote. Two claims about the same measurement should land near each other
 * even when phrased differently — a table row and a sentence describing it share almost no words.
 */
function embeddingText(claim: LocatedClaim): string {
  return `${claim.subject}\n${claim.text}`;
}

/**
 * Extracts, embeds and stores every claim in a document.
 *
 * Assumes the document and its sections are already persisted, which `ingest --save` does.
 *
 * `documentId` is passed explicitly by the eval harness: a mutated variant shares its arXiv id with
 * the paper it came from, and lookup by identifier deliberately excludes variants.
 */
export async function extractDocumentClaims(
  doc: IngestedDocument,
  documentId?: string,
): Promise<ExtractionStats> {
  const db = getDb();

  const documentRow = documentId
    ? { id: documentId }
    : (
        await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.arxivId, doc.arxivId), isNull(documents.evalRunId)))
          .limit(1)
      )[0];
  if (!documentRow) throw new Error(`${doc.idWithVersion} is not saved; run ingest --save first.`);

  const sectionRows = await db
    .select({ id: sectionsTable.id, path: sectionsTable.path, ordinal: sectionsTable.ordinal })
    .from(sectionsTable)
    .where(eq(sectionsTable.documentId, documentRow.id));
  const sectionIdByOrdinal = new Map(sectionRows.map((row) => [row.ordinal, row.id]));

  const eligible: SectionForExtraction[] = [];
  const sectionIdByPath = new Map<string, string>();

  for (const section of doc.sections) {
    const body = sectionText(doc, section);
    if (!shouldExtract(section.title, body.length)) continue;
    const sectionId = sectionIdByOrdinal.get(section.ordinal);
    if (!sectionId) continue;

    eligible.push({ path: section.path, text: body, offset: section.charStart });
    sectionIdByPath.set(section.path, sectionId);
  }

  const { claimsByPath, sectionsFromCache, llmCalls } = await extractClaims(eligible);

  const stats: ExtractionStats = {
    sectionsConsidered: eligible.length,
    sectionsFromCache,
    llmCalls,
    claims: 0,
    spansResolved: 0,
    byType: {},
    embeddingsFromCache: 0,
    embeddingsComputed: 0,
    embeddingsDeduplicated: 0,
  };

  const pending: { sectionId: string; claim: LocatedClaim }[] = [];
  for (const [path, claims] of claimsByPath) {
    const sectionId = sectionIdByPath.get(path);
    if (!sectionId) continue;
    for (const claim of claims) {
      pending.push({ sectionId, claim });
      stats.claims += 1;
      if (claim.spanResolved) stats.spansResolved += 1;
      stats.byType[claim.claimType] = (stats.byType[claim.claimType] ?? 0) + 1;
    }
  }

  if (pending.length === 0) {
    await db.delete(claimsTable).where(eq(claimsTable.documentId, documentRow.id));
    return stats;
  }

  const { GEMINI_EMBEDDING_MODEL } = getConfig();
  // Key on the exact text embedded, which includes the subject line.
  const keyFor = (claim: LocatedClaim) => sha256(embeddingText(claim));
  const keys = new Map(pending.map(({ claim }, index) => [index, keyFor(claim)]));

  const cachedRows = await db
    .select({ contentHash: embeddingCache.contentHash, embedding: embeddingCache.embedding })
    .from(embeddingCache)
    .where(
      and(
        inArray(embeddingCache.contentHash, [...new Set(keys.values())]),
        eq(embeddingCache.model, GEMINI_EMBEDDING_MODEL),
        eq(embeddingCache.dims, EMBEDDING_DIMS),
      ),
    );
  const vectorByKey = new Map(cachedRows.map((row) => [row.contentHash, row.embedding]));

  const needed = [...new Set([...keys.values()].filter((key) => !vectorByKey.has(key)))];
  const textByKey = new Map(pending.map(({ claim }) => [keyFor(claim), embeddingText(claim)]));

  for (let start = 0; start < needed.length; start += EMBED_BATCH) {
    const batchKeys = needed.slice(start, start + EMBED_BATCH);
    const vectors = await embedTexts(batchKeys.map((key) => textByKey.get(key)!));
    for (const [index, key] of batchKeys.entries()) {
      vectorByKey.set(key, vectors[index]!);
      await db
        .insert(embeddingCache)
        .values({ contentHash: key, model: GEMINI_EMBEDDING_MODEL, dims: EMBEDDING_DIMS, embedding: vectors[index]! })
        .onConflictDoNothing();
    }
  }

  // Three distinct things, previously conflated into one misleading "reused" figure: cache hits
  // save quota, in-document duplicates never cost any, and computed texts are what was spent.
  const distinct = new Set(keys.values()).size;
  stats.embeddingsComputed = needed.length;
  stats.embeddingsFromCache = distinct - needed.length;
  stats.embeddingsDeduplicated = pending.length - distinct;

  const rows = pending.map(({ sectionId, claim }, index) => ({
    documentId: documentRow.id,
    sectionId,
    text: claim.text,
    charStart: claim.charStart,
    charEnd: claim.charEnd,
    spanResolved: claim.spanResolved,
    claimType: claim.claimType,
    subject: claim.subject,
    quantities: claim.quantities,
    embedding: vectorByKey.get(keys.get(index)!)!,
    contentHash: claim.contentHash,
  }));

  // Swap only once every vector is in hand. Deleting first and embedding afterwards loses the
  // document's claims outright when the embedding quota rejects the batch — which is exactly how a
  // previously extracted paper ended up with none.
  await db.transaction(async (tx) => {
    await tx.delete(claimsTable).where(eq(claimsTable.documentId, documentRow.id));
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      await tx.insert(claimsTable).values(rows.slice(start, start + INSERT_BATCH));
    }
  });

  return stats;
}

/** Resolves a real paper, never an eval variant that happens to share its identifier. */
export async function getDocumentId(arxivId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.arxivId, arxivId), isNull(documents.evalRunId)))
    .limit(1);
  return row?.id;
}
