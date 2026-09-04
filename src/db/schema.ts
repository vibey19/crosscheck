import { sql } from 'drizzle-orm';
import {
  check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 0 covers `documents` and `sections` only. Later phases add claims, candidate_pairs,
 * findings, eval_runs and injections.
 *
 * Note what is deliberately absent: section text. arXiv's terms of use prohibit storing and
 * serving e-prints, so a section records where its text lives, not the text itself. See CLAUDE.md.
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
