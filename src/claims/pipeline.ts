import { and, eq, inArray } from 'drizzle-orm';
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
  /** Vectors reused from the cache rather than re-embedded. */
  embeddingsReused: number;
  embeddingsComputed: number;
}

/** Embedding requests per batch. Kept modest so one rejected batch costs little to retry. */
const EMBED_BATCH = 64;

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
 */
export async function extractDocumentClaims(doc: IngestedDocument): Promise<ExtractionStats> {
  const db = getDb();

  const [documentRow] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.arxivId, doc.arxivId))
    .limit(1);
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
    embeddingsReused: 0,
    embeddingsComputed: 0,
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

  // Re-running replaces prior claims rather than accumulating duplicates.
  await db.delete(claimsTable).where(eq(claimsTable.documentId, documentRow.id));
  if (pending.length === 0) return stats;

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

  stats.embeddingsComputed = needed.length;
  stats.embeddingsReused = new Set(keys.values()).size - needed.length;

  for (let start = 0; start < pending.length; start += EMBED_BATCH) {
    const batch = pending.slice(start, start + EMBED_BATCH);
    await db.insert(claimsTable).values(
      batch.map(({ sectionId, claim }, offset) => ({
        documentId: documentRow.id,
        sectionId,
        text: claim.text,
        charStart: claim.charStart,
        charEnd: claim.charEnd,
        spanResolved: claim.spanResolved,
        claimType: claim.claimType,
        subject: claim.subject,
        quantities: claim.quantities,
        embedding: vectorByKey.get(keys.get(start + offset)!)!,
        contentHash: claim.contentHash,
      })),
    );
  }

  return stats;
}

export async function getDocumentId(arxivId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.arxivId, arxivId))
    .limit(1);
  return row?.id;
}
