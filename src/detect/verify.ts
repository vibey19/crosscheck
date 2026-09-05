import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { verificationCache } from '../db/schema.js';
import { generateStructured } from '../llm/gemini.js';

/**
 * Stage 6 — adversarial verification.
 *
 * The precision lever. Every surviving CONTRADICTS is handed to a second pass whose job is to argue
 * the finding is wrong, and which must quote the exact spans that establish the conflict. A finding
 * that cannot be defended with the source's own words is dropped.
 *
 * This stage must stay independently switchable: the with/without ablation is the project's headline
 * result, so nothing here may become load-bearing for the rest of the pipeline.
 */

export const VERIFIER_PROMPT_VERSION = '1';

/** Findings verified per call. */
export const VERIFY_BATCH = 10;

export interface FindingForVerification {
  index: number;
  conflictType: string;
  rationale: string;
  a: { text: string; section: string };
  b: { text: string; section: string };
}

export interface Verification {
  index: number;
  /** True only when the contradiction survived an attempt to refute it. */
  passed: boolean;
  /** The verifier's best argument that the finding is wrong. */
  objection: string;
  /** Spans it could quote to establish the conflict; empty means it could not. */
  quotedSpans: string[];
  /**
   * Why the finding was dropped, when it was. Without this a rejection is indistinguishable from
   * a bug, and stage 6 is the stage that decides what gets reported.
   */
  rejectionReason: 'objection-succeeded' | 'span-not-quoted' | 'span-not-found' | 'not-returned' | null;
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      index: { type: 'INTEGER' },
      strongestObjection: { type: 'STRING' },
      objectionSucceeds: { type: 'BOOLEAN' },
      spanFromA: { type: 'STRING' },
      spanFromB: { type: 'STRING' },
    },
    required: ['index', 'strongestObjection', 'objectionSucceeds'],
  },
} as const;

function buildPrompt(findings: FindingForVerification[]): string {
  const body = findings
    .map(
      (f) =>
        `### Finding ${f.index} — reported as ${f.conflictType}\n` +
        `Claimed conflict: ${f.rationale}\n` +
        `A [${f.a.section}]: "${f.a.text}"\n` +
        `B [${f.b.section}]: "${f.b.text}"`,
    )
    .join('\n\n');

  return `You are reviewing reported contradictions in scientific papers. Your job is to DISPROVE
each one. Assume it is wrong and find the reason.

For each finding, give the strongest objection you can. The most common reasons a reported
contradiction is not real:
- A and B measure different things: different model, task, dataset, or data split.
- They are different rows or columns of one table, which are supposed to differ.
- One is about prior work, the other about this paper's work.
- One is a subset, average, or aggregate of the other.
- The values agree once rounding or stated precision is accounted for.
- Different conditions, hyperparameters, or training budgets apply.

Then set "objectionSucceeds":
- true  — your objection holds, so the reported contradiction is NOT real.
- false — you tried and the contradiction stands.

If and only if objectionSucceeds is false, you must also quote the exact span from each claim that
establishes the conflict, copied verbatim from the text given, in "spanFromA" and "spanFromB". If
you cannot quote both, the finding is not supported: set objectionSucceeds to true instead.

Return one object per finding, echoing its index.

${body}`;
}

interface RawVerification {
  index: number;
  strongestObjection?: string;
  objectionSucceeds?: boolean;
  spanFromA?: string;
  spanFromB?: string;
}

/** Whitespace-insensitive containment, so a reflowed quote is not mistaken for an invented one. */
function containsSpan(haystack: string, span: string): boolean {
  const normalise = (value: string) => value.replace(/\s+/g, ' ').trim();
  return normalise(haystack).includes(normalise(span));
}

function adjudicate(finding: FindingForVerification, row: RawVerification | undefined): Verification {
  // Unverified is not verified. A finding the verifier skipped does not get the benefit of doubt.
  if (!row) {
    return {
      index: finding.index, passed: false, objection: 'Not returned by the verifier.',
      quotedSpans: [], rejectionReason: 'not-returned',
    };
  }

  const objection = row.strongestObjection ?? '';
  if (row.objectionSucceeds !== false) {
    return { index: finding.index, passed: false, objection, quotedSpans: [], rejectionReason: 'objection-succeeded' };
  }

  const spans = [row.spanFromA, row.spanFromB].filter((s): s is string => Boolean(s?.trim()));
  if (spans.length !== 2) {
    return { index: finding.index, passed: false, objection, quotedSpans: [], rejectionReason: 'span-not-quoted' };
  }

  // Spans must genuinely come from the claims — an invented quote would let a fabricated finding
  // through the one gate meant to stop it.
  if (!containsSpan(finding.a.text, spans[0]!) || !containsSpan(finding.b.text, spans[1]!)) {
    return { index: finding.index, passed: false, objection, quotedSpans: spans, rejectionReason: 'span-not-found' };
  }

  return { index: finding.index, passed: true, objection, quotedSpans: spans, rejectionReason: null };
}

function findingHash(finding: FindingForVerification): string {
  return createHash('sha256').update(`${finding.a.text}\u0000${finding.b.text}`).digest('hex');
}

/** Verifies a batch, reusing cached results. Makes at most one LLM call. */
export async function verifyBatch(findings: FindingForVerification[]): Promise<Verification[]> {
  if (findings.length === 0) return [];
  const { GEMINI_MODEL } = getConfig();
  const db = getDb();

  const hashes = new Map(findings.map((f) => [f.index, findingHash(f)]));
  const cached = await db
    .select({ contentHash: verificationCache.contentHash, result: verificationCache.result })
    .from(verificationCache)
    .where(
      and(
        inArray(verificationCache.contentHash, [...hashes.values()]),
        eq(verificationCache.model, GEMINI_MODEL),
        eq(verificationCache.promptVersion, VERIFIER_PROMPT_VERSION),
      ),
    );
  const byHash = new Map(cached.map((row) => [row.contentHash, row.result as RawVerification]));

  const missing = findings.filter((f) => !byHash.has(hashes.get(f.index)!));

  if (missing.length > 0) {
    const raw = await generateStructured<RawVerification[]>(buildPrompt(missing), { responseSchema: SCHEMA });
    const byIndex = new Map(raw.map((row) => [row.index, row]));
    for (const finding of missing) {
      const row = byIndex.get(finding.index);
      if (!row) continue;
      byHash.set(hashes.get(finding.index)!, row);
      await db
        .insert(verificationCache)
        .values({
          contentHash: hashes.get(finding.index)!,
          model: GEMINI_MODEL,
          promptVersion: VERIFIER_PROMPT_VERSION,
          result: row,
        })
        .onConflictDoNothing();
    }
  }

  return findings.map((finding) => adjudicate(finding, byHash.get(hashes.get(finding.index)!)));
}
