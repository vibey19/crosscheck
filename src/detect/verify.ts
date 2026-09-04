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

/** Verifies one batch. Makes exactly one LLM call. */
export async function verifyBatch(findings: FindingForVerification[]): Promise<Verification[]> {
  if (findings.length === 0) return [];
  const raw = await generateStructured<RawVerification[]>(buildPrompt(findings), { responseSchema: SCHEMA });

  const byIndex = new Map(raw.map((row) => [row.index, row]));
  return findings.map((finding): Verification => {
    const row = byIndex.get(finding.index);
    // Unverified is not verified. A finding the verifier skipped does not get the benefit of doubt.
    if (!row) {
      return { index: finding.index, passed: false, objection: 'Not verified.', quotedSpans: [] };
    }

    const spans = [row.spanFromA, row.spanFromB].filter((s): s is string => Boolean(s?.trim()));
    // Both spans must be quotable, and they must genuinely come from the claims — a span the model
    // invented would let a fabricated finding through the one gate meant to stop it.
    const quotesCheckOut =
      spans.length === 2 &&
      finding.a.text.includes(spans[0]!.trim()) &&
      finding.b.text.includes(spans[1]!.trim());

    return {
      index: finding.index,
      passed: row.objectionSucceeds === false && quotesCheckOut,
      objection: row.strongestObjection ?? '',
      quotedSpans: quotesCheckOut ? spans : [],
    };
  });
}
