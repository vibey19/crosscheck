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


/**
 * Paces work measured in items rather than calls, over a rolling window.
 *
 * The embedding quota counts embedded TEXTS, not requests: a limiter spacing calls at 60/minute
 * happily sends 64 texts per call and lands ~3,840/minute against a 100/minute ceiling. Batching
 * to save requests actively works against a per-item quota unless the pacing knows the batch size.
 */
export class ItemRateLimiter {
  private readonly events: { at: number; items: number }[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly maxItemsPerWindow: number, private readonly windowMs = 60_000) {}

  private itemsInWindow(now: number): number {
    while (this.events.length > 0 && now - this.events[0]!.at > this.windowMs) this.events.shift();
    return this.events.reduce((total, event) => total + event.items, 0);
  }

  /** Queues `fn`, waiting until `items` more fit inside the window. */
  run<T>(items: number, fn: () => Promise<T>): Promise<T> {
    const scheduled = this.tail.then(async () => {
      for (;;) {
        const now = Date.now();
        if (this.itemsInWindow(now) + items <= this.maxItemsPerWindow) break;
        const oldest = this.events[0];
        if (!oldest) break;
        await new Promise((resolve) => setTimeout(resolve, Math.max(250, oldest.at + this.windowMs - now)));
      }
      this.events.push({ at: Date.now(), items });
      return fn();
    });
    this.tail = scheduled.catch(() => undefined);
    return scheduled;
  }
}
