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
 *
 * The body is buffered inside the metered region so transfer size and latency are both recorded —
 * the download dominates ingest wall-clock, and a figure nobody captured cannot be reported later.
 */
async function request(url: string): Promise<Uint8Array> {
  const { ARXIV_USER_AGENT } = getConfig();
  return getLimiter().run(() =>
    meter.measure(
      'arxiv.http',
      new URL(url).pathname,
      async () => {
        const response = await fetch(url, {
          headers: { 'User-Agent': ARXIV_USER_AGENT },
          redirect: 'follow',
        });
        if (!response.ok) {
          throw new Error(`arXiv responded ${response.status} ${response.statusText} for ${url}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      (bytes) => ({ bytes: bytes.byteLength, items: 1 }),
    ),
  );
}

export async function arxivFetchBytes(url: string): Promise<Uint8Array> {
  return request(url);
}

export async function arxivFetchText(url: string): Promise<string> {
  return new TextDecoder().decode(await request(url));
}
