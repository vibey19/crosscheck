import { and, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import { documents, sections as sectionsTable } from '../db/schema.js';
import { meter } from '../instrument/meter.js';
import { ingestDocument, sectionHash, sectionText, type IngestedDocument } from '../ingest/pipeline.js';
import { parseArxivId } from '../ingest/arxiv/id.js';
import { extractDocumentClaims, getDocumentId } from '../claims/pipeline.js';
import { detectIntraDocument, type IntraFinding } from '../detect/intra.js';
import { detectCrossDocument } from '../detect/cross.js';

const USAGE = `crosscheck — cross-document contradiction engine

Usage:
  npm run crosscheck -- ingest  <arxiv-id> [--json] [--save] [--preview N]
  npm run crosscheck -- analyze <arxiv-id> [--json] [--no-verifier] [--no-classifier]
  npm run crosscheck -- detect  <arxiv-id> [--json] [--no-verifier] [--no-classifier]
  npm run crosscheck -- corpus  <id> <id> [<id>...] [--json] [--no-verifier] [--no-classifier]

Commands:
  ingest    Fetch a paper and print its section tree with character offsets
  analyze   Ingest, extract claims, and check the paper against itself
  detect    Re-run detection over claims already stored, with no extraction
  corpus    Find contradictions ACROSS several already-analyzed papers

Arguments:
  <arxiv-id>    2301.12345, 2301.12345v2, math/0309136, or an arxiv.org URL

Options:
  --json        Emit machine-readable JSON instead of a table
  --save        Persist document and sections to Postgres (ingest only)
  --preview N   Show the first N characters of each section (default 0)

Ablation (analyze only):
  --no-classifier  Skip stage 5, entailment classification
  --no-verifier    Skip stage 6, adversarial verification
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

  // Sections cascade-delete claims, so replacing them unconditionally would discard a document's
  // claims on every run — and lose them for good if the extraction that follows then fails. An
  // unchanged parse of an immutable arXiv version has nothing to rewrite.
  const [existing] = await db
    .select({ id: documents.id, contentHash: documents.contentHash, parserVersion: documents.parserVersion })
    .from(documents)
    .where(and(eq(documents.arxivId, doc.arxivId), eq(documents.version, doc.version)))
    .limit(1);

  if (existing && existing.contentHash === doc.contentHash && existing.parserVersion === doc.parserVersion) {
    process.stdout.write(`${doc.idWithVersion}: sections unchanged, keeping stored claims.\n`);
    return;
  }

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

function printDetectionStats(
  stats: Awaited<ReturnType<typeof detectIntraDocument>>['stats'],
  refine: { classify: boolean; verify: boolean },
): void {
  const out = process.stdout;
  out.write(`candidates:  ${stats.candidatePairs} pairs from ${stats.allPairsBaseline.toLocaleString()} possible `);
  out.write(`(${stats.allPairsBaseline > 0 ? (100 - (stats.candidatePairs / stats.allPairsBaseline) * 100).toFixed(1) : '0'}% filtered out)\n`);
  out.write(`type filter: ${stats.survivedTypeFilter} survived · ${stats.numericPairsCompared} quantity comparisons\n`);
  out.write(`arithmetic:  ${stats.arithmeticCandidates} candidate conflicts\n`);
  if (stats.refine) {
    const r = stats.refine;
    out.write(`stage 5:     ${refine.classify ? `${r.classifierCalls} calls · ${r.rejectedDifferentSubject} different subject · ${r.rejectedNotContradiction} not a contradiction` : 'DISABLED'}\n`);
    const reasons = Object.entries(r.verifierRejectionReasons).map(([k, v]) => `${v} ${k}`).join(' · ');
    out.write(`stage 6:     ${refine.verify ? `${r.verifierCalls} calls · ${r.rejectedByVerifier} could not be defended${reasons ? ` (${reasons})` : ''}` : 'DISABLED'}\n`);
  }
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

/**
 * Detection over already-stored claims.
 *
 * Extraction is cached per model, so re-running `analyze` under a different model re-pays the whole
 * extraction cost. Detection does not need it: the claims are in the database already. Keeping the
 * two separable is what makes an ablation affordable under a 20-request daily cap.
 */
async function detect(
  arxivId: string,
  asJson: boolean,
  refine: { classify: boolean; verify: boolean },
): Promise<void> {
  const { id: parsedId } = parseArxivId(arxivId);
  const documentId = await getDocumentId(parsedId);
  if (!documentId) {
    throw new Error(`${parsedId} has no stored claims. Run: analyze ${parsedId}`);
  }

  const { stats, results, rejected } = await detectIntraDocument(documentId, refine);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ arxivId: parsedId, detection: stats, ablation: refine,
      rejected: rejected.map((row) => ({
        values: [row.finding.conflict.a.value, row.finding.conflict.b.value],
        reason: row.verification?.rejectionReason ?? null,
        objection: row.verification?.objection ?? null,
        a: row.finding.a.text.slice(0, 120),
        b: row.finding.b.text.slice(0, 120),
      })),
      findings: results.map((f) => ({
        confidence: f.confidence, rationale: f.rationale,
        values: [f.conflict.a.value, f.conflict.b.value], unit: f.conflict.a.unit,
        spans: [
          { section: f.a.sectionPath, charStart: f.a.charStart, charEnd: f.a.charEnd, text: f.a.text },
          { section: f.b.sectionPath, charStart: f.b.charStart, charEnd: f.b.charEnd, text: f.b.text },
        ],
      })), usage: meter.snapshot() }, null, 2)}\n`);
    return;
  }

  printDetectionStats(stats, refine);
  printFindings(results, `https://arxiv.org/abs/${parsedId}`);
}

