import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { candidatePairs, findings, type Quantity } from '../db/schema.js';
import { conflictConfidence, describesSameMeasurement, findNumericConflict, type NumericConflict } from './arithmetic.js';
import { refineFindings, type RefineOptions, type RefineStats } from './refine.js';

export interface DetectionStats {
  claims: number;
  /** Pairs an exhaustive comparison would have produced — the stage-4 baseline. */
  allPairsBaseline: number;
  candidatePairs: number;
  survivedTypeFilter: number;
  numericPairsCompared: number;
  /** Candidates produced by the deterministic arithmetic check, before stages 5 and 6. */
  arithmeticCandidates: number;
  findings: number;
  refine: RefineStats | null;
}

export interface IntraFinding {
  conflictType: 'NUMERIC';
  confidence: number;
  rationale: string;
  a: ClaimRow;
  b: ClaimRow;
  conflict: NumericConflict;
  similarity: number;
}

interface ClaimRow {
  id: string;
  text: string;
  claimType: string;
  subject: string;
  quantities: Quantity[];
  charStart: number | null;
  charEnd: number | null;
  sectionPath: string;
}

interface Candidate {
  a: ClaimRow;
  b: ClaimRow;
  similarity: number;
}

/** Neighbours retrieved per claim. */
const TOP_K = 12;
/** Below this cosine similarity, two claims are not about the same thing. */
const MIN_SIMILARITY = 0.72;


function toClaim(row: Record<string, unknown>, side: 'a' | 'b'): ClaimRow {
  return {
    id: String(row[`${side}_id`]),
    text: String(row[`${side}_text`]),
    claimType: String(row[`${side}_type`]),
    subject: String(row[`${side}_subject`]),
    quantities: (row[`${side}_quantities`] ?? []) as Quantity[],
    charStart: row[`${side}_start`] as number | null,
    charEnd: row[`${side}_end`] as number | null,
    sectionPath: String(row[`${side}_path`]),
  };
}

/**
 * Retrieves candidate claim pairs within one document using pgvector ANN.
 *
 * Comparing every claim against every other is quadratic and the single biggest cost in the
 * system. Taking a fixed K neighbours per claim keeps it linear in claim count; the exhaustive
 * figure is recorded alongside so the reduction can be reported rather than asserted.
 */
async function generateCandidates(documentId: string): Promise<Candidate[]> {
  const result = await getDb().execute(sql`
    with neighbours as (
      select
        a.id as a_id,
        b.id as b_id,
        1 - (a.embedding <=> b.embedding) as similarity,
        row_number() over (partition by a.id order by a.embedding <=> b.embedding) as rank
      from claims a
      join claims b
        on b.document_id = a.document_id and b.id <> a.id
      where a.document_id = ${documentId}
        and a.embedding is not null
        and b.embedding is not null
    ),
    pairs as (
      -- Neighbour retrieval is asymmetric: A may rank B in its top K without B ranking A. Dedupe
      -- on the unordered pair and keep the better similarity, rather than filtering on id order,
      -- which would silently drop every pair only one side retrieved.
      select distinct on (least(a_id, b_id), greatest(a_id, b_id))
        a_id, b_id, similarity
      from neighbours
      where rank <= ${TOP_K} and similarity >= ${MIN_SIMILARITY}
      order by least(a_id, b_id), greatest(a_id, b_id), similarity desc
    )
    select
      n.similarity,
      ca.id as a_id, cb.id as b_id,
      ca.text as a_text, cb.text as b_text,
      ca.claim_type as a_type, cb.claim_type as b_type,
      ca.subject as a_subject, cb.subject as b_subject,
      ca.quantities as a_quantities, cb.quantities as b_quantities,
      ca.char_start as a_start, ca.char_end as a_end,
      cb.char_start as b_start, cb.char_end as b_end,
      sa.path as a_path, sb.path as b_path
    from pairs n
    join claims ca on ca.id = n.a_id
    join claims cb on cb.id = n.b_id
    join sections sa on sa.id = ca.section_id
    join sections sb on sb.id = cb.section_id
    order by n.similarity desc
  `);

  return (result.rows as Record<string, unknown>[]).map((row) => ({
    similarity: Number(row['similarity']),
    a: toClaim(row, 'a'),
    b: toClaim(row, 'b'),
  }));
}

async function countClaims(documentId: string): Promise<number> {
  const result = await getDb().execute(sql`
    select count(*)::int as count from claims
    where document_id = ${documentId} and embedding is not null
  `);
  return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
}

