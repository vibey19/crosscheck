import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getConfig } from '../config.js';
import { getDb } from '../db/client.js';
import {
  documents, evalRuns, injections as injectionsTable, sections as sectionsTable,
} from '../db/schema.js';
import { detectIntraDocument } from '../detect/intra.js';
import { meter } from '../instrument/meter.js';
import { ingestDocument, type IngestedDocument } from '../ingest/pipeline.js';
import { extractDocumentClaims } from '../claims/pipeline.js';
import { applyMutation, planNumericMutations, sampleMutations, type Mutation } from './inject.js';

/**
 * The benchmark.
 *
 * For each injected mutation: build a variant of the paper with that one figure changed, run the
 * full pipeline over it, and check whether any reported finding actually points at the mutated
 * span. A hit is decided by comparing character offsets, never by asking a model whether it found
 * the right thing.
 *
 * The clean control arm runs the same papers unmutated, where by construction every finding is a
 * false positive.
 */

export interface EvalOptions {
  arxivIds: string[];
  /** Mutations sampled per paper. */
  perPaper: number;
  seed: number;
  classify: boolean;
  verify: boolean;
  /** Skip the injected arm and only measure false positives on clean papers. */
  controlOnly?: boolean;
}

export interface EvalMetrics {
  injected: { total: number; detected: number; recall: number | null };
  control: { papers: number; findings: number; falsePositivesPerPaper: number | null };
  cost: { generateCalls: number; embedCalls: number; inputTokens: number; outputTokens: number };
}

