/**
 * Serialises calls to one upstream and spaces them by a minimum interval.
 *
 * Used for two providers with unrelated limits. arXiv's terms of use require no more than one
 * request every three seconds on a single connection — both halves matter, and serialising means
 * concurrency upstream can never become concurrent fetches here. Gemini's free tier caps requests
 * per minute per model, where the same queue converts a burst into a sustainable rate instead of a
 * wall of 429s.
 */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  /** Delays the next start by an extra `ms`, honouring a server-supplied retry hint. */
  backOff(ms: number): void {
    this.lastStartedAt = Math.max(this.lastStartedAt, Date.now() + ms - this.minIntervalMs);
  }

  /** Queues `fn`, running it no sooner than `minIntervalMs` after the previous run began. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const scheduled = this.tail.then(async () => {
      const waitMs = this.lastStartedAt + this.minIntervalMs - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastStartedAt = Date.now();
      return fn();
    });
    // Keep the chain alive regardless of individual failures.
    this.tail = scheduled.catch(() => undefined);
    return scheduled;
  }
}
