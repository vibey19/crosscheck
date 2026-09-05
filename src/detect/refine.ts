import { classifyBatch, CLASSIFY_BATCH, type Classification, type PairForClassification } from './entail.js';
import { verifyBatch, VERIFY_BATCH, type FindingForVerification, type Verification } from './verify.js';

/**
 * Applies stages 5 and 6 to candidate findings.
 *
 * Both stages are independently switchable. The verifier-on versus verifier-off comparison over the
 * same candidates is the project's headline result, so it has to be a runtime option rather than a
 * code change — otherwise the two arms of the ablation are not the same program.
 */

export interface RefineOptions {
  /** Stage 5. Off means every candidate is treated as CONTRADICTS. */
  classify: boolean;
  /** Stage 6. Off means no finding is dropped for failing to be defended. */
  verify: boolean;
  /**
   * Set when the conflict itself was already established deterministically, as the NUMERIC
   * arithmetic check does. Stage 5 is then consulted only for `sameSubject` and its verdict label
   * is ignored.
   *
   * Measured reason: the verdict is unstable where the deterministic check is not. Given the same
   * pair and prompt, gemini-3.7-flash returned CONTRADICTS (0.95) and gemini-3.6-flash returned
   * TENSION (0.85) with materially the same rationale — "41.0 versus 41.8". `sameSubject`, by
   * contrast, was right every time: it rejected all 116 false positives on 2203.15556 and accepted
   * the true one on 1706.03762. Asking a model to re-derive arithmetic it cannot do better than
   * arithmetic costs recall and buys nothing.
   */
  deterministicConflict?: boolean;
}

export interface RefinableFinding {
  conflictType: string;
  rationale: string;
  confidence: number;
  a: { text: string; subject: string; sectionPath: string };
  b: { text: string; subject: string; sectionPath: string };
}

export interface RefinedFinding<T extends RefinableFinding> {
  finding: T;
  verdict: string;
  /** Null when stage 5 was disabled. */
  classification: Classification | null;
  /** Null when stage 6 was disabled — distinct from false, which means it was tried and failed. */
  verification: Verification | null;
  reported: boolean;
}

export interface RefineStats {
  candidates: number;
  classifierCalls: number;
  verifierCalls: number;
  /** Dropped by stage 5 for not being about the same subject. */
  rejectedDifferentSubject: number;
  /** Dropped by stage 5 as tension, entailment or neutrality rather than contradiction. */
  rejectedNotContradiction: number;
  /** Dropped by stage 6 because the contradiction could not be defended with quoted spans. */
  rejectedByVerifier: number;
  /** Breakdown of stage-6 rejections, so a drop can be diagnosed rather than guessed at. */
  verifierRejectionReasons: Record<string, number>;
  reported: number;
}

export async function refineFindings<T extends RefinableFinding>(
  findings: T[],
  options: RefineOptions,
): Promise<{ results: RefinedFinding<T>[]; stats: RefineStats }> {
  const stats: RefineStats = {
    candidates: findings.length,
    classifierCalls: 0,
    verifierCalls: 0,
    rejectedDifferentSubject: 0,
    rejectedNotContradiction: 0,
    rejectedByVerifier: 0,
    verifierRejectionReasons: {},
    reported: 0,
  };

  const classifications = new Map<number, Classification>();
  if (options.classify) {
    const pairs: PairForClassification[] = findings.map((finding, index) => ({
      index,
      a: { text: finding.a.text, subject: finding.a.subject, section: finding.a.sectionPath },
      b: { text: finding.b.text, subject: finding.b.subject, section: finding.b.sectionPath },
    }));

    for (let start = 0; start < pairs.length; start += CLASSIFY_BATCH) {
      const batch = await classifyBatch(pairs.slice(start, start + CLASSIFY_BATCH));
      stats.classifierCalls += 1;
      for (const row of batch) classifications.set(row.index, row);
    }
  }

  // Only what stage 5 called a contradiction reaches stage 6.
  const surviving: number[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    if (!options.classify) {
      surviving.push(index);
      continue;
    }
    const classification = classifications.get(index);
    if (!classification) {
      stats.rejectedNotContradiction += 1;
      continue;
    }
    if (!classification.sameSubject) {
      stats.rejectedDifferentSubject += 1;
      continue;
    }
    // Where the conflict is already proven, same-subject is the only question stage 5 answers.
    if (!options.deterministicConflict && classification.verdict !== 'CONTRADICTS') {
      stats.rejectedNotContradiction += 1;
      continue;
    }
    surviving.push(index);
  }

  const verifications = new Map<number, Verification>();
  if (options.verify && surviving.length > 0) {
    const queue: FindingForVerification[] = surviving.map((index) => {
      const finding = findings[index]!;
      return {
        index,
        conflictType: finding.conflictType,
        rationale: finding.rationale,
        a: { text: finding.a.text, section: finding.a.sectionPath },
        b: { text: finding.b.text, section: finding.b.sectionPath },
      };
    });

    for (let start = 0; start < queue.length; start += VERIFY_BATCH) {
      const batch = await verifyBatch(queue.slice(start, start + VERIFY_BATCH));
      stats.verifierCalls += 1;
      for (const row of batch) verifications.set(row.index, row);
    }
  }

  const results: RefinedFinding<T>[] = [];
  for (const index of surviving) {
    const verification = options.verify ? verifications.get(index) ?? null : null;
    const reported = !options.verify || verification?.passed === true;
    if (!reported) {
      stats.rejectedByVerifier += 1;
      const reason = verification?.rejectionReason ?? 'unknown';
      stats.verifierRejectionReasons[reason] = (stats.verifierRejectionReasons[reason] ?? 0) + 1;
    } else stats.reported += 1;

    results.push({
      finding: findings[index]!,
      verdict: 'CONTRADICTS',
      classification: classifications.get(index) ?? null,
      verification,
      reported,
    });
  }

  return { results, stats };
}
