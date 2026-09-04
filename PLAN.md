# Crosscheck — Project Plan

A contradiction-finding tool for research papers.

This document has three parts:
- **Part 1** explains what we're building, in plain language. Read this first.
- **Part 2** is the technical brief.
- **Part 3** is how to start.

Read all three parts before starting. Part 2 contains design decisions that were researched and
verified. Several of them contradict the obvious default choice, and the reasons are given each
time. Do not silently substitute familiar alternatives.

---
---

# Part 1 — What this is, in plain terms

## The problem

Research papers state facts. Sometimes those facts disagree, in two different ways.

**1. A paper disagrees with itself.**
The abstract says "our method reaches 96.1% accuracy." Table 3 in the results says 91.4%. Someone
updated one number and forgot the other. This is extremely common in real published papers.

**2. Two papers disagree with each other.**
Paper A says the optimal training ratio is 20 tokens per parameter. Paper B says training well beyond
that keeps improving results. If you're reading both, that's a conflict you need to notice.

Catching either by hand means reading everything closely and holding it all in your head. People are
bad at this.

## What the tool does

You give it a few paper links. It reads them, pulls out every factual statement, compares those
statements against each other, and shows you the ones that clash — with the exact sentence from each
source side by side, so you can check it yourself in ten seconds.

**Using it:**

1. Paste 5 arXiv links about the same topic. Click Run.
2. Wait about two minutes while it processes.
3. Get a report: "3 contradictions found." Each shows the two conflicting quotes, linked back to source.

That's the entire product. No chat box. No questions to type. You give it documents, it gives you a
list of problems.

## Why we're building it this way

This is a portfolio project. Its purpose is to be *measurably* good, not feature-rich.

Here's the trick that makes that possible. Take a clean paper and deliberately break it: change
"91.4%" to "96.1%" in the conclusion so it now contradicts its own results table. Now you know for
certain that this document contains exactly one contradiction, and exactly where it is. Do that 200
times across many papers, run the tool, and count how many it caught.

That produces a real number: *"catches 87% of injected contradictions, with a 4% false-alarm rate."*

A portfolio project with a measured quality number is rare at any experience level. **That number is
the point of this project. The working app is almost a side effect.** This is why Part 2 insists the
evaluation harness matters more than the user interface — and it genuinely does.

## Words used later in this document

| Term | What it means here |
|---|---|
| **Claim** | One single factual statement pulled out of a paper. "The model reached 91% accuracy" is one claim. |
| **Embedding** | Turning a sentence into a list of numbers, so that sentences with similar meanings end up with similar numbers. Lets you find related sentences fast. |
| **Vector search / pgvector** | Searching by meaning rather than keyword, using those numbers. `pgvector` is the Postgres extension that does it. |
| **Entailment** | The core question we ask about two claims: do they agree, contradict, or have nothing to do with each other? |
| **Verifier** | A second check that actively tries to *disprove* a contradiction we found, to cut down false alarms. |
| **False positive / false alarm** | The tool reports a contradiction that isn't real. The main thing we want to minimise. |
| **Recall** | Of the real contradictions that exist, what fraction did we catch? |
| **Precision** | Of the contradictions we reported, what fraction were real? |
| **Benchmark / eval** | The test set and the script that measures the two numbers above. |
| **Ablation** | Running the system with one component switched off, to prove that component actually helps. |
| **LaTeX source** | The raw typesetting files authors submit to arXiv. Much easier to parse accurately than the finished PDF. |
| **Free tier** | The no-cost usage level of a hosted service. Everything in this project must stay inside one, with no credit card. |

---
---

# Part 2 — The technical brief

## Product definition

**Crosscheck** — a cross-document contradiction engine for scientific literature.

Given a set of related arXiv preprints: extract atomic claims from each, cross-index them, find claims
that contradict each other, verify each hit with an adversarial second pass, and render a report where
every finding quotes exact spans from both sources.

Two modes:

- **Intra-document (self-consistency)** — does a paper's abstract agree with its own results tables and
  conclusion? Objectively checkable, catches real errors in real published papers, fastest demo to
  land. **Build this first.**
- **Cross-document** — contradictions across a corpus on the same topic. The headline capability.

**This is not a chatbot and not RAG question-answering.** There is no chat interface anywhere in this
project. The output is a structured report. If you find yourself building a message list, stop.

## The conflict taxonomy — the key design move

Scientific disagreement is genuinely subjective, which normally destroys any evaluation story. We
avoid that by refusing to classify "contradiction" in general. Detect only these four objectively
checkable types:

| Type | Definition |
|---|---|
| `NUMERIC` | Same quantity, incompatible values beyond a stated tolerance |
| `DIRECTION` | Direction-of-effect conflict — X improves Y vs. X degrades Y |
| `SCOPE` | A universal claim vs. a conditional one covering the same subject |
| `DEFINITIONAL` | Same term, incompatible definitions |

Anything outside these four is reported as **tension**, never asserted as a contradiction. Narrowing
the taxonomy is what makes both the verifier and the benchmark tractable. **Do not widen it.**

