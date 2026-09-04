import { createHash } from 'node:crypto';
import { fetchEprintSource } from './arxiv/eprint.js';
import { formatArxivId, parseArxivId, absUrl } from './arxiv/id.js';
import { fetchMetadata } from './arxiv/metadata.js';
import { expandIncludes, findMainTex } from './latex/resolve.js';
import { parseLatex, type ParsedSection } from './latex/parse.js';

export interface IngestedDocument {
  arxivId: string;
  version: number;
  idWithVersion: string;
  title: string;
  url: string;
  mainTexFile: string;
  parserVersion: string;
  contentHash: string;
  /** Normalised text. In-memory only for the caller's use — never persisted. See CLAUDE.md. */
  text: string;
  sections: ParsedSection[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Fetches one arXiv paper and parses it into a section tree with character offsets.
 *
 * Order matters: metadata first, because it resolves a bare identifier to a concrete version, and
 * only a versioned e-print is immutable enough for stored offsets to stay valid.
 */
export async function ingestDocument(rawId: string): Promise<IngestedDocument> {
  const target = parseArxivId(rawId);
  const metadata = await fetchMetadata(target);
  const idWithVersion = formatArxivId({ id: metadata.id, version: metadata.version });

  const source = await fetchEprintSource(idWithVersion);
  if (source.pdfOnly) {
    throw new Error(
      `${idWithVersion} was submitted as PDF only; LaTeX ingest is not possible. ` +
        'PDF fallback is out of scope for Phase 0.',
    );
  }

  const main = findMainTex(source.files);
  const expanded = expandIncludes(main.content, source.files);
  const parsed = parseLatex(expanded);

  if (parsed.sections.length === 0) {
    throw new Error(`Parsed ${idWithVersion} but found no sections; the LaTeX layout is unusual.`);
  }

  return {
    arxivId: metadata.id,
    version: metadata.version,
    idWithVersion,
    title: metadata.title,
    url: absUrl(idWithVersion),
    mainTexFile: main.name,
    parserVersion: parsed.parserVersion,
    contentHash: sha256(parsed.text),
    text: parsed.text,
    sections: parsed.sections,
  };
}

export function sectionText(doc: IngestedDocument, section: ParsedSection): string {
  return doc.text.slice(section.charStart, section.charEnd);
}

export function sectionHash(doc: IngestedDocument, section: ParsedSection): string {
  return sha256(sectionText(doc, section));
}
