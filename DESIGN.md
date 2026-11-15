# Design

**Goal:** answer *"Last Tuesday I asked you about X. Has anything changed since?"* correctly, or say exactly what couldn't be verified, using one tool: web search.

## How it works

One orchestrator runs a fixed, typed pipeline per message. The LLM reads and writes text. Code decides what runs, checks every model output against real data, and computes every verdict.

```
resolve dates → analyze (LLM) → recall memory → plan (LLM) → search → extract evidence (LLM)
   → verify quotes → compare (code) → stream answer (LLM) → filter citations → persist
```

- **Time:** "last Tuesday" and "3 November" are resolved in code, in the user's timezone. Ambiguous phrases yield ordered candidates. The one whose conversation matches the topic wins, and the answer says which was used.
- **Memory:** SQLite FTS5. The date filter, bm25 ranking and a topical score select at most 6 exchanges. Historical claims are kept only if their text occurs in a retrieved answer.
- **Search:** at most 10 queries (measured: raising to 14 didn't improve graded coverage), 3 in parallel. Pricing queries go to the vendor's own domain first, then the open web if no prices are visible there (JavaScript-rendered pages) or budget remains. Update queries use the dated news index. Ranking prefers official pricing pages and changelogs, demotes undated pages titled with old years and off-topic pages, and quarantines prompt-injection text.
- **Evidence:** every extracted price needs a quote found in its source, a source that names the vendor, and (for verdicts) a price tied to the named plan. Titles, URLs and dates come from the search result, never the model.
- **Comparison:** a price parser extracts currency, period, billing, per-seat and usage unit. Each row gets a status (`changed`, `unchanged`, `uncertain`, `not_comparable`) and a dimension (`price_amount`, `pricing_model`, `billing_terms`, `currency`, `plan_availability`, `feature`, `evidence`). Flat to usage-based on an official page is a pricing-model change, not an amount change. Pages published before the conversation, unverified plan attribution and conflicting sources block "changed". No evidence means "uncertain", never "unchanged". Three questions stay separate: was the earlier claim right *when made* (a pre-conversation official page can show it was already out of date), has it changed *since*, and which current plans did the earlier answer *omit* (vendor-verified, never called new without a dated source).
- **Answer:** streamed over SSE through filters that drop citations to unknown sources and URLs that weren't retrieved. Verified values the model forgot to cite get their source attached deterministically.

## Key choices

- **A pipeline, not an agent loop.** The questions have a known shape, so cost is bounded (≤ 8 LLM calls, ≤ 10 searches), behavior is testable (54 deterministic scenarios), and failures stay local: each stage degrades instead of failing the answer.
- **Model for language, code for truth.** Live testing showed models comparing "$190 for 10 seats" with "$19/seat" and treating flat vs usage prices as increases. Those verdicts now live in tested code.
- **Model roles across rate-limit quotas.** Groq's free tier has per-model quotas (measured: 8K tokens/min, and 200K tokens/day for 120b). Extraction runs on `gpt-oss-120b`; everything else on `gpt-oss-20b`. Planning escalates to 120b on invalid output, and extraction falls back to 20b when 120b is rate-limited. Anthropic is a drop-in alternative.

**Rejected:** autonomous tool loops and multi-agent setups (unbounded, hard to test); vector memory (dates and product names are matched exactly by filters and FTS5; the retriever is an interface if that changes); better-sqlite3 + Drizzle (native binary blocked by Windows Application Control, so built-in `node:sqlite` with typed repositories); LLM-decided "changed" verdicts.

## Limitations

- Live accuracy is bounded by search coverage. JavaScript-rendered pricing pages and blocked sites (Pipedrive returns 403 to fetchers) give "uncertain".
- Ground truth for live grading is provisional until a human confirms it (`evals/ground-truth.json`). Results vary between runs because search and model outputs vary.
- Seed prices are best-effort, labeled demo data. Single user, single SQLite file, no auth.

## With another week

1. Fetch and parse official pricing pages directly (rendered HTML tables), still sourced from search results.
2. A larger human-confirmed answer key, run nightly, with accuracy and calibration tracked over time.
3. Learn date disambiguation from user corrections. Add an embeddings fallback for vague recall.
4. Accounts and Postgres for multi-user deployment.
