import type { Quantity } from '../db/schema.js';

/**
 * Deterministic numeric comparison. No model is involved in this decision — it is the part of the
 * pipeline whose verdicts are reproducible and auditable, and the reason NUMERIC is expected to be
 * the strongest conflict type in the benchmark.
 */

export interface NumericConflict {
  a: Quantity;
  b: Quantity;
  difference: number;
  relativeDifference: number;
  tolerance: number;
}

/** Unit equivalences seen across papers reporting the same measurement. */
const UNIT_ALIASES = new Map<string, string>([
  ['%', 'percent'], ['pct', 'percent'], ['percentage', 'percent'], ['accuracy', 'percent'],
  ['bleu score', 'bleu'], ['bleu points', 'bleu'],
  ['flop', 'flops'], ['petaflop/s-days', 'pf-days'],
  ['b', 'billion'], ['m', 'million'], ['k', 'thousand'],
  ['gpus', 'gpu'], ['days', 'day'], ['hours', 'hour'], ['tokens', 'token'],
  ['parameters', 'params'], ['parameter', 'params'],
]);

export function normaliseUnit(unit: string | null): string | null {
  if (!unit) return null;
  const key = unit.trim().toLowerCase();
  return UNIT_ALIASES.get(key) ?? key;
}

/**
 * Half the last significant digit of a reported number.
 *
 * "41.8" means 41.8 +/- 0.05, so two figures differing by less than the sum of their rounding
 * windows are not in conflict — they are the same measurement reported at different precision.
 */
function halfUlp(value: number): number {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) return Math.abs(value) * 1e-6;
  const decimals = text.includes('.') ? text.split('.')[1]!.length : 0;
  return 0.5 * 10 ** -decimals;
}

/**
 * Canonical form for comparing measurement labels: lowercase, punctuation stripped, common
 * synonyms folded together.
 */
function canonical(label: string): string {
  return label
    .toLowerCase()
    .replace(/english[- ]to[- ]german/g, 'ende')
    .replace(/english[- ]to[- ]french/g, 'enfr')
    .replace(/\ben[- ]?de\b/g, 'ende')
    .replace(/\ben[- ]?fr\b/g, 'enfr')
    .replace(/\bwmt\s*(?:20)?14\b/g, 'wmt14')
    .replace(/\bnewstest\s*(?:20)?13\b/g, 'newstest2013')
    .replace(/\bnewstest\s*(?:20)?14\b/g, 'newstest2014')
    .replace(/\b(development|valid|validation)\b/g, 'dev')
    .replace(/\bbase\s*model\b/g, 'base')
    .replace(/\bbig\s*model\b/g, 'big')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Canonical tokens, so wording order does not decide whether two labels match. */
function tokens(label: string): Set<string> {
  return new Set(canonical(label).split(' ').filter(Boolean));
}

function sameTokens(a: string, b: string): boolean {
  const [ta, tb] = [tokens(a), tokens(b)];
  return ta.size === tb.size && [...ta].every((token) => tb.has(token));
}

/** True when every token of the smaller label appears in the larger. */
function subsumes(a: string, b: string): boolean {
  const [ta, tb] = [tokens(a), tokens(b)];
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...small].every((token) => large.has(token));
}

/** newstest2013 is the dev set and newstest2014 the test set, so a split is often implied. */
function splitOf(dataset: string): 'dev' | 'test' | undefined {
  if (/\bdev\b|newstest2013/.test(dataset)) return 'dev';
  if (/\btest\b|newstest2014/.test(dataset)) return 'test';
  return undefined;
}

/**
 * Decides whether two quantities describe the same measurement.
 *
 * This is the precision lever for NUMERIC conflicts. Two BLEU scores are only comparable when they
 * measure the same metric, on the same system, on the same evaluation set — a base model's 25.8 on
 * the dev set and a big model's 41.8 on the EN-FR test set are both correct and not in conflict.
 * The check is deterministic over labels the extractor supplied; no model judges it.
 */
export function describesSameMeasurement(a: Quantity, b: Quantity): boolean {
  // Without a metric and a system there is not enough to establish sameness, and guessing here is
  // how a detector starts inventing contradictions.
  if (!a.metric || !b.metric || !a.system || !b.system) return false;
  if (!sameTokens(a.metric, b.metric)) return false;
  if (!sameTokens(a.system, b.system)) return false;

  // If either side names an evaluation set, both must, and they must agree. Accepting a one-sided
  // dataset reads an abstract's "28.4 BLEU" and "41.8 BLEU" as the same measurement when they are
  // EN-DE and EN-FR — a false positive, and this project is judged on those.
  if (a.dataset || b.dataset) {
    if (!a.dataset || !b.dataset) return false;
    const [da, db] = [canonical(a.dataset), canonical(b.dataset)];
    const [sa, sb] = [splitOf(da), splitOf(db)];
    // Different splits are definitively different measurements.
    if (sa && sb && sa !== sb) return false;
    // Otherwise one label must be a less specific form of the other, e.g. "wmt14 enfr" vs
    // "wmt14 enfr test", regardless of the order the words appear in.
    return subsumes(da, db);
  }

  return true;
}

/** Below this, a difference is treated as reporting noise rather than a disagreement. */
const MIN_RELATIVE_DIFFERENCE = 0.005;

/**
 * Decides whether two values disagree, assuming the caller has already established that they
 * describe the same measurement.
 *
 * Both tests must pass. Precision alone would flag 100 vs 101 in a figure reported to the nearest
 * whole number; relative difference alone would flag 0.001 vs 0.002. Requiring both keeps the
 * false-positive rate down, which is the number the project is ultimately judged on.
 *
 * Units are a guard, not a gate. Sameness is decided by `describesSameMeasurement` over the
 * metric/system/dataset labels; a metric like BLEU is unitless, so requiring a unit here would
 * silently discard exactly the conflicts this project exists to find.
 */
export function compareQuantities(a: Quantity, b: Quantity): NumericConflict | undefined {
  const unitA = normaliseUnit(a.unit);
  const unitB = normaliseUnit(b.unit);

  // Only contradictory when both are stated and disagree.
  if (unitA !== null && unitB !== null && unitA !== unitB) return undefined;
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return undefined;

  const difference = Math.abs(a.value - b.value);
  const magnitude = Math.max(Math.abs(a.value), Math.abs(b.value));
  if (magnitude === 0) return undefined;

  const tolerance = halfUlp(a.value) + halfUlp(b.value);
  const relativeDifference = difference / magnitude;

  if (difference <= tolerance) return undefined;
  if (relativeDifference < MIN_RELATIVE_DIFFERENCE) return undefined;

  return { a, b, difference, relativeDifference, tolerance };
}

/** Confidence rises with how far apart the values are, saturating at a 20% gap. */
export function conflictConfidence(conflict: NumericConflict): number {
  return Math.min(1, 0.5 + conflict.relativeDifference * 2.5);
}


/**
 * The complete deterministic NUMERIC check: same measurement, then incompatible values.
 *
 * This is the entry point detectors should use. Calling `compareQuantities` alone skips the
 * sameness test and will happily compare a dev-set score against a test-set one.
 */
export function findNumericConflict(a: Quantity, b: Quantity): NumericConflict | undefined {
  return describesSameMeasurement(a, b) ? compareQuantities(a, b) : undefined;
}
