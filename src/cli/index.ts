import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import { documents, sections as sectionsTable } from '../db/schema.js';
import { meter } from '../instrument/meter.js';
import { ingestDocument, sectionHash, sectionText, type IngestedDocument } from '../ingest/pipeline.js';

const USAGE = `crosscheck — cross-document contradiction engine

Usage:
  npm run crosscheck -- ingest <arxiv-id> [--json] [--save] [--preview N]

Arguments:
  <arxiv-id>    2301.12345, 2301.12345v2, math/0309136, or an arxiv.org URL

Options:
  --json        Emit the section tree as JSON instead of a table
  --save        Persist document and sections to Postgres
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

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
