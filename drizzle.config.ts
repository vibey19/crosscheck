import { defineConfig } from 'drizzle-kit';
import { getConfig } from './src/config.js';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  // Schema changes must bypass the connection pooler.
  dbCredentials: { url: getConfig().DATABASE_URL_UNPOOLED },
  strict: true,
});