/**
 * Runs intra-document self-consistency detection.
 *
 * Only NUMERIC conflicts are decided, and only by the deterministic arithmetic check — no model
 * judges a verdict here, so results are reproducible. Entailment classification and the adversarial
 * verifier arrive in Phase 2.
 */
export async function detectIntraDocument(
  documentId: string,
  options: RefineOptions = { classify: true, verify: true },
): Promise<{ stats: DetectionStats; results: IntraFinding[] }> {
  const db = getDb();

  const claims = await countClaims(documentId);
  const candidates = await generateCandidates(documentId);
  const typed = candidates.filter((c) => c.a.claimType === c.b.claimType);
  const numericPairs = typed.filter((c) => c.a.claimType === 'NUMERIC');

  const arithmeticFindings: IntraFinding[] = [];
  let compared = 0;

  for (const pair of numericPairs) {
    let best: { conflict: NumericConflict } | undefined;

    for (const qa of pair.a.quantities) {
      for (const qb of pair.b.quantities) {
        // Deterministic: same metric, same system, compatible dataset. No model judges this.
        if (!describesSameMeasurement(qa, qb)) continue;

        compared += 1;
        const conflict = findNumericConflict(qa, qb);
        if (!conflict) continue;
        // Keep the widest disagreement for the pair rather than the first found.
        if (!best || conflict.relativeDifference > best.conflict.relativeDifference) best = { conflict };
      }
    }

    if (!best) continue;
    const { conflict } = best;
    arithmeticFindings.push({
      conflictType: 'NUMERIC',
      confidence: conflictConfidence(conflict),
      rationale:
        `${conflict.a.metric ?? conflict.a.subject} for ${conflict.a.system ?? 'the same system'}` +
        `${conflict.a.dataset ? ` on ${conflict.a.dataset}` : ''} reported as ${conflict.a.value} ` +
        `in "${pair.a.sectionPath}" but ` +
        `${conflict.b.value} in "${pair.b.sectionPath}" — a difference of ${conflict.difference.toPrecision(3)} ` +
        `(${(conflict.relativeDifference * 100).toFixed(1)}%), beyond the ${conflict.tolerance.toPrecision(2)} rounding tolerance.`,
      a: pair.a,
      b: pair.b,
      conflict,
      similarity: pair.similarity,
    });
  }

  // Stages 5 and 6. Everything above this line is deterministic.
  // These candidates come from the deterministic arithmetic check, so stage 5 judges subject
  // sameness only.
  const { results: refined, stats: refineStats } = await refineFindings(arithmeticFindings, {
    ...options,
    deterministicConflict: true,
  });
  const results = refined.filter((row) => row.reported).map((row) => row.finding);

  // Replace prior results for this document so re-running is idempotent.
  await db.execute(sql`
    delete from findings where pair_id in (
      select cp.id from candidate_pairs cp
      join claims c on c.id = cp.claim_a_id
      where cp.scope = 'intra' and c.document_id = ${documentId})
  `);
  await db.execute(sql`
    delete from candidate_pairs where scope = 'intra' and claim_a_id in (
      select id from claims where document_id = ${documentId})
  `);

  if (candidates.length > 0) {
    const inserted = await db
      .insert(candidatePairs)
      .values(
        candidates.map((c) => ({
          claimAId: c.a.id,
          claimBId: c.b.id,
          similarity: c.similarity,
          survivedTypeFilter: c.a.claimType === c.b.claimType,
          scope: 'intra',
        })),
      )
      .returning({ id: candidatePairs.id, a: candidatePairs.claimAId, b: candidatePairs.claimBId });

    const pairId = new Map(inserted.map((row) => [`${row.a}:${row.b}`, row.id]));

    if (results.length > 0) {
      await db.insert(findings).values(
        results.map((finding) => ({
          pairId: pairId.get(`${finding.a.id}:${finding.b.id}`)!,
          conflictType: finding.conflictType,
          verdict: 'CONTRADICTS',
          confidence: finding.confidence,
          rationale: finding.rationale,
          detector: options.classify || options.verify ? 'arithmetic+llm' : 'arithmetic',
          verifierPassed: options.verify ? true : null,
          spans: {
            a: { claimId: finding.a.id, text: finding.a.text, charStart: finding.a.charStart, charEnd: finding.a.charEnd, section: finding.a.sectionPath },
            b: { claimId: finding.b.id, text: finding.b.text, charStart: finding.b.charStart, charEnd: finding.b.charEnd, section: finding.b.sectionPath },
          },
        })),
      );
    }
  }

  return {
    stats: {
      claims,
      allPairsBaseline: (claims * (claims - 1)) / 2,
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
