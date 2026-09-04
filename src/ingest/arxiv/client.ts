import { getConfig } from '../../config.js';
import { meter } from '../../instrument/meter.js';
import { RateLimiter } from './rate-limiter.js';

let limiter: RateLimiter | undefined;

function getLimiter(): RateLimiter {
  limiter ??= new RateLimiter(getConfig().ARXIV_MIN_REQUEST_INTERVAL_MS);
  return limiter;
}

/**
 * The single doorway to arxiv.org. Everything is rate limited and metered; nothing else in the
 * codebase should call fetch against an arXiv host.
 */
export async function arxivFetch(url: string, accept?: string): Promise<Response> {
  const { ARXIV_USER_AGENT } = getConfig();
  return getLimiter().run(() =>
    meter.measure('arxiv.http', new URL(url).pathname, async () => {
      const response = await fetch(url, {
        headers: {
          'User-Agent': ARXIV_USER_AGENT,
          ...(accept ? { Accept: accept } : {}),
        },
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new Error(`arXiv responded ${response.status} ${response.statusText} for ${url}`);
      }
      return response;
    }),
  );
}

export async function arxivFetchBytes(url: string): Promise<Uint8Array> {
  const response = await arxivFetch(url);
  return new Uint8Array(await response.arrayBuffer());
}

export async function arxivFetchText(url: string): Promise<string> {
  return (await arxivFetch(url)).text();
}
