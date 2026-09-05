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

### Preliminary results

Measured 2026-09-05 on `gemini-3.1-flash-lite`, run `15538e3f`.

| Metric | Value |
|---|---|
| Injected contradictions | 6 |
| Detected | 1 |
| **Recall** | **16.7%** |
| Clean control papers | 3 |
| Findings on clean papers (all false by construction) | 0 |
| **False positives per clean paper** | **0.00** |
| Stage 5 (entailment) | enabled |
| Stage 6 (adversarial verifier) | enabled |
| LLM generate calls | 30 |
| Tokens | 183,137 |

| Conflict type | Injected | Detected | Recall |
|---|---|---|---|
| `NUMERIC` | 6 | 1 | 16.7% |

<!-- BENCHMARK:END -->

### Where it fails

The recall figure is bad, and it is the honest one. Six injections is far too few to estimate from,
but 1-in-6 is not a rounding artefact — the pipeline misses most contradictions it is handed, and
earlier informal results on hand-picked examples were considerably more flattering than this.

Known limitations, in rough order of how much they matter:

- **Only `NUMERIC` is implemented.** `DIRECTION`, `SCOPE` and `DEFINITIONAL` have no detector at
  all, so the taxonomy is declared but only a quarter of it is built. The per-type table below will
  stay single-row until they exist.
- **Misses are not yet attributed.** A miss can happen at four separate stages — the claim was never
  extracted, the two claims were never paired, the measurement labels disagreed, or the values were
  judged compatible — and the harness currently records only that it happened. Without that
  breakdown the recall number says nothing actionable about what to fix.
- **The corpus is three papers.** Both figures come from a sample small enough that a single
  additional paper could move them substantially.
- **The false-positive rate is measured on clean papers only.** 0.00 per paper is the number stages
  5 and 6 were built to move, and it is doing its job — but on this corpus the deterministic stage
  alone produced 116 candidates on one paper, so the reported figure depends entirely on those
  stages continuing to hold on unseen papers.
- **No ablation is recorded here.** The verifier on/off comparison PLAN.md calls the headline result
  needs a second run and is not yet in this table.

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
