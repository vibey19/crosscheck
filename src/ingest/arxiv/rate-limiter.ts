/**
 * arXiv's terms of use require no more than one request every three seconds, on a single
 * connection at a time. Both halves matter: this queue serialises every arXiv request in the
 * process and spaces them, so concurrency upstream can never turn into concurrent fetches here.
 */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

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