async function analyze(
  arxivId: string,
  asJson: boolean,
  refine: { classify: boolean; verify: boolean },
): Promise<void> {
  const doc = await ingestDocument(arxivId);
  await save(doc);

  const extraction = await extractDocumentClaims(doc);
  const documentId = await getDocumentId(doc.arxivId);
  if (!documentId) throw new Error(`${doc.idWithVersion} was not persisted.`);

  const { stats, results } = await detectIntraDocument(documentId, refine);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      document: { arxivId: doc.arxivId, version: doc.version, title: doc.title, url: doc.url },
      extraction,
      detection: stats,
      ablation: refine,
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
  out.write(`embeddings:  ${extraction.embeddingsReused} reused · ${extraction.embeddingsComputed} computed\n`);
  out.write(`types:       ${Object.entries(extraction.byType).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);
  printDetectionStats(stats, refine);

  printFindings(results, doc.url);

  const gen = meter.totals('llm.generate');
  const emb = meter.totals('llm.embed');
  out.write(`\nLLM: ${gen.calls} generate calls (${gen.inputTokens + gen.outputTokens} tokens) · `);
  out.write(`${emb.calls} embed calls (${emb.items} vectors)\n`);
}

async function corpus(
  arxivIds: string[],
  asJson: boolean,
  refine: { classify: boolean; verify: boolean },
): Promise<void> {
  const ids = arxivIds.map((raw) => parseArxivId(raw).id);
  const { stats, results } = await detectCrossDocument(ids, refine);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      corpus: ids,
      detection: stats,
      ablation: refine,
      findings: results.map((f) => ({
        conflictType: f.conflictType,
        confidence: f.confidence,
        rationale: f.rationale,
        similarity: f.similarity,
        metric: f.conflict.a.metric,
        values: [f.conflict.a.value, f.conflict.b.value],
        sources: [
          {
            arxivId: f.a.arxivId, version: f.a.version, title: f.a.title,
            url: `https://arxiv.org/abs/${f.a.arxivId}v${f.a.version}`,
            section: f.a.sectionPath, charStart: f.a.charStart, charEnd: f.a.charEnd, text: f.a.text,
          },
          {
            arxivId: f.b.arxivId, version: f.b.version, title: f.b.title,
            url: `https://arxiv.org/abs/${f.b.arxivId}v${f.b.version}`,
            section: f.b.sectionPath, charStart: f.b.charStart, charEnd: f.b.charEnd, text: f.b.text,
          },
        ],
      })),
      usage: meter.snapshot(),
    }, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`\ncorpus:      ${stats.documents} papers · ${stats.claims} claims\n`);
  out.write(`candidates:  ${stats.candidatePairs} pairs from ${stats.allPairsBaseline.toLocaleString()} possible `);
  out.write(`(${stats.allPairsBaseline > 0 ? (100 - (stats.candidatePairs / stats.allPairsBaseline) * 100).toFixed(2) : '0'}% filtered out)\n`);
  out.write(`type filter: ${stats.survivedTypeFilter} survived · ${stats.numericPairsCompared} quantity comparisons\n`);
  out.write(`arithmetic:  ${stats.arithmeticCandidates} candidate conflicts\n`);
  if (stats.refine) {
    const r = stats.refine;
    out.write(`stage 5:     ${refine.classify ? `${r.classifierCalls} calls · ${r.rejectedDifferentSubject} different subject` : 'DISABLED'}\n`);
    out.write(`stage 6:     ${refine.verify ? `${r.verifierCalls} calls · ${r.rejectedByVerifier} could not be defended` : 'DISABLED'}\n`);
  }

  if (results.length === 0) {
    out.write('\nNo cross-document numeric contradictions found.\n');
    return;
  }
  out.write(`\n${results.length} cross-document contradiction${results.length === 1 ? '' : 's'} found\n`);
  for (const [i, f] of results.entries()) {
    out.write(`\n${i + 1}. ${f.conflict.a.metric ?? ''} — ${f.conflict.a.value} vs ${f.conflict.b.value}`);
    out.write(`  (confidence ${f.confidence.toFixed(2)})\n`);
    for (const side of [f.a, f.b]) {
      out.write(`   ${side.arxivId}v${side.version} · ${side.sectionPath}  [${side.charStart}, ${side.charEnd})\n`);
      out.write(`     "${side.text.replace(/\s+/g, ' ').slice(0, 140)}"\n`);
      out.write(`     https://arxiv.org/abs/${side.arxivId}v${side.version}\n`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (command === 'corpus') {
    const ids = rest.filter((arg) => !arg.startsWith('-'));
    if (ids.length < 2) {
      process.stdout.write(USAGE);
      process.exitCode = 1;
      return;
    }
    await corpus(ids, rest.includes('--json'), {
      classify: !rest.includes('--no-classifier'),
      verify: !rest.includes('--no-verifier'),
    });
    return;
  }

  if (command === 'detect' && rest.length > 0 && !rest[0]?.startsWith('-')) {
    await detect(rest[0]!, rest.includes('--json'), {
      classify: !rest.includes('--no-classifier'),
      verify: !rest.includes('--no-verifier'),
    });
    return;
  }

  if (command === 'analyze' && rest.length > 0 && !rest[0]?.startsWith('-')) {
    await analyze(rest[0]!, rest.includes('--json'), {
      classify: !rest.includes('--no-classifier'),
      verify: !rest.includes('--no-verifier'),
    });
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
