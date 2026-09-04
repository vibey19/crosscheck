# Crosscheck — durable constraints

A contradiction-finding engine for scientific papers. Full brief: **`PLAN.md`** (read it before
non-trivial work). This file is the pointer that survives context loss — keep it ~a page.

**Current phase: Phase 0 — skeleton and ingest.** Update this line as the project moves.

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

Next.js (App Router) + TypeScript · Neon Postgres + pgvector · Drizzle · `gemini-2.5-flash` ·
`gemini-embedding-001` @ 768 dims · Vercel Hobby (**set `maxDuration` explicitly**; legacy default is
10 s) · Auth.js anonymous session · GitHub Actions for the nightly eval. No blob storage.

### Do not use — with reasons

- **`text-embedding-004`** — deprecated 14 Jan 2026. Use `gemini-embedding-001`.
- **Firebase / Firebase Storage** — requires the Blaze plan (a credit card) since 3 Feb 2026.
- **Supabase** — free tier pauses after a week idle and needs a *manual dashboard* unpause. Fatal for
  a cold demo link. Neon auto-resumes; that is the whole reason.
- **Pinecone** — unnecessary once pgvector is in Postgres. One less service to fail.
- **Stripe / payments / paywalls** — out of scope.

Do not silently swap a stack component. If one is unworkable, say so and ask.

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
