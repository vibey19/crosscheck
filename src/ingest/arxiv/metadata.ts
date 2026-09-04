import { arxivFetchText } from './client.js';
import { formatArxivId, type ArxivId } from './id.js';

export interface ArxivMetadata {
  id: string;
  /** Resolved concrete version — never undefined, so stored offsets stay pinned. */
  version: number;
  title: string;
  published: string;
  updated: string;
}

function firstTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1];
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Resolves title and concrete version via the legacy arXiv API.
 *
 * The API returns the entry id as a versioned abs URL, which is how a bare identifier gets pinned
 * to the revision we actually parsed.
 */
export async function fetchMetadata(target: ArxivId): Promise<ArxivMetadata> {
  const query = new URL('https://export.arxiv.org/api/query');
  query.searchParams.set('id_list', formatArxivId(target));
  query.searchParams.set('max_results', '1');

  const xml = await arxivFetchText(query.toString());

  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) throw new Error(`arXiv returned no entry for ${formatArxivId(target)}`);
  if (/<title>Error<\/title>/.test(entry)) {
    throw new Error(`arXiv reported an error for ${formatArxivId(target)}: ${firstTag(entry, 'summary')?.trim()}`);
  }

  const entryId = firstTag(entry, 'id')?.trim();
  const resolvedVersion = target.version ?? Number(/v(\d+)$/.exec(entryId ?? '')?.[1]);
  if (!Number.isInteger(resolvedVersion) || resolvedVersion < 1) {
    throw new Error(`Could not resolve a concrete version for ${formatArxivId(target)}`);
  }

  const title = firstTag(entry, 'title');
  if (!title) throw new Error(`arXiv entry for ${formatArxivId(target)} has no title`);

  return {
    id: target.id,
    version: resolvedVersion,
    title: unescapeXml(title).replace(/\s+/g, ' ').trim(),
    published: firstTag(entry, 'published')?.trim() ?? '',
    updated: firstTag(entry, 'updated')?.trim() ?? '',
  };
}
