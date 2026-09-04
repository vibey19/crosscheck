/**
 * Usage instrumentation.
 *
 * The project's headline results include "LLM calls and tokens per document set, before and after
 * the stage-4 candidate filter". A reduction that was never baselined cannot be reported later, so
 * this exists from the first commit and every outbound call is expected to route through it.
 */

export type MeterKind = 'arxiv.http' | 'llm.generate' | 'llm.embed' | 'db.query';

export interface MeterEvent {
  kind: MeterKind;
  /** Model id, endpoint path, or query label — whatever makes the row identifiable. */
  label: string;
  durationMs: number;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Items handled in one call, so batching shows up as calls-vs-items. */
  items?: number;
  bytes?: number;
}

export interface MeterTotals {
  calls: number;
  items: number;
  inputTokens: number;
  outputTokens: number;
  bytes: number;
  durationMs: number;
  failures: number;
}

export class Meter {
  readonly startedAt = Date.now();
  private readonly events: MeterEvent[] = [];

  record(event: MeterEvent): void {
    this.events.push(event);
  }

  /** Times `fn`, records the result either way, and rethrows on failure. */
  async measure<T>(
    kind: MeterKind,
    label: string,
    fn: () => Promise<T>,
    detail?: (value: T) => Pick<MeterEvent, 'inputTokens' | 'outputTokens' | 'items' | 'bytes'>,
  ): Promise<T> {
    const t0 = performance.now();
    try {
      const value = await fn();
      this.record({
        kind,
        label,
        durationMs: performance.now() - t0,
        ok: true,
        ...(detail?.(value) ?? {}),
      });
      return value;
    } catch (error) {
      this.record({ kind, label, durationMs: performance.now() - t0, ok: false });
      throw error;
    }
  }

  totals(kind?: MeterKind): MeterTotals {
    const rows = kind ? this.events.filter((e) => e.kind === kind) : this.events;
    return rows.reduce<MeterTotals>(
      (acc, e) => ({
        calls: acc.calls + 1,
        items: acc.items + (e.items ?? 0),
        inputTokens: acc.inputTokens + (e.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (e.outputTokens ?? 0),
        bytes: acc.bytes + (e.bytes ?? 0),
        durationMs: acc.durationMs + e.durationMs,
        failures: acc.failures + (e.ok ? 0 : 1),
      }),
      { calls: 0, items: 0, inputTokens: 0, outputTokens: 0, bytes: 0, durationMs: 0, failures: 0 },
    );
  }

  /** Serialisable snapshot, destined for `eval_runs.metrics` in Phase 3. */
  snapshot(): Record<string, unknown> {
    const kinds = [...new Set(this.events.map((e) => e.kind))];
    return {
      wallClockMs: Date.now() - this.startedAt,
      overall: this.totals(),
      byKind: Object.fromEntries(kinds.map((k) => [k, this.totals(k)])),
    };
  }

  toEvents(): readonly MeterEvent[] {
    return this.events;
  }
}

/** Process-wide meter. Phase 3 will construct scoped meters per eval run instead. */
export const meter = new Meter();
