import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { type Quantity } from '../db/schema.js';
import { conflictConfidence, describesSameMeasurement, findNumericConflict, type NumericConflict } from './arithmetic.js';
import { refineFindings, type RefineOptions, type RefineStats } from './refine.js';

/**
 * Cross-document detection — the headline capability.
 *
 * Structurally the same as intra-document, with one difference that matters for cost: candidates
 * are drawn only from *other* documents. A paper's claims agreeing with themselves is stage 4's
 * job elsewhere, and including them here would spend the ANN budget re-deriving it.
 */

export interface CrossFinding {
  conflictType: 'NUMERIC';
  confidence: number;
  rationale: string;
  similarity: number;
  a: CrossClaim;
  b: CrossClaim;
  conflict: NumericConflict;
}

export interface CrossClaim {
  id: string;
  text: string;
  subject: string;
  quantities: Quantity[];
  charStart: number | null;
  charEnd: number | null;
  sectionPath: string;
  arxivId: string;
  version: number;
  title: string;
}

export interface CrossStats {
  documents: number;
  claims: number;
  /** Exhaustive cross-document pair count — the stage-4 baseline. */
  allPairsBaseline: number;
  candidatePairs: number;
  survivedTypeFilter: number;
  numericPairsCompared: number;
  arithmeticCandidates: number;
  findings: number;
  refine: RefineStats | null;
}

const TOP_K = 12;
const MIN_SIMILARITY = 0.72;

function toClaim(row: Record<string, unknown>, side: 'a' | 'b'): CrossClaim {
  return {
    id: String(row[`${side}_id`]),
    text: String(row[`${side}_text`]),
    subject: String(row[`${side}_subject`]),
    quantities: (row[`${side}_quantities`] ?? []) as Quantity[],
    charStart: row[`${side}_start`] as number | null,
    charEnd: row[`${side}_end`] as number | null,
    sectionPath: String(row[`${side}_path`]),
    arxivId: String(row[`${side}_arxiv`]),
    version: Number(row[`${side}_version`]),
    title: String(row[`${side}_title`]),
  };
}

/**
 * Retrieves cross-document candidate pairs over a corpus.
 *
 * Exhaustive comparison across a corpus is the cost that makes this approach impossible on a free
 * tier — a six-paper corpus runs to hundreds of thousands of pairs. Taking K neighbours per claim
 * keeps it linear, and the exhaustive count is recorded so the reduction is a measurement.
 */
async function generateCrossCandidates(arxivIds: string[]) {
  const result = await getDb().execute(sql`
    with corpus as (
      select c.id, c.document_id, c.embedding, c.claim_type, c.text, c.subject,
             c.quantities, c.char_start, c.char_end, c.section_id
      from claims c
      join documents d on d.id = c.document_id
      where d.arxiv_id = any(${sql.raw(`ARRAY[${arxivIds.map((id) => `'${id}'`).join(',')}]`)})
        and c.embedding is not null
    ),
    neighbours as (
      select a.id as a_id, b.id as b_id,
             1 - (a.embedding <=> b.embedding) as similarity,
             row_number() over (partition by a.id order by a.embedding <=> b.embedding) as rank
      from corpus a
      join corpus b
        -- Cross-document only; a paper's self-consistency is handled separately.
        on b.document_id <> a.document_id
    ),
    pairs as (
      select distinct on (least(a_id, b_id), greatest(a_id, b_id)) a_id, b_id, similarity
      from neighbours
      where rank <= ${TOP_K} and similarity >= ${MIN_SIMILARITY}
      order by least(a_id, b_id), greatest(a_id, b_id), similarity desc
    )
    select n.similarity,
      ca.id as a_id, cb.id as b_id,
      ca.text as a_text, cb.text as b_text,
      ca.claim_type as a_type, cb.claim_type as b_type,
      ca.subject as a_subject, cb.subject as b_subject,
      ca.quantities as a_quantities, cb.quantities as b_quantities,
      ca.char_start as a_start, ca.char_end as a_end,
      cb.char_start as b_start, cb.char_end as b_end,
      sa.path as a_path, sb.path as b_path,
      da.arxiv_id as a_arxiv, db.arxiv_id as b_arxiv,
      da.version as a_version, db.version as b_version,
      da.title as a_title, db.title as b_title
    from pairs n
    join claims ca on ca.id = n.a_id
    join claims cb on cb.id = n.b_id
    join sections sa on sa.id = ca.section_id
    join sections sb on sb.id = cb.section_id
    join documents da on da.id = ca.document_id
    join documents db on db.id = cb.document_id
    order by n.similarity desc
  `);

  return (result.rows as Record<string, unknown>[]).map((row) => ({
    similarity: Number(row['similarity']),
    aType: String(row['a_type']),
    bType: String(row['b_type']),
    a: toClaim(row, 'a'),
    b: toClaim(row, 'b'),
  }));
}

