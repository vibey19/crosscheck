import { z } from 'zod';

// Node loads .env.local natively; no dotenv dependency needed.
if (process.env['CROSSCHECK_SKIP_ENV_FILE'] !== '1') {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // Absent in CI, where values arrive as real environment variables.
  }
}

const schema = z.object({
  DATABASE_URL: z.string().url(),
  // Migrations must not run through the pooler.
  DATABASE_URL_UNPOOLED: z.string().url(),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
  GEMINI_EMBEDDING_DIMS: z.coerce.number().int().positive().default(768),

  ARXIV_USER_AGENT: z.string().min(1),
  // arXiv's terms of use set the floor at one request per three seconds.
  ARXIV_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(3000).default(3000),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration. Check .env.local against .env.example:\n${detail}`);
  }
  cached = parsed.data;
  return cached;
}
