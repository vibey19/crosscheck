import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config.js';
import * as schema from './schema.js';

let pool: pg.Pool | undefined;

/** Application queries go through the pooled endpoint. Migrations use the direct one. */
export function getDb() {
  pool ??= new pg.Pool({ connectionString: getConfig().DATABASE_URL, max: 5 });
  return drizzle(pool, { schema });
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
