/**
 * arXiv identifiers come in two shapes: the modern `2301.12345` and the pre-2007 `math/0309136`.
 * Either may carry an explicit `vN` suffix.
 *
 * Version matters more here than it looks. Character offsets are only reproducible against an
 * immutable source, and only a *versioned* arXiv identifier is immutable — a bare id silently
 * follows the latest revision. Every stored document therefore pins a resolved version.
 */
export interface ArxivId {
  /** Identifier without any version suffix, e.g. `2301.12345`. */
  id: string;
  /** Explicit version if the caller supplied one, else undefined (resolve from metadata). */
  version?: number;
}

const MODERN = /^(\d{4}\.\d{4,5})(?:v(\d+))?$/;
const LEGACY = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?$/;

export function parseArxivId(raw: string): ArxivId {
  const input = raw
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf|e-print)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:/i, '');

  const match = MODERN.exec(input) ?? LEGACY.exec(input);
  if (!match) {
    throw new Error(
      `Not a recognisable arXiv id: "${raw}". Expected e.g. 2301.12345, 2301.12345v2, or math/0309136.`,
    );
  }
  const [, id, version] = match;
  return version === undefined ? { id: id! } : { id: id!, version: Number(version) };
}

/** Canonical `2301.12345v2` form, used for cache keys and the arXiv link in reports. */
export function formatArxivId({ id, version }: ArxivId): string {
  return version === undefined ? id : `${id}v${version}`;
}

export function absUrl(idWithVersion: string): string {
  return `https://arxiv.org/abs/${idWithVersion}`;
}
