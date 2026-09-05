# Crosscheck

A cross-document contradiction engine for scientific literature.

Given a set of related arXiv preprints, Crosscheck extracts atomic claims from each, cross-indexes
them, finds claims that contradict each other, verifies every hit with an adversarial second pass,
and renders a report where each finding quotes the exact span from both sources.

It is not a chatbot and not RAG question-answering. The output is a structured report.

## Results

Everything below is written by the benchmark harness from a recorded run. No number here is
hand-entered, and anything not measured says so.

<!-- BENCHMARK:START -->

_No benchmark run has been recorded yet._

<!-- BENCHMARK:END -->

**How the labels are made.** A clean paper states some figure twice — in its abstract and again in a
results table, say. The harness changes one mention beyond any rounding tolerance and records
exactly which characters it altered. That produces a document known to contain exactly one
contradiction, at a known offset, so a detection is scored by comparing character spans rather than
by asking a model whether it found the right thing.

Sites are chosen from the surface text alone. Selecting them with the detector's own notion of
"the same measurement" would only inject where the detector can already match, and the resulting
recall figure would be circular.

## Status

**Phases 0-2 built; Phase 3 (the benchmark) in progress.** No interface yet.

What works today: fetch an arXiv paper, parse its LaTeX source into a section tree with character
offsets, extract atomic claims with structured measurement labels, embed them into pgvector, detect
numeric contradictions within a paper and across a corpus, and filter them through an entailment
classifier and an adversarial verifier.

On *Attention Is All You Need*, it reports one finding: Table 2 gives 41.8 BLEU for the big model
on WMT14 EN-FR, while the prose below it says 41.0.

## Conflict taxonomy

Detection is deliberately restricted to four objectively checkable conflict types. Anything outside
them is reported as *tension*, never asserted as a contradiction.

| Type | Definition |
|---|---|
| `NUMERIC` | Same quantity, incompatible values beyond a stated tolerance |
| `DIRECTION` | Direction-of-effect conflict — X improves Y vs. X degrades Y |
| `SCOPE` | A universal claim vs. a conditional one covering the same subject |
| `DEFINITIONAL` | Same term, incompatible definitions |

## Setup

Requires Node 22+, a [Neon](https://neon.com) Postgres database, and a
[Google AI Studio](https://aistudio.google.com) API key. Both have free tiers that need no card.

```bash
npm install
cp .env.example .env.local   # then fill in the three blank values
npm run db:migrate
```

## Usage

```bash
npm run crosscheck -- ingest  2203.15556              # print the section tree
npm run crosscheck -- ingest  2203.15556 --preview 200 # with text previews
npm run crosscheck -- ingest  2203.15556 --save       # persist to Postgres

npm run crosscheck -- analyze 1706.03762              # extract claims and check self-consistency
npm run crosscheck -- analyze 1706.03762 --json       # machine-readable, includes usage metrics

npm test                                              # deterministic detector tests
```

Accepts `2301.12345`, `2301.12345v2`, `math/0309136`, or an arxiv.org URL. Without an explicit
version, the current one is resolved and pinned — offsets are only meaningful against an immutable
source.

## On stored content

Crosscheck never rehosts arXiv e-prints, as their
[terms of use](https://info.arxiv.org/help/api/tou.html) require. The database holds section
structure, character offsets and hashes — not paper text. Full source is fetched on demand into a
gitignored, TTL'd local cache that is never served, and every request is rate limited to arXiv's
one-per-three-seconds ceiling on a single connection.

## Running the benchmark

```bash
npm run crosscheck -- eval 1706.03762 2001.08361 2203.15556 --per-paper 3 --seed 42
npm run eval:write-results        # rewrites the results block above from the recorded run
```

`--no-verifier` and `--no-classifier` switch stages 6 and 5 off, which is how the ablation is run:
both arms are the same program with one stage disabled, not two different programs.

A nightly GitHub Action re-runs it and commits the table if it moved. It needs `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `GEMINI_API_KEY` and `ARXIV_USER_AGENT` as repository secrets.

## Layout

```
src/config.ts          env loading and validation
src/instrument/        LLM call, token and latency metering
src/ingest/arxiv/      rate-limited fetching, metadata, e-print extraction
src/ingest/latex/      include resolution, AST walk, text normalisation
src/llm/               metered Gemini client, rate limiting, retries
src/claims/            extraction prompt, caching, span location
src/detect/            deterministic arithmetic check, candidate generation
src/db/                Drizzle schema, client, migrations
src/cli/               command-line entry point
```

## Free-tier limits worth knowing

The Gemini free tier allows **20 generate requests per day, per model** — not per minute, despite
what a 429's retry hint implies. Extraction therefore batches many sections into one call and
memoises per section on content hash; a paper costs about three calls, and re-running one costs
none. Each model carries its own separate daily allowance.

See `docs/constraints.md` for project constraints and `PLAN.md` for the full brief.
