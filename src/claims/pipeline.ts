import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { claims as claimsTable, documents, sections as sectionsTable } from '../db/schema.js';
import { embedTexts } from '../llm/gemini.js';
import type { IngestedDocument } from '../ingest/pipeline.js';
import { sectionText } from '../ingest/pipeline.js';
import { extractClaims, shouldExtract, type LocatedClaim, type SectionForExtraction } from './extract.js';

export interface ExtractionStats {
  sectionsConsidered: number;
  sectionsFromCache: number;
  /** Generate calls actually spent — the figure the 20-per-day free-tier cap applies to. */
  llmCalls: number;
  claims: number;
  spansResolved: number;
  byType: Record<string, number>;
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

  for (let start = 0; start < pending.length; start += EMBED_BATCH) {
    const batch = pending.slice(start, start + EMBED_BATCH);
    const vectors = await embedTexts(batch.map(({ claim }) => embeddingText(claim)));

    await db.insert(claimsTable).values(
      batch.map(({ sectionId, claim }, index) => ({
        documentId: documentRow.id,
        sectionId,
        text: claim.text,
        charStart: claim.charStart,
        charEnd: claim.charEnd,
        spanResolved: claim.spanResolved,
        claimType: claim.claimType,
        subject: claim.subject,
        quantities: claim.quantities,
        embedding: vectors[index]!,
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
