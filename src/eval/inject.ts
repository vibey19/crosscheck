import type { ParsedSection } from '../ingest/latex/parse.js';

/**
 * Controlled mutation of clean papers, to produce exact labels.
 *
 * The whole evaluation rests on knowing precisely what was broken and where. Two properties are
 * therefore non-negotiable here:
 *
 * 1. Site selection must not use the detector's own notion of what counts as the same measurement.
 *    Picking sites with `describesSameMeasurement` would only ever inject where the detector can
 *    already match, and the resulting recall figure would be circular. Selection is done on the
 *    surface text alone.
 * 2. Replacements preserve character length, so every other offset in the document stays valid and
 *    a mutated variant is directly comparable to the clean one.
 */

export type MutationType = 'NUMERIC' | 'DIRECTION' | 'SCOPE' | 'DEFINITIONAL';

export interface Mutation {
  type: MutationType;
  /** Offsets into the document's normalised text, in the CLEAN document. */
  charStart: number;
  charEnd: number;
  originalText: string;
  mutatedText: string;
  /** Where the contradicting counterpart sits, which is what makes this a known conflict. */
  counterpartStart: number;
  counterpartEnd: number;
  sectionPath: string;
  counterpartSectionPath: string;
  note: string;
}

export interface MutationResult {
  text: string;
  mutation: Mutation;
}

/**
 * Decimal literals with a fractional part.
 *
 * Integers collide constantly in a paper — 512 is a hidden size, a batch size and a page count —
 * so mutating one occurrence of an integer often creates no contradiction at all and would pollute
 * the labels. A repeated decimal is very likely the same reported measurement.
 */
const DECIMAL = /(?<![\w.])(\d{1,4}\.\d{1,3})(?![\w.])/g;

function sectionAt(sections: ParsedSection[], offset: number): ParsedSection | undefined {
  return sections.find((section) => offset >= section.charStart && offset < section.charEnd);
}

/** Words that say nothing about what is being measured. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'to', 'is', 'are', 'was', 'were',
  'we', 'our', 'with', 'by', 'from', 'this', 'that', 'it', 'as', 'than', 'then', 'both', 'all',
  'used', 'using', 'use', 'set', 'value', 'values', 'has', 'have', 'be', 'been', 'which', 'while',
]);

/**
 * The unit or metric word a figure is stated with.
 *
 * A repeated decimal alone is a bad signal: beta_1=0.9 and "0.9 BLEU worse" share a literal and
 * measure nothing alike, and mutating one produces no contradiction at all. Requiring the two
 * mentions to be stated with the same word — "3.5 days" and "3.5 days" — keeps the pattern this
 * project targets while discarding coincidental collisions.
 *
 * This reads the surface text only. It deliberately does not consult the extractor's labels or
 * `describesSameMeasurement`, since selecting sites with the detector's own notion of sameness
 * would make the resulting recall figure circular.
 */
function contextSignature(text: string, start: number, end: number): string | undefined {
  const after = text.slice(end, end + 30);
  const trailing = /^[\s%]*([A-Za-z][A-Za-z-]{1,})/.exec(after)?.[1]?.toLowerCase();
  if (trailing && !STOPWORDS.has(trailing)) return trailing;

  const before = text.slice(Math.max(0, start - 40), start);
  const words = before.toLowerCase().match(/[a-z][a-z-]{1,}/g) ?? [];
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!;
    if (!STOPWORDS.has(word)) return word;
  }
  return undefined;
}

/**
 * Produces a replacement that differs beyond any rounding tolerance while keeping the same number
 * of characters, so offsets elsewhere in the document are unaffected.
 */
