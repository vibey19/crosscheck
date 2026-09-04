/**
 * Text canonicalisation.
 *
 * Every stored character offset is an index into the string this module produces, so the transform
 * must be deterministic and stable. Changing it changes the meaning of every offset already in the
 * database — which is what `PARSER_VERSION` exists to catch.
 */

/** Bumped whenever normalisation or section-walking changes in a way that moves offsets. */
export const PARSER_VERSION = '2';

/** Collapses runs of spaces/tabs but preserves paragraph breaks, which carry section structure. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** LaTeX escapes and ligatures that survive into readable prose. */
const LITERALS = new Map<string, string>([
  ['%', '%'], ['$', '$'], ['&', '&'], ['#', '#'], ['_', '_'],
  ['{', '{'], ['}', '}'], ['~', ' '],
  ['ldots', '…'], ['dots', '…'], ['textbackslash', '\\'],
  ['times', '×'], ['pm', '±'], ['approx', '≈'], ['leq', '≤'], ['geq', '≥'],
  ['ll', '≪'], ['gg', '≫'], ['sim', '~'], ['rightarrow', '→'], ['to', '→'],
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
  ['lambda', 'λ'], ['mu', 'μ'], ['sigma', 'σ'], ['tau', 'τ'], ['theta', 'θ'],
  ['cdot', '·'], ['%', '%'],
]);

export function literalFor(macroName: string): string | undefined {
  return LITERALS.get(macroName);
}
