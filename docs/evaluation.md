# Evaluation

| Suite | Command | Network | Purpose |
|---|---|---|---|
| Tests | `npm test` | none | 177 unit + integration tests (Fastify inject, deterministic test doubles) |
| Offline eval | `npm run eval` | none | 54 scenarios that pin down the deterministic machinery under known, including adversarial, model outputs → [evals/REPORT.md](../evals/REPORT.md) |
| Live eval | `npm run eval:live` | Groq + Tavily | the 3 official prompts + 2 controls end-to-end, graded against ground truth → [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md) |

## Offline results (actual)

**54/54 scenarios pass** (temporal 8, memory 8, web research 5, pricing 15 incl. completeness, product updates 4, multi-turn 3, uncertainty 3, adversarial 8, incl. the 3 demos). Full metrics are in [evals/REPORT.md](../evals/REPORT.md), which is deterministic, so CI fails if it goes stale.

The scenarios were written alongside the code to pin down the behaviors in the brief, so 100% means "the specified behavior holds". It is not a benchmark of model quality. Examples:
- flat → usage-based on an official page is a `pricing_model` change (P08);
- the same rate on a third-party page only is `uncertain` (P09);
- a usage add-on next to the old flat price is not a model change (P10);
- a different price on a page published before the conversation is not "changed since" (P11);
- a price not tied to the plan blocks "changed" (P12);
- per-seat vs team total is `not_comparable` (P07);
- planted hallucinated source ids and fabricated quotes never survive (A02);
- injected instructions in results are quarantined (A01).

## Live evaluation design

Offline testing (`npm test`, `npm run eval`) uses deterministic doubles and no network: it proves the machinery behaves as specified on known inputs. Live validation (`npm run eval:live`) uses real Groq + Tavily and is the only measure of end-to-end answer quality.

Each live case is checked two ways.

**1. Automatic checks (pass/fail, no ground truth needed):**
- **Completed:** the answer finished without error.
- **Historical conversation:** the expected seeded conversation was retrieved (date resolution and memory).
- **Searched when expected:** research questions search; small talk doesn't.
- **Citations:** every `[S#]` in the answer resolves to a retrieved source, and research answers cite something.
- **Entities covered:** every vendor from the earlier conversation gets a comparison row.
- **Structural** ([evals/grading.ts](../evals/grading.ts)):
  - no `changed`/`unchanged` verdict without an official source or an explicit third-party qualification (source authority);
  - no amount change across different currency, period, billing, per-seat or usage unit (compatibility);
  - no `changed` resting on a page published before the conversation (historical cutoff).
- **Plan attribution rate (reported):** the share of pricing evidence whose price is tied to the named plan (quote-to-claim relevance).

**2. Ground-truth grading** against [evals/ground-truth.json](../evals/ground-truth.json). Each entry quotes the vendor's official page. On 2026-11-19 an AI agent re-opened every page and found the quoted text (`review: "agent-verified 2026-11-19"`). **No entry is `human-confirmed`, so every grade is reported as provisional.** Entries whose price couldn't be confirmed on the page (Render, AWS RDS, Pipedrive, Zoho) carry no expectation and are reported as *ungraded*, never guessed. Grades:

| Grade | Meaning |
|---|---|
| correct | the status (and, for "changed", the dimension) matches |
| abstained | `uncertain` / `not_comparable` where a verdict was possible: honest but unhelpful |
| wrong | a confident verdict ground truth contradicts, or a ruled-out status (e.g. "unchanged" for Salesforce "Enterprise", which no longer exists) |
| missing | no comparison row for that vendor and plan |

## Live results, rounds 1–2 (actual, 2026-11-15)

