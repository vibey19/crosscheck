import { gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { extract } from 'tar-stream';
import { arxivFetchBytes } from './client.js';
import { readCache, writeCache } from './cache.js';

export interface EprintSource {
  /** Relative path within the tarball to file contents. Empty when `pdfOnly` is true. */
  files: Map<string, string>;
  /** Some submissions ship only a PDF; LaTeX ingest cannot proceed and Phase 0 stops here. */
  pdfOnly: boolean;
}

const GZIP_MAGIC = [0x1f, 0x8b];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

/** A POSIX tar header carries "ustar" at offset 257. */
function isTar(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(257, 262)).toString('latin1').startsWith('ustar');
}

function isTextual(name: string): boolean {
  return /\.(tex|bbl|cls|sty|txt)$/i.test(name);
}

async function untar(bytes: Uint8Array): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const extractor = extract();

  const done = new Promise<void>((resolve, reject) => {
    extractor.on('entry', (header, stream, next) => {
      if (header.type !== 'file' || !isTextual(header.name)) {
        stream.on('end', next);
        stream.resume();
        return;
      }
      const parts: Buffer[] = [];
      stream.on('data', (chunk: unknown) => parts.push(chunk as Buffer));
      stream.on('end', () => {
        files.set(header.name, Buffer.concat(parts).toString('utf8'));
        next();
      });
      stream.on('error', reject);
    });
    extractor.on('finish', () => resolve());
    extractor.on('error', reject);
  });

  extractor.end(Buffer.from(bytes));
  await done;
  return files;
}

/**
 * Fetches an e-print and returns its text files.
 *
 * arXiv serves three shapes from this endpoint and does not reliably distinguish them by content
 * type, so they are sniffed by magic bytes: a gzipped tarball (the common case), a bare gzipped
 * single `.tex`, or a PDF for PDF-only submissions.
 */
export async function fetchEprintSource(idWithVersion: string): Promise<EprintSource> {
  const cacheKey = `e-print:${idWithVersion}`;
  let bytes = await readCache(cacheKey);
  if (!bytes) {
    bytes = await arxivFetchBytes(`https://arxiv.org/e-print/${idWithVersion}`);
    await writeCache(cacheKey, bytes);
  }

  if (startsWith(bytes, PDF_MAGIC)) return { files: new Map(), pdfOnly: true };

  let body = bytes;
  if (startsWith(bytes, GZIP_MAGIC)) body = new Uint8Array(gunzipSync(Buffer.from(bytes)));

  if (startsWith(body, PDF_MAGIC)) return { files: new Map(), pdfOnly: true };

  if (isTar(body)) return { files: await untar(body), pdfOnly: false };

  // A single uncompressed .tex, the remaining legal shape.
  const text = Buffer.from(body).toString('utf8');
  return { files: new Map([['main.tex', text]]), pdfOnly: false };
}