## Architecture — seven stages

**1. Ingest via LaTeX source, not PDF.**
arXiv ships e-print source tarballs. Parsing LaTeX gives real section structure, table cells, and
numeric values with units — skipping the PDF-extraction misery most projects in this space wade
through. Fall back to PDF text only when source is unavailable.

**2. Atomic claim extraction.**
One batched LLM call per section returns self-contained claims, each with: character span, section
path, conflict-relevant type, and extracted quantities with units. Cache keyed on content hash — never
extract the same section twice.

**3. Embed and index claims.**
Claims, not chunks, are the unit of retrieval. This is what makes stage 4 precise. Store in pgvector.

**4. Candidate generation — the cost killer.**
Naive all-pairs entailment over a six-paper corpus is O(n²) in claims: roughly 400,000 LLM calls.
Impossible on a free tier. Instead: ANN-search each claim against claims from *other* documents, keep
top-K, then apply a cheap type-compatibility filter (a `NUMERIC` claim can only conflict with another
`NUMERIC` claim about the same quantity).
**Instrument call counts and token usage from the very first commit** — we need the before/after
number and it cannot be reconstructed later.

**5. Entailment classification.**
Batched classification of surviving pairs into `ENTAILS` / `CONTRADICTS` / `NEUTRAL`, plus conflict
type and a one-line rationale. Structured output, low temperature.

**6. Adversarial verification — the precision lever.**
Only `CONTRADICTS` proceeds. A second pass is instructed to argue *against* the contradiction and must
quote the exact spans establishing it; if it can't, drop the finding. `NUMERIC` conflicts additionally
get a deterministic arithmetic check with no model in the loop. **This stage must be independently
switchable** — the with/without ablation is the headline result.

**7. Report.**
Dual-pane view, spans highlighted in context, every source linked back to arXiv, findings sorted by
confidence and filterable by type.

## The evaluation harness — the keystone

An injection script mutates clean papers in controlled ways, recording each mutation's location and
type to produce exact labels:

- flip a numeric value beyond tolerance
- negate a direction of effect
- broaden a conditional claim into a universal one
- redefine a term mid-document

Then measure:

- **Recall per conflict type.** Expect `NUMERIC` near-perfect and `SCOPE` weakest; that asymmetry is
  itself a finding worth writing up.
- **False-positive rate on a clean control corpus** — unmutated papers, where every finding is by
  construction a false positive. This is the number stage 6 is designed to move.
- **Ablation: verifier on vs. off** — same benchmark, stage 6 disabled. This delta is the headline.
- **LLM calls and tokens per document set** — before and after the stage-4 filter.
- **A ~50-pair human-labelled set** of real cross-paper claims, for external validity. If synthetic
  recall doesn't transfer to real pairs, report that honestly — the gap is interesting, not shameful.

Wire this to a GitHub Action that runs nightly and rewrites a results table into the README.

## Stack — every component free, no credit card

Verified September 2026. Re-verify anything time-sensitive before relying on it.

| Layer | Use | Notes |
|---|---|---|
| Runtime | Next.js (App Router) + TypeScript | Deploys free on Vercel |
| DB + vectors | **Neon Postgres + pgvector** | 0.5 GB, 100 compute-hrs/mo, no card, never expires, auto-resumes in ms |
| ORM | Drizzle | TS-native, lightweight |
| LLM | **gemini-2.5-flash** | Free tier, no card |
| Embeddings | **gemini-embedding-001 @ 768 dims** | 3072 by default; use `output_dimensionality` to cut storage 4× |
| Hosting | Vercel Hobby | 300 s functions with Fluid Compute — **set `maxDuration` explicitly**, legacy default is 10 s |
| Blob storage | **None** | Store claims + character offsets only; fetch source from arXiv on demand |
| Auth | Auth.js — anonymous session, optional GitHub OAuth | No signup wall on the demo, ever |
| CI / cron | GitHub Actions | Free for public repos; runs the nightly eval |

### Do not use — these are traps, with reasons

- **`text-embedding-004`** — deprecated 14 Jan 2026. Use `gemini-embedding-001`.
- **Firebase / Firebase Storage** — Cloud Storage for Firebase has required the Blaze plan (a credit
  card) since 3 Feb 2026, and existing Spark projects lost read/write access. Violates the free
  constraint outright.
- **Supabase** — the free tier pauses after a week of inactivity and needs a *manual dashboard*
  unpause. Fatal when someone opens the demo link cold. Neon auto-resumes; that is the whole reason.
- **Pinecone** — unnecessary once pgvector is in Postgres. One less service, one less failure mode.
- **Stripe / payments / paywalls** — noise in a portfolio project. Not in scope.

Gemini free-tier daily request caps are real and moved during 2026. Check the current limits and
design around them: batch aggressively in stages 2 and 5, cache by content hash, and make the pipeline
resumable so hitting a cap doesn't lose work.

## Legal constraint — affects the schema, read before designing it

