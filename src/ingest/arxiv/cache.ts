import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Transient on-disk cache for fetched e-prints.
 *
 * Two reasons this exists, and one rule about it. It keeps repeated runs from hammering an API
 * limited to one request per three seconds, and it holds the only copy of full paper text the
 * pipeline ever has. That copy is working state: gitignored, TTL'd, and never served to a client.
 * Storing it anywhere durable would breach arXiv's terms of use.
 */
const CACHE_DIR = path.resolve('data/eprints');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.bin`);
}

export async function readCache(key: string, ttlMs = DEFAULT_TTL_MS): Promise<Uint8Array | undefined> {
  const file = cachePath(key);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      await fs.rm(file, { force: true });
      return undefined;
    }
    return new Uint8Array(await fs.readFile(file));
  } catch {
    return undefined;
  }
}

export async function writeCache(key: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath(key), bytes);
}