/** A finding counts as a hit when one of its spans overlaps the mutated characters. */
function overlaps(spanStart: number | null, spanEnd: number | null, mutation: Mutation): boolean {
  if (spanStart === null || spanEnd === null) return false;
  return spanStart < mutation.charEnd && spanEnd > mutation.charStart;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Materialises a mutated variant as its own document.
 *
 * Variants carry `evalRunId`, which every user-facing query filters on, so a mutated paper can
 * never surface in a real report. The version is offset into a synthetic range to avoid colliding
 * with the genuine arXiv version.
 */
async function materialiseVariant(
  runId: string,
  clean: IngestedDocument,
  mutation: Mutation,
  index: number,
): Promise<{ documentId: string; variant: IngestedDocument }> {
  const db = getDb();
  const text = applyMutation(clean.text, mutation);
  const version = 900_000 + index;

  const [row] = await db
    .insert(documents)
    .values({
      arxivId: clean.arxivId,
      version,
      title: `${clean.title} [eval variant ${index}]`,
      parserVersion: clean.parserVersion,
      contentHash: sha256(text),
      textLength: text.length,
      evalRunId: runId,
    })
    .onConflictDoUpdate({
      target: [documents.arxivId, documents.version],
      set: { contentHash: sha256(text), evalRunId: runId },
    })
    .returning({ id: documents.id });

  const documentId = row!.id;
  await db.delete(sectionsTable).where(eq(sectionsTable.documentId, documentId));
  await db.insert(sectionsTable).values(
    clean.sections.map((section) => ({
      documentId,
      path: section.path,
      title: section.title,
      level: section.level,
      ordinal: section.ordinal,
      charStart: section.charStart,
      charEnd: section.charEnd,
      // Mutation preserves length, so section offsets carry over unchanged.
      contentHash: sha256(text.slice(section.charStart, section.charEnd)),
    })),
  );

  return { documentId, variant: { ...clean, text, version, contentHash: sha256(text) } };
}

export async function runEvaluation(options: EvalOptions): Promise<{ runId: string; metrics: EvalMetrics }> {
  const db = getDb();
  const { GEMINI_MODEL } = getConfig();

  const [run] = await db
    .insert(evalRuns)
    .values({
      config: {
        arxivIds: options.arxivIds,
        perPaper: options.perPaper,
        seed: options.seed,
        controlOnly: options.controlOnly ?? false,
      },
      classifierEnabled: options.classify,
      verifierEnabled: options.verify,
      model: GEMINI_MODEL,
    })
    .returning({ id: evalRuns.id });
  const runId = run!.id;

  const refine = { classify: options.classify, verify: options.verify };
  let injectedTotal = 0;
  let injectedDetected = 0;
  let controlFindings = 0;
  let controlPapers = 0;

  for (const arxivId of options.arxivIds) {
    const clean = await ingestDocument(arxivId);

    // Control arm: the unmutated paper, where every finding is by construction a false positive.
    const cleanDocId = await upsertClean(clean);
    await extractDocumentClaims({ ...clean, version: clean.version });
    const control = await detectIntraDocument(cleanDocId, refine);
    controlFindings += control.results.length;
    controlPapers += 1;

    if (options.controlOnly) continue;

    const planned = sampleMutations(
      planNumericMutations(clean.text, clean.sections),
      options.perPaper,
      options.seed,
    );

    for (const [index, mutation] of planned.entries()) {
      const { documentId, variant } = await materialiseVariant(runId, clean, mutation, index);
      await extractDocumentClaims(variant, documentId);
      const { results } = await detectIntraDocument(documentId, refine);

      const hit = results.find(
        (finding) =>
          overlaps(finding.a.charStart, finding.a.charEnd, mutation) ||
          overlaps(finding.b.charStart, finding.b.charEnd, mutation),
      );

      injectedTotal += 1;
      if (hit) injectedDetected += 1;

      await db.insert(injectionsTable).values({
        runId,
        sourceArxivId: clean.arxivId,
        documentId,
        mutationType: mutation.type,
        charStart: mutation.charStart,
        charEnd: mutation.charEnd,
        originalText: mutation.originalText,
        mutatedText: mutation.mutatedText,
        counterpartStart: mutation.counterpartStart,
        counterpartEnd: mutation.counterpartEnd,
        sectionPath: mutation.sectionPath,
        detected: Boolean(hit),
        matchedFinding: hit
          ? { rationale: hit.rationale, values: [hit.conflict.a.value, hit.conflict.b.value] }
          : null,
        note: mutation.note,
      });
    }
  }

  const generate = meter.totals('llm.generate');
  const embed = meter.totals('llm.embed');
  const metrics: EvalMetrics = {
    injected: {
      total: injectedTotal,
      detected: injectedDetected,
      recall: injectedTotal > 0 ? injectedDetected / injectedTotal : null,
    },
    control: {
      papers: controlPapers,
      findings: controlFindings,
      falsePositivesPerPaper: controlPapers > 0 ? controlFindings / controlPapers : null,
    },
    cost: {
      generateCalls: generate.calls,
      embedCalls: embed.calls,
      inputTokens: generate.inputTokens,
      outputTokens: generate.outputTokens,
    },
  };

  await db
    .update(evalRuns)
    .set({ finishedAt: new Date(), metrics })
    .where(eq(evalRuns.id, runId));

  return { runId, metrics };
}

/** Ensures the clean paper exists as a non-variant document and returns its id. */
async function upsertClean(doc: IngestedDocument): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.arxivId, doc.arxivId), eq(documents.version, doc.version)))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(documents)
    .values({
      arxivId: doc.arxivId,
      version: doc.version,
      title: doc.title,
      parserVersion: doc.parserVersion,
      contentHash: doc.contentHash,
      textLength: doc.text.length,
    })
    .returning({ id: documents.id });
  const documentId = row!.id;

  await db.insert(sectionsTable).values(
    doc.sections.map((section) => ({
      documentId,
      path: section.path,
      title: section.title,
      level: section.level,
      ordinal: section.ordinal,
      charStart: section.charStart,
      charEnd: section.charEnd,
      contentHash: sha256(doc.text.slice(section.charStart, section.charEnd)),
    })),
  );
  return documentId;
}
