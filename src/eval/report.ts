import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { evalRuns, injections } from '../db/schema.js';

/**
 * Renders the benchmark's results into the README, between markers.
 *
 * The table is generated from what the harness actually recorded, never hand-edited. A number that
 * did not come out of a run must not appear here — that is the one rule this project's credibility
 * rests on, so anything not measured is written as "not measured" rather than left blank or
 * guessed at.
 */

const START = '<!-- BENCHMARK:START -->';
const END = '<!-- BENCHMARK:END -->';

export interface RunSummary {
  runId: string;
  startedAt: Date;
  model: string;
  classifierEnabled: boolean;
  verifierEnabled: boolean;
  metrics: {
    injected: { total: number; detected: number; recall: number | null };
    control: { papers: number; findings: number; falsePositivesPerPaper: number | null };
    cost: { generateCalls: number; embedCalls: number; inputTokens: number; outputTokens: number };
  } | null;
  byType: { mutationType: string; total: number; detected: number }[];
}

export async function loadLatestRun(): Promise<RunSummary | undefined> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(evalRuns)
    .where(eq(evalRuns.id, evalRuns.id))
    .orderBy(desc(evalRuns.startedAt))
    .limit(1);
  if (!run) return undefined;

  const rows = await db.select().from(injections).where(eq(injections.runId, run.id));
  const grouped = new Map<string, { total: number; detected: number }>();
  for (const row of rows) {
    const entry = grouped.get(row.mutationType) ?? { total: 0, detected: 0 };
    entry.total += 1;
    if (row.detected) entry.detected += 1;
    grouped.set(row.mutationType, entry);
  }

  return {
    runId: run.id,
    startedAt: run.startedAt,
    model: run.model,
    classifierEnabled: run.classifierEnabled,
    verifierEnabled: run.verifierEnabled,
    metrics: run.metrics as RunSummary['metrics'],
    byType: [...grouped].map(([mutationType, value]) => ({ mutationType, ...value })),
  };
}

function pct(value: number | null): string {
  return value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`;
}

export function renderResults(run: RunSummary): string {
  const m = run.metrics;
  const lines: string[] = [];

  lines.push('### Preliminary results');
  lines.push('');
  lines.push(
    `Measured ${run.startedAt.toISOString().slice(0, 10)} on \`${run.model}\`, ` +
      `run \`${run.runId.slice(0, 8)}\`.`,
  );
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');

  if (m) {
    lines.push(`| Injected contradictions | ${m.injected.total} |`);
    lines.push(`| Detected | ${m.injected.detected} |`);
    lines.push(`| **Recall** | **${pct(m.injected.recall)}** |`);
    lines.push(`| Clean control papers | ${m.control.papers} |`);
    lines.push(`| Findings on clean papers (all false by construction) | ${m.control.findings} |`);
    lines.push(
      `| **False positives per clean paper** | **${
        m.control.falsePositivesPerPaper === null ? 'not measured' : m.control.falsePositivesPerPaper.toFixed(2)
      }** |`,
    );
    lines.push(`| Stage 5 (entailment) | ${run.classifierEnabled ? 'enabled' : 'disabled'} |`);
    lines.push(`| Stage 6 (adversarial verifier) | ${run.verifierEnabled ? 'enabled' : 'disabled'} |`);
    lines.push(`| LLM generate calls | ${m.cost.generateCalls} |`);
    lines.push(`| Tokens | ${(m.cost.inputTokens + m.cost.outputTokens).toLocaleString()} |`);
  } else {
    lines.push('| — | run recorded no metrics |');
  }

  if (run.byType.length > 0) {
    lines.push('');
    lines.push('| Conflict type | Injected | Detected | Recall |');
    lines.push('|---|---|---|---|');
    for (const row of run.byType) {
      lines.push(
        `| \`${row.mutationType}\` | ${row.total} | ${row.detected} | ` +
          `${pct(row.total > 0 ? row.detected / row.total : null)} |`,
      );
    }
  }

  return lines.join('\n');
}

export const MARKERS = { START, END };

/** Replaces the marked block in the README, leaving the rest untouched. */
export function spliceIntoReadme(readme: string, rendered: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0) {
    throw new Error(`README is missing the ${START} / ${END} markers.`);
  }
  return `${readme.slice(0, start + START.length)}\n\n${rendered}\n\n${readme.slice(end)}`;
}
