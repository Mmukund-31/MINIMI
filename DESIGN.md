# Design

**Goal:** a chat agent with one tool (web search) that can answer *"Last Tuesday I asked you about X. Has anything changed since?"* correctly, or say exactly what it couldn't verify.

## How it works

A single orchestrator runs a fixed, typed pipeline per message. The LLM interprets text, extracts data and writes prose. The code decides what runs, checks every model output against real data, and computes every "changed / unchanged" verdict.

```
validate → resolve dates → analyze (LLM) → recall memory → plan (LLM) → web search ×N
        → extract evidence (LLM) → verify quotes → compare (code) → answer (LLM, streamed)
        → strip invalid citations/URLs → persist
```

1. **Dates are resolved in code**, not by the model. "Last Tuesday", "on Monday", "3 November" and "earlier this month" become UTC ranges in the conversation's timezone. Ambiguous phrases return ordered candidates. For example, "last Tuesday" said on a Sunday could mean either of two Tuesdays. Retrieval picks the candidate whose conversation matches the topic, and the answer says which one it used.
2. **Memory** is SQLite with FTS5. Retrieval filters by date range, ranks with bm25 plus a topical-overlap score, and expands hits into user/assistant exchanges, bounded to 6. If nothing matches, the answer says so; it never guesses.
3. **Claims from memory are verified**: a historical price is used only if its text actually appears in a retrieved answer.
4. **Search is bounded**: at most 10 queries per message, 3 in parallel, each with a timeout, one retry and a SQLite cache. Code adds an update-focused search per vendor when the user asks "shipped anything?", puts price checks first, and enforces the cap. Results are normalized, de-duplicated and ranked: the official pricing or changelog page first, stale third-party pages demoted. Pages containing prompt-injection text are quarantined.
5. **Evidence must quote its source.** The extractor returns `{value, verbatim quote, sourceId}`. An item survives only if the source id exists in this session and the quote occurs in that page. If the model paraphrased, code may recover the real span, but only when the plan name is followed by the same price. URLs, titles and dates always come from the search result, never from the model.
6. **Comparison is deterministic.** A price parser extracts amount, currency, period, billing, per-seat and usage unit. Unlike terms (per-seat vs. team total, flat vs. per-CU-hour, monthly vs. annual, a missing plan) never produce "changed". Statuses are `changed`, `unchanged`, `uncertain` and `not_comparable`. Absence of evidence is reported as uncertain, never "unchanged".
7. **The answer streams over SSE** through a filter that drops `[S#]` citations to unknown sources and URLs that weren't retrieved, so invented links never reach the screen.

## Why this shape

- **Single orchestrator, not an agent loop.** The challenge questions follow one pattern: recall, verify against the web, compare. A fixed pipeline makes cost bounded (≤ 8 LLM calls, ≤ 10 searches), behavior testable (49 deterministic eval scenarios), and failures local (each stage degrades without killing the answer).
- **Model for language, code for truth.** Models are good at reading messy pages and bad at consistent arithmetic and honest uncertainty. Every verdict that matters is computed in code from quoted evidence.
- **Three model roles.** Groq's free tier allows 8K tokens/minute per model, measured from its response headers. The heavy extraction call runs on `gpt-oss-120b`; analysis, planning and the answer run on `gpt-oss-20b`. That keeps one research request inside both buckets. In live runs, latency fell from up to ~75s to 10–25s typically, and about 45s when research requests run back-to-back and hit the per-minute limit. The Anthropic adapter is a drop-in alternative (`LLM_SYNTHESIS_PROVIDER=anthropic`).

## Alternatives rejected

- **Autonomous tool-calling loop or multi-agent framework:** unbounded cost and hard to test. It gains nothing for questions with a known shape.
- **Vector embeddings for memory:** questions name dates and products, which date filters and FTS5 handle exactly. The retriever is an interface, so semantic search can be added if evals show misses.
- **better-sqlite3 + Drizzle:** the native binary was blocked by Windows Application Control on the dev machine. Built-in `node:sqlite` (FTS5 included) means zero native dependencies. Repositories are small and typed, with versioned SQL migrations.
- **Letting the LLM decide "changed":** in early live runs it compared "$190 for 10 seats" with "$19/seat" and flat vs. usage-based prices. The parser now catches both.

## Limitations

- Pages that render prices only in JavaScript yield no evidence, so the result is "uncertain" (honest, but less useful). A page fetcher would help.
- Live quality depends on the extractor model. Paraphrased quotes are rejected, which lowers recall to protect precision.
- Seeded demo prices were best-effort public prices when written, so "changed" can reflect seed inaccuracy. Seeds are labeled everywhere.
- Single-user: no auth, and one SQLite file.

## With another week

1. Fetch the official pricing page directly (still through the one search tool's results) and parse pricing tables.
2. A live eval set graded against hand-checked current prices, run nightly, tracking factual accuracy rather than just grounding.
3. Learned date disambiguation from user corrections ("no, the Tuesday before").
4. Per-user accounts and Postgres for multi-user deployment; an embeddings fallback for vague recall ("that database thing").
