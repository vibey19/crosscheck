# Crosscheck

A cross-document contradiction engine for scientific literature.

Given a set of related arXiv preprints, Crosscheck extracts atomic claims from each, cross-indexes
them, finds claims that contradict each other, verifies every hit with an adversarial second pass,
and renders a report where each finding quotes the exact span from both sources.

It is not a chatbot and not RAG question-answering. The output is a structured report.

## Status

**Phase 1 of 4 — claims and self-consistency.** Cross-document detection is not built yet.

The results table this README will eventually lead with does not exist, because the benchmark that
produces it has not been built. It will not be filled in with anything the harness did not measure.

What works today: fetch an arXiv paper, parse its LaTeX source into a section tree with character
offsets, extract atomic claims with structured measurement labels, embed them into pgvector, and
detect numeric self-inconsistencies within the paper.

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