arXiv's API terms of use **prohibit storing and serving their e-prints from your own servers** without
the copyright holder's permission, and require linking back to arXiv for downloads. Our architecture
complies because it never rehosts a paper — it stores extracted claims and character offsets, and
links out. Keep it that way.

Also: **one request per three seconds** on the legacy arXiv API. Don't use the S3 bulk buckets — they
are requester-pays and therefore not free.

## Starting schema

```
documents        (arxiv_id, title, version, fetched_at)
sections         (document_id, path, char_start, char_end, raw_text)
claims           (section_id, text, char_start, char_end, claim_type,
                  quantities jsonb, embedding vector(768), content_hash)
candidate_pairs  (claim_a_id, claim_b_id, similarity, survived_type_filter)
findings         (pair_id, conflict_type, verdict, confidence, rationale,
                  verifier_passed, spans jsonb)
eval_runs        (started_at, config jsonb, metrics jsonb, verifier_enabled)
injections       (document_id, mutation_type, location, original_text,
                  mutated_text, run_id)
```

A starting point, not a mandate. Adjust as needed.

## Phases — each independently shippable

Work through these in order. Stop at each ship criterion and confirm it actually works before moving on.

**Phase 0 — Skeleton and ingest** *(weekend)*
Repo, Neon project, Drizzle schema, arXiv fetcher respecting the 3-second rate limit, LaTeX source
parser preserving character offsets.
→ *Ship: a CLI command that takes an arXiv ID and prints a structured section tree with offsets.*

**Phase 1 — Claims and self-consistency** *(week 1)*
Batched extraction with content-hash caching, embeddings into pgvector, intra-document mode end to
end including the deterministic arithmetic check.
→ *Ship: find one genuine abstract-vs-table discrepancy in a real published paper.*

**Phase 2 — Cross-document detection** *(week 2)*
Candidate generation, entailment classification, adversarial verifier. Instrument everything.
→ *Ship: a JSON report across a six-paper corpus with span citations that check out by hand.*

**Phase 3 — The benchmark. THE KEYSTONE.** *(week 3)*
Injection script, clean control corpus, scoring, verifier ablation, human-labelled set, nightly
GitHub Action.
→ *Ship: a committed results table with real numbers, plus a written paragraph on where it fails.*

**Phase 4 — Interface and demo** *(week 4)*
Dual-pane report UI, streaming progress, and three pre-loaded example corpora so a visitor sees real
output in one click with no upload and no signup. README leads with the results table, not the
feature list.
→ *Ship: a cold visitor reaches a real contradiction report in under fifteen seconds.*

If time runs short, cut interface polish. **Never cut Phase 3.**

## Working practices

- **Commit incrementally and meaningfully.** Many small commits as the work happens. This matters.
- **No debug logging in committed code.** No `console.log("DEBUG", ...)` survivors.
- **Instrument from commit one.** Call counts, token usage, latency. You cannot report a reduction you
  never baselined.
- **Keep the README honest.** The results table is this project's entire value. Never report a number
  the harness didn't actually produce, and state limitations plainly.
- **Ask** if something here is genuinely ambiguous, or if a constraint above turns out to be
  unworkable. Don't silently swap a stack component.

## Anti-goals

No chat interface. No RAG question-answering. No payments. No signup wall. No rehosting arXiv PDFs.
No widening the four-type conflict taxonomy. No skipping Phase 3.

---
---

# Part 3 — How to start

## Accounts and credentials to obtain first

These require signing up in a browser and cannot be scripted. Get them before writing any code:

- A **Neon** account and Postgres connection string (neon.com — free, no card). The `vector`
  extension needs enabling, either in the dashboard or in the first migration.
- A **Gemini API key** from Google AI Studio (aistudio.google.com — free, no card).
- A **public GitHub repo**, so Actions minutes are free.

Write a `.env.example` with every variable named and commented, and confirm `.env.local` is gitignored
before anything real goes into it. No config values hardcoded in source, from the first commit.

## First action: persist the durable constraints

Phase 3 is weeks away, and the constraints below are easy to lose track of over that span. So
before Phase 0, write `docs/constraints.md` so they stay at hand. It must include:

- What Crosscheck is, and that it is **not** a chatbot or RAG Q&A
- The four-type conflict taxonomy, and that it must not be widened
- The full **do-not-use list with reasons**
- The arXiv ToU constraint: never rehost e-prints, link back, 1 request per 3 seconds
- That the eval harness outranks the UI, and Phase 3 is never cut
- Instrument LLM calls and tokens from the start; never commit debug logging
- The current phase, updated as the project moves

Keep it to about a page — a pointer to this document, not a copy of it. Commit it first.

## Then Phase 0

1. Confirm the current Gemini free-tier rate limits and the `gemini-embedding-001` API shape — those
   moved during 2026 and the figures here may be stale.
2. Propose the concrete Phase 0 file layout and the Drizzle schema for `documents` / `sections`, and
   show the arXiv fetch + LaTeX parse approach you intend to use.

Then build, once agreed.
