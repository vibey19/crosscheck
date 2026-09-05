# Crosscheck — project constraints

A contradiction-finding engine for scientific papers. Full brief: **`PLAN.md`**.
This file is the short reference for the constraints that govern the build — keep it ~a page.

**Current phase: Phase 1 complete; next is Phase 2 — cross-document detection.** Update as the project moves.

Phase 0: arXiv fetch + LaTeX parse producing a section tree with offsets, persisted to Neon.
Phase 1: batched claim extraction, pgvector embeddings, deterministic intra-document NUMERIC
detection. Ship criterion met — it finds the real 41.8-vs-41.0 EN-FR BLEU discrepancy in
1706.03762 as its only finding for that paper.

**Stage 5 is asked for subject-sameness, not for a verdict, on deterministic conflicts.**
Measured 2026-09-04: the same claim pair, same prompt, returned CONTRADICTS (0.95) from
gemini-3.7-flash and TENSION (0.85) from gemini-3.6-flash, with materially identical rationales.
The verdict label is model-unstable; `sameSubject` was correct in every case observed — it rejected
all 116 false positives on 2203.15556 and accepted the true positive on 1706.03762. Where the
arithmetic check already proves incompatibility, `refineFindings` is called with
`deterministicConflict: true` so only `sameSubject` gates the finding. Reverting that trades all
recall for no precision gain.

**Known: precision does not generalise yet.** The deterministic stage alone returns 116 findings on
2203.15556, essentially all false (comparing the Male row against the Female row, different
BIG-bench tasks, different columns of one table). Stage 5 removes all 116 while keeping the one
true finding on 1706.03762 — but that is two papers judged by eye, not a measurement. Stage 6 is
built and unmeasured. Do not quote a precision number until Phase 3 produces one.

Offsets are in *normalized-text space*, not raw LaTeX. Never store an offset without the
`parser_version` that produced it.

## What this is

Given a set of related arXiv preprints: extract atomic claims, cross-index them, find claims that
contradict each other, verify each hit with an adversarial second pass, and render a report where
every finding quotes exact spans from both sources.

**It is not a chatbot and not RAG question-answering.** There is no chat interface anywhere in this
project. The output is a structured report. If you find yourself building a message list, stop.

## The four-type conflict taxonomy — do not widen it

| Type | Definition |
|---|---|
| `NUMERIC` | Same quantity, incompatible values beyond a stated tolerance |
| `DIRECTION` | Direction-of-effect conflict — X improves Y vs. X degrades Y |
| `SCOPE` | A universal claim vs. a conditional one covering the same subject |
| `DEFINITIONAL` | Same term, incompatible definitions |

Anything outside these four is reported as **tension**, never asserted as a contradiction. The narrow
taxonomy is what makes the verifier and the benchmark tractable.

## Stack — every component free, no credit card

Next.js (App Router) + TypeScript · Neon Postgres + pgvector · Drizzle · `gemini-3.6-flash` ·
`gemini-embedding-001` @ 768 dims · Vercel Hobby (**set `maxDuration` explicitly**; legacy default is
10 s) · Auth.js anonymous session · GitHub Actions for the nightly eval. No blob storage.

### Do not use — with reasons

- **`text-embedding-004`** — deprecated 14 Jan 2026. Use `gemini-embedding-001`.
- **The entire `gemini-2.5-*` line** — returns 404 "no longer available to new users" (verified
  2026-09-04). It still appears in the `/models` listing, so listing a model is not proof a key can
  call it. PLAN.md specifies `gemini-2.5-flash`; that is stale. We pin `gemini-3.6-flash`, Google's
  named migration target.
- **Firebase / Firebase Storage** — requires the Blaze plan (a credit card) since 3 Feb 2026.
- **Supabase** — free tier pauses after a week idle and needs a *manual dashboard* unpause. Fatal for
  a cold demo link. Neon auto-resumes; that is the whole reason.
- **Pinecone** — unnecessary once pgvector is in Postgres. One less service to fail.
- **Stripe / payments / paywalls** — out of scope.

Do not silently swap a stack component. If one is unworkable, say so and raise it.

## arXiv terms of use — affects the schema

- **Never rehost e-prints.** Storing and serving arXiv PDFs or source from our servers is prohibited
  without the copyright holder's permission. We store extracted claims and character offsets only.
- **Always link back to arXiv** for the document itself.
- **One request per three seconds**, single connection. Not the S3 bulk buckets — requester-pays.

### Decided 2026-09-04 — `sections.raw_text` is dropped

