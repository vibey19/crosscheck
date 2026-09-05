import fs from 'node:fs/promises';
import { closeDb } from '../db/client.js';
import { loadLatestRun, renderResults, spliceIntoReadme } from './report.js';

/** Rewrites the README's benchmark block from the most recent recorded run. */
async function main(): Promise<void> {
  const run = await loadLatestRun();
  if (!run) {
    process.stderr.write('No eval run recorded; README left unchanged.\n');
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const readme = await fs.readFile('README.md', 'utf8');
  await fs.writeFile('README.md', spliceIntoReadme(readme, renderResults(run)));
  process.stdout.write(`README updated from run ${run.runId}.\n`);
  await closeDb();
}

await main();
