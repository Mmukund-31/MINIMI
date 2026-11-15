# Evaluation

Two separate suites, both reproducible from the repo:

| Suite | Command | Network | Purpose |
|---|---|---|---|
| Offline | `npm run eval` | none | Regression-tests the deterministic machinery (dates, retrieval, ranking, validation, comparison, citation filtering, degradation) under known, including adversarial, model outputs. |
| Live | `npm run eval:live` | Groq + Tavily | Runs the official prompts end-to-end with real models and real search, and checks grounding automatically. |

The test suite (`npm test`, 117 tests) is separate and also offline.

## Offline results (actual)

Full table: [evals/REPORT.md](../evals/REPORT.md) (regenerated on every run).

**49/49 scenarios passed**:

| Category | Scenarios |
|---|---|
| Temporal reasoning | 8 |
| Memory retrieval | 8 (incl. official demo 2) |
| Web research | 5 |
| Pricing comparison | 10 (incl. official demos 1 and 3) |
| Product updates | 4 |
| Multi-turn follow-ups | 3 |
| Uncertainty and contradiction | 3 |
| Adversarial | 8 |

| Metric | Value |
|---|---|
| Memory retrieval precision / recall | 100% / 100% (6 TP, 0 FP, 0 FN) |
| Date-resolution accuracy | 8/8 (incl. ambiguity flags and timezone edge) |
| Comparison status accuracy | 34/34 |
| Change-detection precision / recall | 100% / 100% (5 TP, 0 FP, 0 FN) |
| Citation correctness | 23/23 citations in final answers resolve to retrieved sources |
| Planted fabrications surviving validation | 0/4 |
| Searches per request | avg 3.3, max 10 |
| Unexpected error rate | 0% |

**How to read these numbers.** The scenarios were written alongside the code to pin down the behaviors in the brief, so 100% means "the specified behavior holds". It is not an independent benchmark. The model outputs are scripted, so these numbers say nothing about how well a real model extracts evidence; the live suite covers that.

Adversarial cases covered: prompt injection inside a result, hallucinated source ids, fabricated quotes, invented historical claims, invalid structured output at every stage, every search timing out, missing publication dates, a stale article ranked first by the provider, duplicate URLs with tracking parameters, an official page unavailable (third-party only), conflicting official prices, rate-limit errors during the answer, invented URLs and citations in the answer.

## Live results (actual)

Last run: Groq `openai/gpt-oss-20b` (analysis, planning, answer) + `openai/gpt-oss-120b` (evidence extraction), Tavily search, fresh seeded database, search cache disabled. Full answers and sources: [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md).

| Case | Auto checks | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |
|---|---|---|---|---|---|---|
| Demo 1: CRM shortlist | pass | 15.5 s | 4 | 10 | 12,878 | 6 / 1 |
| Demo 2: 3 November | pass | 11.5 s | 4 | 3 | 13,586 | 13 / 1 |
| Demo 3: Postgres hosting | pass | 47.4 s* | 4 | 5 | 11,675 | 5 / 0 |
| Control: plain research | pass | 20.4 s | 4 | 1 | 5,853 | 3 / 2 |
| Control: small talk | pass | 1.5 s | 2 | 0 | 1,951 | 0 / 0 |

\* Ran immediately after two research questions, so it waited for Groq's per-minute token limit to reset. Re-run in isolation: **13.7 s**. The stage timings were analyze 1.1 s, plan 1.1 s, search 7.4 s, evidence 2.0 s, answer 2.0 s, so web search dominates, not the model.

Automatic checks: completed without error; retrieved the expected seeded conversation; searched when (and only when) expected; every `[S#]` resolves to a retrieved source; research answers cite something. **Factual accuracy of current prices is not auto-graded, and the cited pages were not opened by hand for this report.** The values the agent reported (Supabase Pro $25/month, Render Basic-1gb $19/month, Railway Hobby $5/month, Copilot Business $19 and Enterprise $39 per user/month, Neon Launch at $0.106 per CU-hour) are consistent with these vendors' publicly listed pricing as known to the author. Verify against the sources listed in the live report.

## Failures found by live testing, and the fixes

Live runs surfaced problems the offline suite could not. Each is now covered by a regression test or scenario.

| Live failure | Root cause | Fix |
|---|---|---|
| Answers had no clickable citations | Model wrote `[ S4 ]`, `【S4】`, `【S2‑S3】` | Citation filter normalizes spacing, fullwidth brackets, `†` suffixes and ranges |
| 66–75 s latency | Groq free tier is 8K tokens/min per model; one request used ~12K | Split roles across two models (separate rate-limit buckets) |
| "$190/month" vs "$19 per seat" marked **changed** | Planner extracted a derived team total; comparator allowed per-seat vs flat | Prompt forbids derived figures; comparator: per-seat vs total → `not_comparable` |
| "$19/month" vs "$0.106 per CU-hour" marked **changed** | Usage-based units not recognized | Price parser detects metered units; flat vs metered → `not_comparable` |
| "Updates: none found" when none were searched | Planner spent the budget on prices | Code guarantees one update search per vendor when asked; unsearched rows say "Not checked" |
| Many good findings rejected | Extractor paraphrased quotes / joined table cells | Punctuation-insensitive matching plus a guarded span recovery (plan name followed by the same price) |
| All rows "uncertain" in one run | Planner put the price in the plan field or the plan in the subject | Deterministic claim normalization and vendor-aware plan matching |
| AWS RDS "$0.016/hour (~$12/month)" read as monthly | Period taken from the parenthetical | Period now bound to the matched amount |
| "Pipedrive unchanged" based on a page titled "…in 2024" | Stale third-party page without a publish date | Stale-year detection, so such evidence alone yields `uncertain` |

## Known limitations of the evaluation

- The live suite has 5 cases, too few for statistical claims. Its value is catching integration failures like the ones above.
- No automated grading of live factual accuracy. A next step is a hand-labeled answer key, refreshed periodically.
- Live results vary run to run (search results and model sampling change). The report records the exact run.