PLAN.md's starting schema lists `sections.raw_text`, which contradicts the ToU promise above.
Resolved (schema is explicitly "a starting point, not a mandate"):

- `sections` stores structure, char offsets and a content hash — **never** persisted full text.
- `claims` store their own short quoted span, attributed and linked back. That is what the report needs.
- Full e-print text exists only in a gitignored, TTL'd local cache during a pipeline run. Never served.
- The dual-pane view re-fetches from arXiv on demand and highlights using the stored offsets.

This is sound because `documents` pins `arxiv_id` + `version`, and an arXiv version is immutable — so
offsets stay reproducible without us holding the text. `documents.parser_version` invalidates rows
loudly if the parser changes, rather than corrupting offsets silently.

## Gemini specifics — measured, not assumed (2026-09-04)

- **Always send `thinkingConfig: { thinkingLevel: 'low' }`** on extraction and classification.
  Reasoning tokens otherwise dominate: 654 tokens/call vs 158 for byte-identical output, a 4.1x
  difference that decides whether a corpus finishes inside the free tier.
- **`gemini-embedding-001` at 768 dims does NOT return normalised vectors** — measured L2 norm
  0.582. Only the 3072 default is pre-normalised. Normalise before inserting into pgvector, or
  every cosine distance is silently wrong.
- Structured output via `responseMimeType: 'application/json'` + `responseSchema` works and is the
  intended mechanism for stages 2 and 5.
- **The free-tier cap is 20 generate requests per DAY per model**, quota id
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. A 429's RetryInfo hint says ~40s, which is
  misleading — waiting does not help until the next day. Each model has its own allowance, so
  switching model is a way to keep working. Batch sections into one call and cache per section;
  a paper should cost ~3 calls, and re-running a cached paper zero.
- **The daily window is rolling, not calendar-day.** A model exhausted yesterday afternoon was still
  exhausted the next morning while others had recovered. Aliases share a pool: `gemini-flash-latest`
  went to 429 in lockstep with `gemini-3.8-flash`. Working pools observed 2026-09-05:
  gemini-3.5-flash, gemini-3.7-flash, gemini-3.1-flash-lite. Probe before planning a run — a 429
  costs no quota, so probing is free.
- **Embeddings are quota'd per TEXT, not per request, and have two ceilings**: 100 texts/minute and
  1000 texts/day (`embed_content_free_tier_requests`, reported with both limits at different times).
  The daily one is shared across models, so switching model does not help — it was the real ceiling
  all along while generate quota took the blame. Batching *against* a per-item quota is
  counterproductive: pacing must count texts (`ItemRateLimiter`), and vectors are cached in
  `embedding_cache` keyed on the exact text embedded, so re-analysis costs nothing.
- **Never delete stored state before its replacement is in hand.** This has now bitten twice: once
  where re-ingest deleted sections (cascading to claims) before extraction succeeded, and once where
  claim replacement deleted before embedding succeeded, so a quota rejection wiped an already
  extracted paper. Compute first, swap in a transaction.
- **Separate ingest from detection.** `analyze` re-extracts; `detect` and `corpus` run over stored
  claims for zero extraction cost. Extraction caches per model, so switching model re-pays it in
  full — that, not detection, is what burns a daily allowance.
- **Deciding that two numbers describe the same measurement must stay deterministic.** Embedding
  similarity cannot do it — "BLEU on newstest2013 dev" and "BLEU on WMT14 EN-DE" are near-identical
  as text and are different measurements. Quantities carry `metric`/`system`/`dataset` labels and
  `describesSameMeasurement` compares them by token set. Leaving this to similarity produced 17
  findings on one paper, all false.

## Non-negotiable practices

- **The eval harness outranks the UI. Phase 3 is never cut.** The measured recall / false-positive
  numbers are the point of this project; the working app is close to a side effect.
- **Instrument LLM call counts, token usage, and latency from commit one.** A reduction you never
  baselined cannot be reported later.
- **Stage 6 (adversarial verifier) must stay independently switchable** — the with/without ablation is
  the headline result.
- **Never commit debug logging.** No `console.log("DEBUG", ...)` survivors.
- **Keep the README honest.** Never report a number the harness didn't actually produce. State
  limitations plainly.
- Commit incrementally and meaningfully. No config values hardcoded in source.

## Anti-goals

No chat interface. No RAG Q&A. No payments. No signup wall. No rehosting arXiv e-prints. No widening
the taxonomy. No skipping Phase 3.
