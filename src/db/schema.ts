import { sql } from 'drizzle-orm';
import {
  boolean, check, doublePrecision, index, integer, jsonb, pgTable, real, text, timestamp,
  uniqueIndex, uuid, vector,
} from 'drizzle-orm/pg-core';

/**
 * Must match GEMINI_EMBEDDING_DIMS. A vector column's width is fixed in DDL, so changing the env
 * var alone is not enough — it needs a migration.
 */
export const EMBEDDING_DIMS = 768;

/** The four objectively checkable conflict types. Do not widen — see docs/constraints.md. */
export const CONFLICT_TYPES = ['NUMERIC', 'DIRECTION', 'SCOPE', 'DEFINITIONAL'] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

/**
 * A measured value, labelled well enough to decide *deterministically* whether two numbers describe
 * the same measurement.
 *
 * Embedding similarity cannot make that call: "BLEU on newstest2013 dev" and "BLEU on WMT14 EN-DE"
 * are near-identical as text but are different measurements, and comparing them produces confident
 * nonsense. Splitting the label into fields lets the comparison stay arithmetic — the model only
 * labels, it never judges the conflict.
 */
export interface Quantity {
  value: number;
  unit: string | null;
  /** Free-text description, kept for display in a finding. */
  subject: string;
  /** What was measured: "BLEU", "F1", "training steps". */
  metric: string | null;
  /** What was measured on: "WMT14 EN-FR", "newstest2013 dev", "WSJ". */
  dataset: string | null;
  /** What was measured: "Transformer (big)", "GNMT + RL". */
  system: string | null;
}

/**
 * Phase 0 covers `documents` and `sections` only. Later phases add claims, candidate_pairs,
 * findings, eval_runs and injections.
 *
 * Note what is deliberately absent: section text. arXiv's terms of use prohibit storing and
 * serving e-prints, so a section records where its text lives, not the text itself. See docs/constraints.md.
 */

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arxivId: text('arxiv_id').notNull(),
    /** Always concrete. A bare id follows the latest revision, which would unpin every offset. */
    version: integer('version').notNull(),
    title: text('title').notNull(),
    /** Offsets are only meaningful alongside the parser that produced them. */
    parserVersion: text('parser_version').notNull(),
    /** Hash of the normalised text, so a re-fetch can prove offsets still line up. */
    contentHash: text('content_hash').notNull(),
    /** Length of the normalised text; cheap sanity check against a re-parse. */
    textLength: integer('text_length').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('documents_arxiv_id_version_idx').on(table.arxivId, table.version)],
);

export const sections = pgTable(
  'sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** Numbered path, e.g. `3.1 Ablation`. */
    path: text('path').notNull(),
    title: text('title').notNull(),
    level: integer('level').notNull(),
    /** Reading order within the document. */
    ordinal: integer('ordinal').notNull(),
    /** Half-open [charStart, charEnd) into the document's normalised text. */
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    contentHash: text('content_hash').notNull(),
  },
  (table) => [
    uniqueIndex('sections_document_ordinal_idx').on(table.documentId, table.ordinal),
    index('sections_document_idx').on(table.documentId),
    // Offsets must describe a real, forward span. Enforced in the database because a corrupted
    // offset is silent everywhere else until a report quotes the wrong sentence.
    check('sections_span_valid', sql`${table.charEnd} > ${table.charStart} and ${table.charStart} >= 0`),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Section = typeof sections.$inferSelect;
export type NewSection = typeof sections.$inferInsert;


/**
 * Extracted claims.
 *
 * `text` holds the claim's own short verbatim quote — a short attributed quotation linked back to
 * arXiv, which is what a finding must show. Full section text is still never stored.
 */
export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Denormalised from sections: intra-document detection filters on it constantly. */
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Offsets into the document's normalised text, or null when the span could not be located. */
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    /**
     * False when the model paraphrased and the quote could not be found verbatim in the source.
     * Tracked rather than dropped: the rate is a quality signal worth reporting.
     */
    spanResolved: boolean('span_resolved').notNull().default(false),
    claimType: text('claim_type').notNull(),
    /** What the claim is about, used to decide whether two numbers describe the same thing. */
    subject: text('subject').notNull(),
    quantities: jsonb('quantities').$type<Quantity[]>().notNull().default([]),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }),
    contentHash: text('content_hash').notNull(),
  },
  (table) => [
    index('claims_document_idx').on(table.documentId),
    index('claims_section_idx').on(table.sectionId),
    index('claims_type_idx').on(table.claimType),
    // HNSW over cosine distance. Vectors are L2-normalised before insert, without which this
    // index returns confident nonsense rather than an error.
    index('claims_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
);

/**
 * Memoised section extractions.
 *
 * Keyed on the section's content hash plus the model and prompt that produced the result, so a
 * prompt change invalidates rather than silently serving stale claims. This is what keeps repeated
 * runs inside a free-tier daily cap.
 */
export const extractionCache = pgTable(
  'extraction_cache',
  {
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    claims: jsonb('claims').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('extraction_cache_key_idx').on(table.contentHash, table.model, table.promptVersion),
  ],
);

/**
 * Memoised stage-5 classifications, keyed on the pair's text plus model and prompt version.
 *
 * Beyond saving quota, this is what makes the verifier ablation honest: both arms consume the
 * identical set of stage-5 verdicts, so the only difference between them is stage 6.
 */
export const classificationCache = pgTable(
  'classification_cache',
  {
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('classification_cache_key_idx').on(table.contentHash, table.model, table.promptVersion),
  ],
);

/**
 * Memoised stage-6 verifications.
 *
 * Stage 6 decides what gets reported, so its decisions have to be inspectable after the fact —
 * a rejection that cannot be examined is indistinguishable from a bug. Caching also keeps the
 * ablation's two arms comparable and cheap under a 20-request daily cap.
 */
export const verificationCache = pgTable(
  'verification_cache',
  {
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('verification_cache_key_idx').on(table.contentHash, table.model, table.promptVersion),
  ],
);

/** Claim pairs that survived candidate generation — the stage-4 cost killer. */
export const candidatePairs = pgTable(
  'candidate_pairs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimAId: uuid('claim_a_id').notNull().references(() => claims.id, { onDelete: 'cascade' }),
    claimBId: uuid('claim_b_id').notNull().references(() => claims.id, { onDelete: 'cascade' }),
    /** Cosine similarity at retrieval time. */
    similarity: real('similarity').notNull(),
    survivedTypeFilter: boolean('survived_type_filter').notNull(),
    /** 'intra' for self-consistency, 'cross' for cross-document. */
    scope: text('scope').notNull(),
  },
  (table) => [
    uniqueIndex('candidate_pairs_unique_idx').on(table.claimAId, table.claimBId),
    index('candidate_pairs_scope_idx').on(table.scope),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pairId: uuid('pair_id').notNull().references(() => candidatePairs.id, { onDelete: 'cascade' }),
    conflictType: text('conflict_type').notNull(),
    /** CONTRADICTS | TENSION. Anything outside the taxonomy is tension, never a contradiction. */
    verdict: text('verdict').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    rationale: text('rationale').notNull(),
    /** Which detector produced it: 'arithmetic' is deterministic, with no model in the loop. */
    detector: text('detector').notNull(),
    /** Null until the Phase 2 adversarial verifier runs; the ablation switches that stage off. */
    verifierPassed: boolean('verifier_passed'),
    spans: jsonb('spans').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('findings_pair_idx').on(table.pairId),
    index('findings_type_idx').on(table.conflictType),
  ],
);

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type CandidatePair = typeof candidatePairs.$inferSelect;
export type Finding = typeof findings.$inferSelect;
