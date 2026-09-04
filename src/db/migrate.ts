import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { getConfig } from '../config.js';

/** Runs pending migrations against the direct (non-pooled) endpoint. */
async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: getConfig().DATABASE_URL_UNPOOLED });
  await client.connect();
  const db = drizzle(client);

  // pgvector is needed from Phase 1; enabling it here keeps it out of manual dashboard steps.
  await db.execute(sql`create extension if not exists vector`);
  await migrate(db, { migrationsFolder: 'src/db/migrations' });

  await client.end();
  process.stdout.write('Migrations applied.\n');
}

await main();
