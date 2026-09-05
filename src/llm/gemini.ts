import { getConfig } from '../config.js';
import { meter } from '../instrument/meter.js';
import { ItemRateLimiter, RateLimiter } from '../util/rate-limiter.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: UsageMetadata;
  error?: { code: number; message: string; status: string };
}

interface EmbedResponse {
  embeddings?: { values: number[] }[];
  error?: { code: number; message: string; status: string };
}

/** Retries on rate limiting and transient server errors; anything else fails immediately. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generation and embedding draw on separate quotas, so they queue separately. */
let generateLimiter: RateLimiter | undefined;
let embedLimiter: ItemRateLimiter | undefined;

function generateQueue(): RateLimiter {
  generateLimiter ??= new RateLimiter(Math.ceil(60_000 / getConfig().GEMINI_MAX_RPM));
  return generateLimiter;
}

/** Paced by texts, because that is the unit the embedding quota counts. */
function embedQueue(): ItemRateLimiter {
  embedLimiter ??= new ItemRateLimiter(getConfig().GEMINI_EMBED_MAX_TEXTS_PER_MIN);
  return embedLimiter;
}

/**
 * Gemini returns a RetryInfo detail on 429 saying exactly how long to wait. Honouring it beats
 * guessing — the measured hint has run past our own ceiling, and ignoring it just burns attempts.
 */
function retryDelayMs(error: unknown): number | undefined {
  const details = (error as { details?: { '@type'?: string; retryDelay?: string }[] } | undefined)?.details;
  const retryInfo = details?.find((d) => String(d['@type'] ?? '').includes('RetryInfo'));
  const seconds = Number(/^([\d.]+)s$/.exec(retryInfo?.retryDelay ?? '')?.[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

async function withRetry<T>(
  label: string,
  schedule: (fn: () => Promise<Response>) => Promise<Response>,
  onBackOff: (ms: number) => void,
  fn: () => Promise<Response>,
): Promise<{ body: T; status: number }> {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await schedule(fn);
    const body = (await response.json()) as T & { error?: { code: number; message: string } };

    if (response.ok) return { body, status: response.status };

    lastError = body.error?.message ?? `${response.status} ${response.statusText}`;
    if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS) break;

    // Prefer the server's own hint; fall back to exponential backoff with jitter. Free-tier quotas
    // are per-minute as well as per-day, so a pause genuinely clears a 429 rather than deferring it.
    const hinted = retryDelayMs(body.error);
    const delay = hinted ?? Math.min(2 ** attempt * 1000, 32_000) * (0.5 + Math.random() / 2);
    // Hold the whole queue back, not just this call, or the next one lands straight into the cap.
    onBackOff(delay);
    await sleep(delay);
  }
  throw new Error(`Gemini ${label} failed: ${lastError}`);
}

export interface GenerateOptions {
  /** JSON Schema (Gemini dialect) the response must conform to. */
  responseSchema: unknown;
  /**
   * Reasoning tokens dominate cost on flash models — measured 654 vs 158 tokens for identical
   * extraction output — so extraction and classification always run at 'low'.
   */
  thinkingLevel?: 'low' | 'high';
  temperature?: number;
}

/** One structured-output call. Returns parsed JSON conforming to `responseSchema`. */
export async function generateStructured<T>(
  prompt: string,
  { responseSchema, thinkingLevel = 'low', temperature = 0 }: GenerateOptions,
): Promise<T> {
  const { GEMINI_API_KEY, GEMINI_MODEL } = getConfig();

  return meter.measure(
    'llm.generate',
    GEMINI_MODEL,
    async () => {
      const { body } = await withRetry<GenerateResponse>(
        `generateContent(${GEMINI_MODEL})`,
        (call) => generateQueue().run(call),
        (ms) => generateQueue().backOff(ms),
        () =>
        fetch(`${BASE}/${GEMINI_MODEL}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': GEMINI_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              responseMimeType: 'application/json',
              responseSchema,
              thinkingConfig: { thinkingLevel },
            },
          }),
        }),
      );

      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned no content; the response may have been truncated.');

      let parsed: T;
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        throw new Error(`Gemini returned invalid JSON despite a response schema: ${text.slice(0, 200)}`);
      }
      return { parsed, usage: body.usageMetadata };
    },
    ({ usage }) => ({
      inputTokens: usage?.promptTokenCount ?? 0,
      // Reasoning tokens are billed and quota-counted, so they belong in the output figure.
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      items: 1,
    }),
  ).then((r) => r.parsed);
}

/** L2-normalises in place. */
function normalise(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/**
 * Embeds a batch of texts.
 *
 * gemini-embedding-001 returns UN-normalised vectors at any dimensionality below 3072 (measured L2
 * norm 0.582 at 768). pgvector's cosine operator does not normalise for you, so this is done here
 * rather than left to a caller who might forget.
 */
export async function embedTexts(
  texts: string[],
  taskType: 'SEMANTIC_SIMILARITY' | 'FACT_VERIFICATION' | 'RETRIEVAL_DOCUMENT' = 'FACT_VERIFICATION',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { GEMINI_API_KEY, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMS } = getConfig();

  return meter.measure(
    'llm.embed',
    GEMINI_EMBEDDING_MODEL,
    async () => {
      const { body } = await withRetry<EmbedResponse>(
        `batchEmbedContents(${GEMINI_EMBEDDING_MODEL})`,
        (call) => embedQueue().run(texts.length, call),
        () => undefined,
        () =>
        fetch(`${BASE}/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`, {
          method: 'POST',
          headers: { 'x-goog-api-key': GEMINI_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            requests: texts.map((text) => ({
              model: `models/${GEMINI_EMBEDDING_MODEL}`,
              content: { parts: [{ text }] },
              taskType,
              outputDimensionality: GEMINI_EMBEDDING_DIMS,
            })),
          }),
        }),
      );

      const embeddings = body.embeddings ?? [];
      if (embeddings.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, received ${embeddings.length}`);
      }
      return embeddings.map((e) => normalise(e.values));
    },
    (vectors) => ({ items: vectors.length }),
  );
}
