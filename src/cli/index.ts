import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import { documents, sections as sectionsTable } from '../db/schema.js';
import { meter } from '../instrument/meter.js';
import { ingestDocument, sectionHash, sectionText, type IngestedDocument } from '../ingest/pipeline.js';
import { extractDocumentClaims, getDocumentId } from '../claims/pipeline.js';
import { detectIntraDocument, type IntraFinding } from '../detect/intra.js';

const USAGE = `crosscheck — cross-document contradiction engine

Usage:
  npm run crosscheck -- ingest  <arxiv-id> [--json] [--save] [--preview N]
  npm run crosscheck -- analyze <arxiv-id> [--json]

Commands:
  ingest    Fetch a paper and print its section tree with character offsets
  analyze   Ingest, extract claims, and check the paper against itself

Arguments:
  <arxiv-id>    2301.12345, 2301.12345v2, math/0309136, or an arxiv.org URL

Options:
  --json        Emit machine-readable JSON instead of a table
  --save        Persist document and sections to Postgres (ingest only)
  --preview N   Show the first N characters of each section (default 0)
`;

function printTree(doc: IngestedDocument, previewChars: number): void {
  const out = process.stdout;
  out.write(`\n${doc.title}\n`);
  out.write(`${doc.url}  ·  main file: ${doc.mainTexFile}  ·  parser v${doc.parserVersion}\n`);
  out.write(`${doc.text.length.toLocaleString()} chars normalised  ·  ${doc.sections.length} sections\n\n`);

  const width = String(doc.text.length).length;
  for (const section of doc.sections) {
    const indent = '  '.repeat(section.level - 1);
    const span = `[${String(section.charStart).padStart(width)}, ${String(section.charEnd).padStart(width)})`;
    const length = section.charEnd - section.charStart;
    out.write(`  ${span} ${String(length).padStart(width)}ch  ${indent}${section.path}\n`);
    if (previewChars > 0) {
      const preview = sectionText(doc, section).slice(0, previewChars).replace(/\s+/g, ' ');
      out.write(`  ${' '.repeat(width * 3 + 8)}${indent}› ${preview}…\n`);
    }
  }

  const http = meter.totals('arxiv.http');
  out.write(`\narXiv requests: ${http.calls} · ${(http.bytes / 1024).toFixed(0)} KiB · ${(http.durationMs / 1000).toFixed(1)}s\n`);
}

async function save(doc: IngestedDocument): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Re-ingesting the same version replaces it, so a parser change can be re-run cleanly.
    const [row] = await tx
      .insert(documents)
      .values({
        arxivId: doc.arxivId,
        version: doc.version,
        title: doc.title,
        parserVersion: doc.parserVersion,
        contentHash: doc.contentHash,
        textLength: doc.text.length,
      })
      .onConflictDoUpdate({
        target: [documents.arxivId, documents.version],
        set: {
          title: doc.title,
          parserVersion: doc.parserVersion,
          contentHash: doc.contentHash,
          textLength: doc.text.length,
          fetchedAt: new Date(),
        },
      })
      .returning({ id: documents.id });

    const documentId = row!.id;
    await tx.delete(sectionsTable).where(eq(sectionsTable.documentId, documentId));
    await tx.insert(sectionsTable).values(
      doc.sections.map((section) => ({
        documentId,
        path: section.path,
        title: section.title,
        level: section.level,
        ordinal: section.ordinal,
        charStart: section.charStart,
        charEnd: section.charEnd,
        contentHash: sectionHash(doc, section),
      })),
    );
  });
  process.stdout.write(`Saved ${doc.sections.length} sections for ${doc.idWithVersion}.\n`);
}