function perturbSameLength(literal: string): string | undefined {
  const [whole = '', fraction = ''] = literal.split('.');
  const value = Number(literal);
  if (!Number.isFinite(value)) return undefined;

  // Try a set of shifts, largest first, and keep the first that renders to the same width.
  for (const factor of [1.12, 0.88, 1.2, 0.8, 1.35, 0.65]) {
    const candidate = (value * factor).toFixed(fraction.length);
    if (candidate.length === literal.length && candidate !== literal) {
      // Guard against a shift that rounds back inside the tolerance the detector allows.
      const relative = Math.abs(Number(candidate) - value) / Math.max(Math.abs(value), 1e-9);
      if (relative > 0.02) return candidate;
    }
  }

  // Fall back to editing the leading digit, which always preserves width.
  const digits = whole.replace(/\D/g, '');
  const lead = digits[0];
  if (!lead) return undefined;
  const replacement = lead === '9' ? '4' : String(Number(lead) + 5 > 9 ? Number(lead) - 4 : Number(lead) + 5);
  const mutated = `${replacement}${whole.slice(1)}.${fraction}`;
  return mutated === literal ? undefined : mutated;
}

/**
 * Finds decimals stated identically in two different sections and changes one of them.
 *
 * Repeating a figure across sections is exactly the abstract-versus-table pattern this project
 * exists to catch, so a single edit turns a consistent paper into one with a known inconsistency
 * at a known offset.
 */
export function planNumericMutations(text: string, sections: ParsedSection[]): Mutation[] {
  const occurrences = new Map<
    string,
    { start: number; end: number; section: ParsedSection; signature: string }[]
  >();

  for (const match of text.matchAll(DECIMAL)) {
    const literal = match[1]!;
    const start = match.index! + match[0].indexOf(literal);
    const end = start + literal.length;
    const section = sectionAt(sections, start);
    if (!section) continue;
    const signature = contextSignature(text, start, end);
    if (!signature) continue;
    const list = occurrences.get(literal) ?? [];
    list.push({ start, end, section, signature });
    occurrences.set(literal, list);
  }

  const mutations: Mutation[] = [];

  for (const [literal, sites] of occurrences) {
    // Group by the word the figure is stated with, so only mentions of the same thing pair up.
    const bySignature = new Map<string, typeof sites>();
    for (const site of sites) {
      bySignature.set(site.signature, [...(bySignature.get(site.signature) ?? []), site]);
    }

    let target: (typeof sites)[number] | undefined;
    let counterpart: (typeof sites)[number] | undefined;
    for (const group of bySignature.values()) {
      // Needs two mentions in *different* sections; a figure repeated within one table row is the
      // same cell being described, not an independent restatement.
      const bySection = new Map<string, (typeof sites)[number]>();
      for (const site of group) {
        if (!bySection.has(site.section.path)) bySection.set(site.section.path, site);
      }
      if (bySection.size >= 2) {
        [target, counterpart] = [...bySection.values()];
        break;
      }
    }
    if (!target || !counterpart) continue;

    const mutated = perturbSameLength(literal);
    if (!mutated) continue;

    mutations.push({
      type: 'NUMERIC',
      charStart: target.start,
      charEnd: target.end,
      originalText: literal,
      mutatedText: mutated,
      counterpartStart: counterpart.start,
      counterpartEnd: counterpart.end,
      sectionPath: target.section.path,
      counterpartSectionPath: counterpart.section.path,
      note:
        `"${literal} ${target.signature}" appears in "${target.section.path}" and ` +
        `"${counterpart.section.path}"; the first is changed to ${mutated}.`,
    });
  }

  return mutations;
}

/** Applies one mutation, returning the altered text. Length is preserved, so offsets still hold. */
export function applyMutation(text: string, mutation: Mutation): string {
  const before = text.slice(0, mutation.charStart);
  const after = text.slice(mutation.charEnd);
  const actual = text.slice(mutation.charStart, mutation.charEnd);
  if (actual !== mutation.originalText) {
    throw new Error(
      `Mutation site moved: expected "${mutation.originalText}" at ${mutation.charStart}, found "${actual}".`,
    );
  }
  return `${before}${mutation.mutatedText}${after}`;
}

/** Deterministic sample, so a benchmark run is reproducible from its seed. */
export function sampleMutations(mutations: Mutation[], count: number, seed: number): Mutation[] {
  // xorshift keeps this dependency-free and identical across machines.
  let state = seed || 1;
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return Math.abs(state) / 2 ** 31;
  };
  const pool = [...mutations];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}