Across the **9 graded, complete live runs** on 2026-11-15 (09:57–10:42 UTC; table in [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md#run-history)):

| Correct | Abstained | Wrong | Missing |
|---|---|---|---|
| 38 | 22 | **0** | 3 |

The system never gave a confident verdict that the (provisional) ground truth contradicts. Its errors were abstentions: "uncertain" when the evidence was thin. The 3 "missing" came from one run where the planner failed before planner escalation existed. Per-run results vary (2–6 correct out of 7 gradable) because search results and model outputs vary.

[evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md) shows the most recent complete run (10:42 UTC) in full, including answers, comparison tables with dimensions, and sources. It was **re-rendered from the saved run** with the current grader (`npm run eval:live -- --from=<file>`). In that run 4 of 5 cases used the fallback extractor because `gpt-oss-120b`'s daily quota was exhausted.

**Not live-validated:** the final fixes made after 10:42 UTC. These are citation separators (`[ S3 S7 ]`), price-only citation repair, and vendor matching across subject and plan in the grader. All have offline tests. They couldn't be validated live because both Groq models' daily token quotas (200K/day measured for 120b) were exhausted by the day's evaluation runs. The 10:52 run in the history shows the agent's behavior when every model is out of quota: a clear `LLM_RATE_LIMIT` message, no crash. Re-run `npm run eval:live` after the quota resets.

## Failures found by live testing, and the fixes

Each fix has a regression test or scenario.

| Live failure | Root cause | Fix |
|---|---|---|
| No official sources at all in some runs | open web search returned only third-party roundups | vendor-domain-first pricing search, open web if no visible prices or budget remains |
| Official pages yielded no evidence | prices sit deep in the page; truncation kept the navigation | query-focused verbatim excerpts around prices and plan names |
| Pricing sources crowded out | slot allocation depended on which search finished first | deterministic, pricing-first source allocation |
| Neon flat → usage reported "not comparable" / "sources disagree" | no pricing-model dimension; differing usage rates counted as a conflict | `dimension` on every row; model-change verdict with official confirmation; rate spread noted |
| Salesforce "Enterprise" undetectable | extractor skipped plans whose names differ from the claims | extract all plans; code matches plans and reports plan availability |
| "$10 per calendar month" read as usage-based | "calendar" parsed as a meter | plan-period adjectives |
| `[5][6]`, `[ S4 ]`, `【S2‑S3】`, `[ S3 S7 ]` not linked | citation format variants | normalization in the streaming filter |
| Verified facts stated without citations | answer model omitted them | deterministic citation repair (price amounts only) |
| Planner produced invalid JSON twice → one generic search | small model on a large schema | one escalation to the extraction model |
| Extraction empty despite visible prices | intermittent model output | one nudged retry |
| Extraction impossible when 120b is rate-limited | quotas are per model | fallback to the fast model, noted in the answer |
| Earlier rounds: "$190 for 10 seats" vs "$19/seat" = changed; flat vs per-CU-hour = changed; stale 2024 page as proof | comparator gaps | per-seat/usage/period compatibility, stale-page detection |

## Limitations of the evaluation

- 5 live cases is too few for statistical claims. The suite catches integration failures and tracks calibration (wrong vs abstained) across runs.
- Ground truth is provisional until a person confirms each entry; several vendors couldn't be graded because their prices aren't in the fetched page text.
- Groq free-tier quotas cap how many live runs fit in a day (about 4–5 full runs of 5 cases).

## Round 3 (final sprint, 2026-11-15)

### Neon: why the pricing-model verdict didn't establish itself

Traced stage by stage on real search results:
- **Search:** `Neon Launch pricing` against the vendor domain (`neon.tech`, as suggested by the planner).
- **Official-source detection:** correct.
- **Normalisation:** redirect-wrapped `neon.tech/unify?...` copies duplicated `neon.com` pages, which is now merged.
- **Excerpts:** contained the rate.
- **Extraction and validation:** two official Neon findings survived validation. One came from an August 2025 blog post quoting the superseded **$0.14** rate, with no plan named (`planVerified=false`). The other came from Neon's FAQ: *"The Launch plan has no monthly minimum. You pay $0.106 per CU-hour"* (`planVerified=true`).
- **Comparison:** both were `official_pricing` and undated, so the comparator's tie-break picked the unverified one, and the plan-attribution gate then (correctly) refused a verdict.

**Fix:** among equally authoritative vendor-owned sources, plan-verified evidence ranks first. No gate was weakened: unverified evidence still can't produce "changed". A regression test reproduces the exact live shape and fails on the previous commit.

The trace also found Neon's dated changelog (*"Launch plan: Now $0.106 per CU-hour (previously $0.14)"*, Nov 2025). The seeded "$19/month flat" claim was therefore already outdated before the conversation, so the ground truth now also accepts "already out of date" for this entry (see its `changeLog`).

### CRM coverage (Freshsales, Zoho, Pipedrive)

- **Freshsales:** the pricing page uses a card layout with the price *before* the plan name, so forward attribution can't tie it. Other Freshworks pages ("Pro … $39 user month billed annually") do verify. Fix: plan-verified vendor pages outrank unverified ones regardless of page type. Backward attribution was deliberately **not** added: in "Growth $9 … Pro $39" layouts it would tie the wrong price to the wrong plan.
- **Zoho:** the main pricing page is geo-served in ₹, so it is `not_comparable` on currency, which is correct. The pricing calculator states "Professional US$23". A comparison page contains a rendering artifact, "$2323", which would have passed every gate, so a >5× change on identical terms is now treated as an artifact (`uncertain`).
- **Pipedrive:** no plan prices in any retrievable vendor page (the pricing page blocks fetchers). The row stays `uncertain` and now says why: "N page(s) on the vendor's own site were found … but none stated a price for this plan".

### Completeness and product-update grading

- Each pricing row now carries `historicalAccuracy` (`consistent` / `already_outdated` / `unknown`), separate from whether it changed since. Answers also list **current plans the earlier answer didn't mention** (vendor-owned, plan-verified), labelled "also offered now", never "new". Covered by offline scenario C01 and unit tests.
- **Live grader additions:**
  - offering recall against ground truth (Copilot Pro+ and Max; Salesforce Core, Advanced and Max);
  - product-update checks: a dated source after the baseline, official or news authority, a source that names the product, and no uncited launch claims in the answer text.

### Performance (from `npm run eval:perf`, 15 complete live runs, 60 research answers)

Runs analysed: 15 complete runs without quota failures; 60 research answers.

| Metric | avg | p50 | p90 | max |
|---|---|---|---|---|
| Searches per answer | 5 | 5 | 10 | 14 |
| LLM calls per answer | 4 | 4 | 5 | 5 |
| Tokens per answer | 10241 | 11320 | 13378 | 14971 |
| Latency (ms) | 21845 | 16195 | 41892 | 74793 |

| Stage | avg ms | p90 ms |
|---|---|---|
| analyze | 1371 | 2918 |
| plan | 2225 | 6277 |
| search | 4890 | 8966 |
| evidence | 10872 | 29605 |
| synthesize | 2480 | 5656 |

Extraction fallback used: 4/60 research answers.
Search failures/timeouts: 0/314 searches.

| CRM run | searches | graded correct | abstained | wrong |
|---|---|---|---|---|
| 2026-11-15T09:57 | 10 | 3 | 0 | 0 |
| 2026-11-15T10:01 | 10 | 2 | 1 | 0 |
| 2026-11-15T10:06 | 12 | 2 | 1 | 0 |
| 2026-11-15T10:08 | 10 | 3 | 0 | 0 |
| 2026-11-15T10:11 | 14 | 2 | 1 | 0 |
| 2026-11-15T10:13 | 1 | 0 | 0 | 0 |
| 2026-11-15T10:34 | 14 | 2 | 1 | 0 |
| 2026-11-15T10:37 | 14 | 2 | 1 | 0 |
| 2026-11-15T10:42 | 14 | 2 | 1 | 0 |

- **Latency:** dominated by evidence extraction on `gpt-oss-120b` (Groq per-minute quota waits), then search.
- **Search reliability:** 0 failures or timeouts in 314 live searches. The 15 s timeout, one retry and graceful degradation are covered by offline tests.
- **Concurrency:** one answer per conversation (HTTP 409 for a concurrent turn), covered by an integration test.
- **Search budget:** the default went back to **10**. Raising it to 14 last round wasn't measured, and this data shows no coverage gain: CRM correct verdicts were 3/2/3 at 10 searches vs 2/2/2/2/2 at 12–14. The comparison is confounded by other changes between runs, but there's no evidence that the extra searches pay for their cost.
- **Providers:** the extraction fallback (`gpt-oss-20b`) was used in 4 of 60 answers. The Anthropic adapter was validated against the real API in this round: structured output and streaming on `claude-haiku-5-5`, and the default `claude-opus-5-5` path including refusal-fallback parameters. That used about 700 tokens in total.

### Live evaluation limitations in this round

All round-3 changes are covered by offline tests (168 tests, 54/54 scenarios). The live re-run could **not** be performed: `gpt-oss-120b`'s daily quota was still exhausted (196.6K/200K), and `TAVILY_API_KEY` in `.env` became empty during the session. The live numbers above and in [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md) are from the earlier rounds' code. Re-run `npm run eval:live` once both are available.

## Round 4 (submission verification, 2026-11-19)

The Round-3 live gap is closed: `npm run eval:live` ran three times on 2026-11-19 against real Groq + Tavily, with `MAX_SEARCHES=10` (now the default everywhere, including `.env.example`).

### Live results (actual, final run 14:41 UTC; provisional ground truth)

| Case | Auto checks | Correct / abstained / wrong / missing · ungraded | Notes |
|---|---|---|---|
| CRM (5 vendors) | pass | 2 / 1 / 0 / 0 · 2 | all 5 vendors have rows. HubSpot unchanged ($90 annual). Salesforce "Enterprise" correctly not given a price verdict. Freshsales abstained (no plan-verified price retrieved). Salesforce product update "changed" (salesforce.com, dated 17 Nov, after the 16 Nov baseline). Completeness **missed** Salesforce Core/Advanced/Max (no Salesforce prices retrieved this run) |
| 3 November | pass | 3 / 0 / 0 / 0 · 0 | Copilot Pro $10, Business $19, Enterprise $39 unchanged. "Also offered now": Pro+ $39 and Max $100, both matching ground truth |
| Postgres | pass | 3 / 0 / 0 / 0 · 2 | Neon `changed / pricing_model` ($19 flat → $0.106 per CU-hour). Supabase Pro and Railway Hobby unchanged. Render and AWS RDS uncertain, ungraded |
| Cursor control | pass (auto) | hand-graded: **incomplete** | said "$20 per month" (true) but not that Pro is a legacy plan no longer sold to new customers (cursor.com help page) |
| Chat control | pass | – | no search, no citations |

**Totals: 8 correct / 1 abstained / 0 wrong / 0 missing (provisional).** The run history in [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md#run-history) shows the progression on the same day: 3/4/0/1 (before the Round-4 fixes) → 7/1/0/0 → 8/1/0/0. Three runs is not a statistical sample, and live results vary between runs.

### Answer-text problems found by reading the answers (not caught by auto checks)

Citation validity is not accuracy, so every answer was read against its sources.
- **Postgres:** the answer says the earlier answer "correctly listed Neon at $19/month". It also says the flat rate "from 17 Nov 2026 was replaced", which implies the change happened after the conversation. Neon's changelog (dated only by its URL slug, 2025-11-07) indicates the plan was already usage-based before it. The comparison row (`changed / pricing_model`) is accepted by ground truth, but the prose overstates it. **Not fixed.**
- **CRM:** the answer says no releases were found for Freshsales. In fact its update search returned 0 results, so it was not checked. The synthesis prompt now asks to keep "Not checked" separate, but the model didn't follow it in this run. **Prompt-level only, not enforced in code.**
- **Cursor control:** incomplete, as above. The structural checks can't detect an omitted qualifier.

### Defects found live in Round 4 and fixed (each has a regression test; not yet re-validated by a further live run except where the final run shows it)

| Live failure | Fix |
|---|---|
| Copilot Pro listed as "also offered now" although the earlier answer named it | offering excludes plans mentioned anywhere in the earlier answer text (whole-phrase match, "Pro" ≠ "Pro+") |
| Meters ("Compute", "Storage") listed as plans | meter attributes are plan-less: never offerings, never plan-verified |
| Plan folded into the subject ("Neon Launch" / attribute "price") not matched | plan-less attributes match via the subject |
| Planner extracted "Cost for 10 developers" as a vendor claim | derived claims (team totals, annual sums) dropped deterministically |
| forum.cursor.com thread ("Think Cursor Pro is $20/month? Nope") counted as official | user-generated hosts and paths on vendor domains are third-party |

### Ground-truth verification status

| Entry | Status |
|---|---|
| Supabase Pro, Railway Hobby, Neon Launch, Copilot Pro/Business/Enterprise, Freshsales Pro, HubSpot Professional, Salesforce (Enterprise absent), offering (Copilot Pro+/Max, Salesforce Core/Advanced/Max), Cursor control | **agent-verified 2026-11-19**: an AI agent opened the official page and found the quoted text. Not human-confirmed |
| Zoho CRM Professional | **withdrawn**: every edition tab showed the same "₹ 800" (likely a placeholder), and the Round-3 "US$23" excerpt couldn't be confirmed |
| Pipedrive Professional | not verifiable: HTTP 403 to automated fetches |
| Render Basic-1gb, AWS RDS db.t4g.micro | not verifiable: prices are JavaScript-rendered |

No expectation was changed to improve a score. Copilot Business/Enterprise were *added* (they were ungraded) after the docs.github.com page was opened independently of the system's output. Every change is in the file's `changeLog`.

### Automated checks (actual, from a clean `npm ci`)

`npm run typecheck` 0 errors · `npm run lint` clean · `npm test` **177/177** · `npm run eval` **54/54** (REPORT.md regenerated byte-identical) · `npm run build` ok. GitHub Actions CI: **success** on 801250e (run 43710486067). The Round-4 changes are uncommitted at the owner's request, so CI hasn't run on them yet.