function printFindings(results: IntraFinding[], url: string): void {
  const out = process.stdout;
  if (results.length === 0) {
    out.write('\nNo numeric self-inconsistencies found.\n');
    return;
  }

  out.write(`\n${results.length} numeric self-inconsistenc${results.length === 1 ? 'y' : 'ies'} found\n`);
  for (const [index, finding] of results.entries()) {
    const { a, b, conflict } = finding;
    out.write(`\n${index + 1}. ${conflict.a.subject}\n`);
    out.write(`   ${conflict.a.value} vs ${conflict.b.value} ${conflict.a.unit ?? ''}`.trimEnd());
    out.write(`   (${(conflict.relativeDifference * 100).toFixed(1)}% apart, confidence ${finding.confidence.toFixed(2)})\n\n`);
    for (const side of [a, b]) {
      out.write(`   ${side.sectionPath}  [${side.charStart}, ${side.charEnd})\n`);
      out.write(`     "${side.text.replace(/\s+/g, ' ').slice(0, 150)}"\n`);
    }
    out.write(`   ${url}\n`);
  }
}

async function analyze(arxivId: string, asJson: boolean): Promise<void> {
  const doc = await ingestDocument(arxivId);
  await save(doc);

  const extraction = await extractDocumentClaims(doc);
  const documentId = await getDocumentId(doc.arxivId);
  if (!documentId) throw new Error(`${doc.idWithVersion} was not persisted.`);

  const { stats, results } = await detectIntraDocument(documentId);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      document: { arxivId: doc.arxivId, version: doc.version, title: doc.title, url: doc.url },
      extraction,
      detection: stats,
      findings: results.map((f) => ({
        conflictType: f.conflictType,
        confidence: f.confidence,
        rationale: f.rationale,
        similarity: f.similarity,
        values: [f.conflict.a.value, f.conflict.b.value],
        unit: f.conflict.a.unit,
        spans: [
          { section: f.a.sectionPath, charStart: f.a.charStart, charEnd: f.a.charEnd, text: f.a.text },
          { section: f.b.sectionPath, charStart: f.b.charStart, charEnd: f.b.charEnd, text: f.b.text },
        ],
      })),
      usage: meter.snapshot(),
    }, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`\n${doc.title}\n${doc.url}\n\n`);
  out.write(`claims:      ${extraction.claims} from ${extraction.sectionsConsidered} sections `);
  out.write(`(${extraction.sectionsFromCache} cached, ${extraction.llmCalls} LLM calls)\n`);
  out.write(`spans:       ${extraction.spansResolved}/${extraction.claims} located verbatim\n`);
  out.write(`types:       ${Object.entries(extraction.byType).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);
  out.write(`candidates:  ${stats.candidatePairs} pairs from ${stats.allPairsBaseline.toLocaleString()} possible `);
  out.write(`(${stats.allPairsBaseline > 0 ? (100 - (stats.candidatePairs / stats.allPairsBaseline) * 100).toFixed(1) : '0'}% filtered out)\n`);
  out.write(`type filter: ${stats.survivedTypeFilter} survived · ${stats.numericPairsCompared} quantity comparisons\n`);

  printFindings(results, doc.url);

  const gen = meter.totals('llm.generate');
  const emb = meter.totals('llm.embed');
  out.write(`\nLLM: ${gen.calls} generate calls (${gen.inputTokens + gen.outputTokens} tokens) · `);
  out.write(`${emb.calls} embed calls (${emb.items} vectors)\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (command === 'analyze' && rest.length > 0 && !rest[0]?.startsWith('-')) {
    await analyze(rest[0]!, rest.includes('--json'));
    return;
  }

  if (command !== 'ingest' || rest.length === 0 || rest[0]?.startsWith('-')) {
    process.stdout.write(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }

  const arxivId = rest[0]!;
  const asJson = rest.includes('--json');
  const shouldSave = rest.includes('--save');
  const previewIndex = rest.indexOf('--preview');
  const previewChars = previewIndex >= 0 ? Number(rest[previewIndex + 1] ?? 0) : 0;

  const doc = await ingestDocument(arxivId);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          arxivId: doc.arxivId,
          version: doc.version,
          title: doc.title,
          url: doc.url,
          mainTexFile: doc.mainTexFile,
          parserVersion: doc.parserVersion,
          contentHash: doc.contentHash,
          textLength: doc.text.length,
          sections: doc.sections,
          usage: meter.snapshot(),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printTree(doc, previewChars);
  }

  if (shouldSave) await save(doc);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
