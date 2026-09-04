import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { extractionCache, type Quantity } from '../db/schema.js';
import { generateStructured } from '../llm/gemini.js';
import {
  buildExtractionPrompt, EXTRACTION_SCHEMA, PROMPT_VERSION,
  type ExtractedClaim, type SectionInput,
} from './prompt.js';

export interface LocatedClaim {
  text: string;
  claimType: ExtractedClaim['claimType'];
  subject: string;
  quantities: Quantity[];
  /** Offsets into the document's normalised text; null when the quote was not found verbatim. */
  charStart: number | null;
  charEnd: number | null;
  spanResolved: boolean;
  contentHash: string;
}

export interface SectionForExtraction extends SectionInput {
  /** The section's start in the document's normalised text, so offsets come out absolute. */
  offset: number;
}

export interface BatchExtractionResult {
  claimsByPath: Map<string, LocatedClaim[]>;
  sectionsFromCache: number;
  llmCalls: number;
}

/** Sections that never contain the paper's own claims. */
const SKIP_SECTIONS = /^(references|bibliography|acknowledgements?|acknowledgments?|appendix)$/i;
const MIN_SECTION_CHARS = 200;

/**
 * Characters of section text per LLM call.
 *
 * Flash models take far more than this, but a rejected or malformed batch costs a whole request
 * from a 20-per-day allowance, so batches stay big enough to matter and small enough to redo.
 */
const BATCH_CHARS = 12_000;

export function shouldExtract(title: string, length: number): boolean {
  return length >= MIN_SECTION_CHARS && !SKIP_SECTIONS.test(title.trim());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Finds a quote in the section text.
 *
 * Exact match first. Models occasionally normalise whitespace even when told not to, so a
 * whitespace-insensitive search is tried second — it still guarantees the words are the source's
 * own. Anything looser would risk attributing a paraphrase to the author, so it is not attempted.
 */
function locate(quote: string, sectionText: string): { start: number; end: number } | undefined {
  const exact = sectionText.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  const needle = quote.trim().replace(/\s+/g, ' ');
  if (!needle) return undefined;

  const pattern = new RegExp(
    needle.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
  );
  const match = pattern.exec(sectionText);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

function locateAll(
  raw: ExtractedClaim[],
  section: SectionForExtraction,
): LocatedClaim[] {
  return raw.map((claim) => {
    const span = locate(claim.quote, section.text);
    return {
      text: claim.quote,
      claimType: claim.claimType,
      subject: claim.subject,
      quantities: (claim.quantities ?? []).map((q) => ({
        value: q.value,
        unit: q.unit ?? null,
        subject: q.subject,
        metric: q.metric ?? null,
        dataset: q.dataset ?? null,
        system: q.system ?? null,
      })),
      charStart: span ? section.offset + span.start : null,
      charEnd: span ? section.offset + span.end : null,
      spanResolved: span !== undefined,
      contentHash: sha256(claim.quote),
    };
  });
}

/** Packs sections into batches under the character budget, keeping an oversized one on its own. */
function batchSections(sections: SectionForExtraction[]): SectionForExtraction[][] {
  const batches: SectionForExtraction[][] = [];
  let current: SectionForExtraction[] = [];
  let size = 0;

  for (const section of sections) {
    if (current.length > 0 && size + section.text.length > BATCH_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(section);
    size += section.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Extracts claims for a whole document, memoised per section on content hash.
 *
 * Caching stays per-section while calls cover many sections: a section already extracted is skipped
 * even if its neighbours changed, so re-running after an edit costs only the sections that moved.
 */
export async function extractClaims(sections: SectionForExtraction[]): Promise<BatchExtractionResult> {
  const { GEMINI_MODEL } = getConfig();
  const db = getDb();

  const hashes = new Map(sections.map((section) => [section.path, sha256(section.text)]));
  const cached = await db
    .select({ contentHash: extractionCache.contentHash, claims: extractionCache.claims })
    .from(extractionCache)
    .where(
      and(
        inArray(extractionCache.contentHash, [...hashes.values()]),
        eq(extractionCache.model, GEMINI_MODEL),
        eq(extractionCache.promptVersion, PROMPT_VERSION),
      ),
    );
  const cachedByHash = new Map(cached.map((row) => [row.contentHash, row.claims as ExtractedClaim[]]));

  const claimsByPath = new Map<string, LocatedClaim[]>();
  const pending: SectionForExtraction[] = [];
  let sectionsFromCache = 0;

  for (const section of sections) {
    const hit = cachedByHash.get(hashes.get(section.path)!);
    if (hit) {
      claimsByPath.set(section.path, locateAll(hit, section));
      sectionsFromCache += 1;
    } else {
      pending.push(section);
    }
  }

  let llmCalls = 0;
  for (const batch of batchSections(pending)) {
    const raw = await generateStructured<ExtractedClaim[]>(buildExtractionPrompt(batch), {
      responseSchema: EXTRACTION_SCHEMA,
    });
    llmCalls += 1;

    const byPath = new Map<string, ExtractedClaim[]>(batch.map((section) => [section.path, []]));
    for (const claim of raw) {
      // A hallucinated section path would silently misattribute a claim, so unknown paths are dropped.
      byPath.get(claim.sectionPath)?.push(claim);
    }

    for (const section of batch) {
      const extracted = byPath.get(section.path) ?? [];
      claimsByPath.set(section.path, locateAll(extracted, section));
      await db
        .insert(extractionCache)
        .values({
          contentHash: hashes.get(section.path)!,
          model: GEMINI_MODEL,
          promptVersion: PROMPT_VERSION,
          claims: extracted,
        })
        .onConflictDoNothing();
    }
  }

  return { claimsByPath, sectionsFromCache, llmCalls };
}