async function corpusSize(arxivIds: string[]): Promise<{ documents: number; claims: number }> {
  const result = await getDb().execute(sql`
    select count(distinct d.id)::int as documents, count(c.id)::int as claims
    from documents d
    join claims c on c.document_id = d.id and c.embedding is not null
    where d.arxiv_id = any(${sql.raw(`ARRAY[${arxivIds.map((id) => `'${id}'`).join(',')}]`)})
  `);
  const row = result.rows[0] as { documents: number; claims: number } | undefined;
  return { documents: Number(row?.documents ?? 0), claims: Number(row?.claims ?? 0) };
}

export async function detectCrossDocument(
  arxivIds: string[],
  options: RefineOptions = { classify: true, verify: true },
): Promise<{ stats: CrossStats; results: CrossFinding[] }> {
  if (arxivIds.length < 2) throw new Error('Cross-document detection needs at least two papers.');

  const { documents, claims } = await corpusSize(arxivIds);
  const candidates = await generateCrossCandidates(arxivIds);
  const typed = candidates.filter((c) => c.aType === c.bType);
  const numericPairs = typed.filter((c) => c.aType === 'NUMERIC');

  const arithmeticFindings: CrossFinding[] = [];
  let compared = 0;

  for (const pair of numericPairs) {
    let best: NumericConflict | undefined;
    for (const qa of pair.a.quantities) {
      for (const qb of pair.b.quantities) {
        if (!describesSameMeasurement(qa, qb)) continue;
        compared += 1;
        const conflict = findNumericConflict(qa, qb);
        if (!conflict) continue;
        if (!best || conflict.relativeDifference > best.relativeDifference) best = conflict;
      }
    }
    if (!best) continue;

    arithmeticFindings.push({
      conflictType: 'NUMERIC',
      confidence: conflictConfidence(best),
      rationale:
        `${best.a.metric ?? best.a.subject} for ${best.a.system ?? 'the same system'}` +
        `${best.a.dataset ? ` on ${best.a.dataset}` : ''} reported as ${best.a.value} in ` +
        `${pair.a.arxivId} but ${best.b.value} in ${pair.b.arxivId} — a difference of ` +
        `${best.difference.toPrecision(3)} (${(best.relativeDifference * 100).toFixed(1)}%).`,
      similarity: pair.similarity,
      a: pair.a,
      b: pair.b,
      conflict: best,
    });
  }

  const { results: refined, stats: refineStats } = await refineFindings(
    arithmeticFindings.map((f) => ({
      ...f,
      a: { ...f.a, sectionPath: `${f.a.arxivId} · ${f.a.sectionPath}` },
      b: { ...f.b, sectionPath: `${f.b.arxivId} · ${f.b.sectionPath}` },
    })),
    { ...options, deterministicConflict: true },
  );

  const reported = new Set(
    refined.filter((row) => row.reported).map((row) => `${row.finding.a.id}:${row.finding.b.id}`),
  );
  const results = arithmeticFindings.filter((f) => reported.has(`${f.a.id}:${f.b.id}`));

  // Every claim in one document against every claim in the others, counted once per pair.
  const perDocument = documents > 0 ? claims / documents : 0;
  const allPairsBaseline = Math.round((claims * (claims - perDocument)) / 2);

  return {
    stats: {
      documents,
      claims,
      allPairsBaseline,
      candidatePairs: candidates.length,
      survivedTypeFilter: typed.length,
      numericPairsCompared: compared,
      arithmeticCandidates: arithmeticFindings.length,
      findings: results.length,
      refine: refineStats,
    },
    results,
  };
}
