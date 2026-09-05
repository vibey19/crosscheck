import { createHash } from 'node:crypto';
import { isNotNull } from 'drizzle-orm';
import { getConfig } from '../config.js';
import { closeDb, getDb } from './client.js';
import { claims, embeddingCache, EMBEDDING_DIMS } from './schema.js';

/**
 * Seeds the embedding cache from vectors already stored on claims.
 *
 * The cache was added after these claims were embedded, so it starts cold and a re-run would pay
 * for vectors we already hold. Recomputing them would cost real quota against a 1000-texts-per-day
 * ceiling; copying them costs nothing.
 *
 * The key must match what the pipeline computes: sha256 of the exact text embedded, which is the
 * subject line followed by the claim text.
 */
async function main(): Promise<void> {
  const db = getDb();
  const { GEMINI_EMBEDDING_MODEL } = getConfig();

  const rows = await db
    .select({ text: claims.text, subject: claims.subject, embedding: claims.embedding })
    .from(claims)
    .where(isNotNull(claims.embedding));

  let inserted = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.embedding) continue;
    const key = createHash('sha256').update(`${row.subject}\n${row.text}`).digest('hex');
    if (seen.has(key)) continue;
    seen.add(key);

    const result = await db
      .insert(embeddingCache)
      .values({
        contentHash: key,
        model: GEMINI_EMBEDDING_MODEL,
        dims: EMBEDDING_DIMS,
        embedding: row.embedding,
      })
      .onConflictDoNothing()
      .returning({ contentHash: embeddingCache.contentHash });
    inserted += result.length;
  }

  process.stdout.write(`Backfilled ${inserted} embeddings from ${rows.length} claims (${seen.size} distinct).\n`);
  await closeDb();
}

await main();
