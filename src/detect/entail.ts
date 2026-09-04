import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { classificationCache, CONFLICT_TYPES } from '../db/schema.js';
import { generateStructured } from '../llm/gemini.js';

/**
 * Stage 5 — entailment classification.
 *
 * Turns candidate pairs into verdicts. Deliberately conservative: a pair is only CONTRADICTS when
 * the conflict fits one of the four objectively checkable types, and everything else that merely
 * looks uncomfortable is TENSION. Widening this is how a contradiction detector starts inventing
 * disagreements.
 */

export const ENTAILMENT_PROMPT_VERSION = '1';

/** Pairs classified per call. Large enough to respect a 20-request daily cap, small enough to redo. */
export const CLASSIFY_BATCH = 20;

export type Verdict = 'CONTRADICTS' | 'ENTAILS' | 'NEUTRAL' | 'TENSION';

export interface PairForClassification {
  index: number;
  a: { text: string; subject: string; section: string };
  b: { text: string; subject: string; section: string };
}

export interface Classification {
  index: number;
  verdict: Verdict;
  conflictType: (typeof CONFLICT_TYPES)[number] | null;
  confidence: number;
  rationale: string;
  /** Set when the two claims are not actually about the same thing — the dominant failure mode. */
  sameSubject: boolean;
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      index: { type: 'INTEGER' },
      sameSubject: { type: 'BOOLEAN' },
      verdict: { type: 'STRING', enum: ['CONTRADICTS', 'ENTAILS', 'NEUTRAL', 'TENSION'] },
      conflictType: { type: 'STRING', enum: [...CONFLICT_TYPES] },
      confidence: { type: 'NUMBER' },
      rationale: { type: 'STRING' },
    },
    required: ['index', 'sameSubject', 'verdict', 'confidence', 'rationale'],
  },
} as const;

function buildPrompt(pairs: PairForClassification[]): string {
  const body = pairs
    .map(
      (pair) =>
        `### Pair ${pair.index}\n` +
        `A [${pair.a.section}] subject: ${pair.a.subject}\n  "${pair.a.text}"\n` +
        `B [${pair.b.section}] subject: ${pair.b.subject}\n  "${pair.b.text}"`,
    )
    .join('\n\n');

  return `You judge whether pairs of claims from scientific papers actually contradict each other.

For each pair, first decide "sameSubject": do A and B describe the SAME thing — the same measurement
on the same system and same evaluation set, or the same effect on the same quantity? Two numbers
about different models, different tasks, different datasets, or different data splits are NOT the
same subject, even when the sentences look alike. Rows of one table are usually different subjects.

If sameSubject is false, verdict is NEUTRAL. Do not reason further about it.

If sameSubject is true, choose a verdict:
- CONTRADICTS — they cannot both be true, AND the conflict is one of these four types:
    NUMERIC       same quantity, incompatible values
    DIRECTION     X improves Y versus X degrades Y
    SCOPE         a universal claim versus a conditional one on the same subject
    DEFINITIONAL  the same term given incompatible definitions
  Set "conflictType" to whichever applies.
- TENSION — they sit uneasily together but the conflict is not one of those four types, or the
  disagreement could be explained by context the text does not settle.
- ENTAILS — one follows from the other.
- NEUTRAL — unrelated, or compatible.

Be conservative. A false contradiction is far more costly here than a missed one. If two claims
could both be true under any reasonable reading, they do not contradict.

"confidence" is 0 to 1. "rationale" is one sentence, citing what makes them the same or different
subject.

Return one object per pair, echoing its index.

${body}`;
}

/** Identifies a pair by its content, so the same two claims reuse a verdict across runs. */
function pairHash(pair: PairForClassification): string {
  return createHash('sha256').update(`${pair.a.text}\u0000${pair.b.text}`).digest('hex');
}

function normalise(pair: PairForClassification, row: Partial<Classification> | undefined): Classification {
  // A pair the model skipped is treated as undecided, never as a contradiction.
  if (!row) {
    return {
      index: pair.index, verdict: 'NEUTRAL', conflictType: null,
      confidence: 0, rationale: 'Not classified.', sameSubject: false,
    };
  }
  return {
    index: pair.index,
    verdict: row.sameSubject ? (row.verdict ?? 'NEUTRAL') : 'NEUTRAL',
    conflictType: row.conflictType ?? null,
    confidence: Number(row.confidence) || 0,
    rationale: row.rationale ?? '',
    sameSubject: Boolean(row.sameSubject),
  };
}

/**
 * Classifies a batch of pairs, reusing cached verdicts.
 *
 * Makes one LLM call for the uncached remainder, or none if every pair is already known.
 */
export async function classifyBatch(pairs: PairForClassification[]): Promise<Classification[]> {
  if (pairs.length === 0) return [];
  const { GEMINI_MODEL } = getConfig();
  const db = getDb();

  const hashes = new Map(pairs.map((pair) => [pair.index, pairHash(pair)]));
  const cached = await db
    .select({ contentHash: classificationCache.contentHash, result: classificationCache.result })
    .from(classificationCache)
    .where(
      and(
        inArray(classificationCache.contentHash, [...hashes.values()]),
        eq(classificationCache.model, GEMINI_MODEL),
        eq(classificationCache.promptVersion, ENTAILMENT_PROMPT_VERSION),
      ),
    );
  const byHash = new Map(cached.map((row) => [row.contentHash, row.result as Partial<Classification>]));

  const missing = pairs.filter((pair) => !byHash.has(hashes.get(pair.index)!));

  if (missing.length > 0) {
    const raw = await generateStructured<Partial<Classification>[]>(buildPrompt(missing), {
      responseSchema: SCHEMA,
    });
    const byIndex = new Map(raw.map((row) => [row.index, row]));

    for (const pair of missing) {
      const row = byIndex.get(pair.index);
      if (!row) continue;
      byHash.set(hashes.get(pair.index)!, row);
      await db
        .insert(classificationCache)
        .values({
          contentHash: hashes.get(pair.index)!,
          model: GEMINI_MODEL,
          promptVersion: ENTAILMENT_PROMPT_VERSION,
          result: row,
        })
        .onConflictDoNothing();
    }
  }

  return pairs.map((pair) => normalise(pair, byHash.get(hashes.get(pair.index)!)));
}

/** True when every pair already has a cached verdict, so classification costs nothing. */
export async function classificationsCached(pairs: PairForClassification[]): Promise<boolean> {
  if (pairs.length === 0) return true;
  const { GEMINI_MODEL } = getConfig();
  const hashes = pairs.map((pair) => pairHash(pair));
  const rows = await getDb()
    .select({ contentHash: classificationCache.contentHash })
    .from(classificationCache)
    .where(
      and(
        inArray(classificationCache.contentHash, hashes),
        eq(classificationCache.model, GEMINI_MODEL),
        eq(classificationCache.promptVersion, ENTAILMENT_PROMPT_VERSION),
      ),
    );
  return rows.length === new Set(hashes).size;
}
