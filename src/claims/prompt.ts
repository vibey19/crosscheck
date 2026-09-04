import { CONFLICT_TYPES } from '../db/schema.js';

/**
 * Bumped whenever the prompt or response schema changes. It is part of the extraction cache key,
 * so a change invalidates cached claims instead of silently serving results the current prompt
 * would never have produced.
 */
export const PROMPT_VERSION = '5';

export const EXTRACTION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      sectionPath: { type: 'STRING' },
      quote: { type: 'STRING' },
      claimType: { type: 'STRING', enum: [...CONFLICT_TYPES] },
      subject: { type: 'STRING' },
      quantities: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            value: { type: 'NUMBER' },
            unit: { type: 'STRING' },
            subject: { type: 'STRING' },
            metric: { type: 'STRING' },
            dataset: { type: 'STRING' },
            system: { type: 'STRING' },
          },
          required: ['value', 'subject', 'metric', 'system'],
        },
      },
    },
    required: ['sectionPath', 'quote', 'claimType', 'subject'],
  },
} as const;

export interface ExtractedClaim {
  /** Echoed back so claims from a multi-section batch can be attributed to their section. */
  sectionPath: string;
  quote: string;
  claimType: (typeof CONFLICT_TYPES)[number];
  subject: string;
  quantities?: {
    value: number; unit?: string; subject: string;
    metric?: string; dataset?: string; system?: string;
  }[];
}

export interface SectionInput {
  path: string;
  text: string;
}

/**
 * Builds one prompt covering several sections.
 *
 * The free tier allows 20 generate requests per day per model, so a call per section would spend a
 * day's quota on a single paper. Batching sections into one call is what makes the pipeline usable
 * at all; each claim echoes its section path so attribution survives.
 */
export function buildExtractionPrompt(sections: SectionInput[]): string {
  const body = sections
    .map((section) => `<<<SECTION ${section.path}>>>\n${section.text}`)
    .join('\n\n');
  const paths = sections.map((s) => `  - ${s.path}`).join('\n');

  return `You extract atomic factual claims from a scientific paper, for a tool that detects
contradictions between claims.

You are given several sections, each introduced by a <<<SECTION path>>> marker. Process all of them.
Set "sectionPath" on every claim to the exact path from the marker it came from, one of:
${paths}

Extract only claims that could objectively conflict with another claim. There are exactly four kinds:

- NUMERIC: reports a measured quantity. "Reaches 41.8 BLEU on EN-FR."
- DIRECTION: asserts a direction of effect. "Increasing depth reduces perplexity."
- SCOPE: asserts how broadly something holds, universal or conditional. "In all settings tested, X holds."
- DEFINITIONAL: defines a term or quantity. "We define compute-optimal as minimising loss for a fixed FLOP budget."

Rules:

1. "quote" MUST be copied VERBATIM, character for character, from the section text below. Do not
   paraphrase, correct, reformat, or fix typos. It is used to locate the claim in the source, and a
   quote that is not present word-for-word is discarded.
2. Keep each quote as short as possible while remaining a complete, checkable statement.
3. "subject" is your own canonical description of what the claim is about, precise enough that two
   claims about the same measurement get the same subject. Include the metric, dataset or task, and
   the system it refers to. Example: "BLEU, WMT14 EN-FR, Transformer (big)".
4. For NUMERIC claims fill "quantities" with every number in the claim. Use the plain number: 41.8,
   not "41.8 BLEU". Write 3.3e18 for 3.3 * 10^18. For each number also give:
     - "unit":    the unit if there is one. "hours", "days", "steps", "parameters", "%". Leave it
                  out only for genuinely unitless metrics such as BLEU or F1. Never convert: report
                  12 hours as 12 with unit "hours", not 0.5 with unit "days".
     - "metric":  precisely what is measured. Use the paper's OWN symbol or name when it has one.
                  Write "d_model", "d_k", "d_ff" — never a generic word like "dimension" that would
                  collapse three different quantities into one. Two numbers measuring different
                  things MUST NOT share a metric.
     - "system":  what it was measured on, INCLUDING the configuration or training regime that
                  distinguishes it from neighbouring rows: "Transformer (big)",
                  "Transformer (4 layers), semi-supervised", "Transformer (4 layers), WSJ only".
                  If the paper reports one unnamed model, use "ours".
     - "dataset": the exact evaluation set INCLUDING the split. "WMT14 EN-FR test",
                  "newstest2013 dev", "WSJ section 23". REQUIRED whenever the number is a score
                  measured on data — if the sentence names a task, benchmark, language pair or
                  test set, that name belongs here, and this holds just as much in the abstract as
                  in a results table. Omit it ONLY for quantities that are not measured on data at
                  all, such as an architecture constant like d_model or a parameter count.
   These fields decide whether two numbers describe the same measurement. Ask yourself: if another
   number in this paper got the same metric, system and dataset, would it have to be equal to this
   one? If not, the labels are not specific enough.
5. Tables appear as pipe-separated rows. Extract cell values as NUMERIC claims, quoting the whole
   row verbatim as it appears, and use "subject" to say which column and row the number came from.
6. Extract claims the paper makes about ITS OWN work or its own reported results. Skip descriptions
   of prior work, motivation, future work, and limitations.
7. Be exhaustive within each section. Extract every distinct claim, including every row of a
   results table, not just the most prominent one.
8. If a section contains no such claims, simply return no claims for it. Return an empty array only
   if no section yields any.

Sections:
"""
${body}
"""`;
}
