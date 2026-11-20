# Evaluation

| Suite | Command | Network | Purpose |
|---|---|---|---|
| Tests | `npm test` | none | 226 unit + integration tests (Fastify inject, deterministic test doubles) |
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

**2. Ground-truth grading** against [evals/ground-truth.json](../evals/ground-truth.json). Each entry quotes the vendor's official page. An AI agent first opened every page and found the quoted text (agent-verified, 2026-11-19 and 2026-11-20). **On 2026-11-20 the project author opened each official page and confirmed every graded entry (`review: "human-confirmed"`), so grades are no longer provisional.** Earlier sections of this document describe grades as provisional because they were at the time. Entries whose price couldn't be confirmed on the page (Render, AWS RDS, Pipedrive, Zoho) carry no expectation and are reported as *ungraded*, never guessed. Grades:

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
- **Postgres:** the answer says the earlier answer "correctly listed Neon at $19/month". It also says the flat rate "from 17 Nov 2026 was replaced", which implies the change happened after the conversation. Neon's changelog (dated only by its URL slug, 2025-11-07) indicates the plan was already usage-based before it. **Fixed in the [final round](#final-round-2026-11-19)** (timing logic, corrected ground truth, answer guard).
- **CRM:** the answer says no releases were found for Freshsales. In fact its update search returned 0 results, so it was not checked. The prompt rule alone didn't hold. **Now enforced in code** ([final round](#final-round-2026-11-19)).
- **Cursor control:** incomplete, as above. **Fixed in code** ([final round](#final-round-2026-11-19)); not yet re-run live.

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

`npm run typecheck` 0 errors · `npm run lint` clean · `npm test` **177/177** · `npm run eval` **54/54** (REPORT.md regenerated byte-identical) · `npm run build` ok. The Round-4 changes were committed as 7311bf6; see [Final verification](#final-verification) for its CI run.

## Final round (2026-11-19)

Fixes for the answer-text problems above. Each has a regression test that fails without the fix: the tests were mutation-checked by disabling the guard and the timing search.

| Problem | Fix (deterministic, in code) | Tests |
|---|---|---|
| Neon reported as "changed since" from undated pages, and the earlier "$19/month" called correct | **Page dating** from what a page states about itself: URL date slug, explicit "Last updated / Published" line, and a blog byline (full page text only). **Timing:** every `changed` row records `changeTiming` (`before_conversation` / `after_conversation` / `unknown`). If a vendor-owned, plan-verified page dated before the conversation already shows the current state, the row becomes `uncertain` + `already_outdated`; the timing page is never used as the current price. **Timing search:** one bounded search (reserved from the optional filler searches, so ≤ 10 in total) for undated `changed` rows, requesting full page text | `tests/unit/timing-and-answer-guard.test.ts`, `tests/integration/timing-and-legacy.test.ts`, `tests/unit/grading.test.ts` |
| Freshsales: "no major releases were found" when the update search didn't run or returned nothing | An update search returning 0 results now counts as **Not checked**. **Answer guard:** a sentence claiming "none found" for a not-checked vendor is replaced with "I couldn't verify recent Freshsales releases (…). This doesn't establish that none occurred."; the statement is added if missing | same |
| Cursor control: "$20 per month" without the legacy qualifier | The extractor may flag a plan `legacy` with a status quote and a successor. Code keeps the flag only if the quote is verbatim in the same source, contains legacy wording and is tied to the plan; the successor's price must also be listed. The guard makes sure an answer about that plan states all three facts: the $20 legacy price, not sold to new customers, closest current tier Premium $30 | same (`fails if the answer only mentions $20/month`) |
| "[unspecified evidence]" placeholder in the CRM answer | placeholder brackets removed in `finalizeAnswer` | `tests/unit/evidence-citations.test.ts` |
| Leading "Yes –" answering "changed since?" for a row whose timing is unknown; doubled label "Neon Launch Neon Launch" (seen in the final live run) | dropped / de-duplicated | `tests/unit/timing-and-answer-guard.test.ts` |

**Neon ground truth corrected (stricter, not easier):** `changed` is no longer accepted. Correct = `uncertain` + `already_outdated`. `changed` with `changeTiming: unknown` = abstained (difference reported, timing not claimed). `changed` claimed after the conversation, or `unchanged` = wrong. Evidence: Neon's own blog post "New usage-based pricing" (byline Aug 14, 2025, "Launch compute is $0.106 per CU-hour") and changelog 2025-11-07. Under this ground truth the 14:41 run's Neon row (`changed`, no timing) would be graded **wrong**, so that run would be 7 correct / 1 abstained / 1 wrong. The change is logged in `changeLog`.

### Live validation of the final round (actual, 17:47 UTC)

| Case | Auto checks | Correct / abstained / wrong · ungraded | Notes |
|---|---|---|---|
| CRM | pass | 3 / 0 / 0 · 2 | update searches ran for all 5 vendors (Freshsales: 4 results, so "checked"); Freshsales Pro now **correct** (unchanged, freshworks.com); HubSpot unchanged; Salesforce Enterprise uncertain; Salesforce update "changed" (dated after the baseline) |
| 3 November | pass | 3 / 0 / 0 · 0 | Pro / Business / Enterprise unchanged; "also offered now": Pro+, Max |
| Postgres | pass | 2 / 1 / 0 · 2 | Neon `changed / pricing_model`, `changeTiming: unknown` → **abstained**. The timing search failed with Tavily HTTP 432 (quota). The guard appended the "can't tell whether it changed before or after our conversation" statement. This run predates the "Yes –" fix, so its answer still opens with "Yes –" |
| Cursor control | **fail** (`citesSomething`) | – | both searches failed with Tavily HTTP 432; the answer honestly says nothing could be verified. The legacy-plan fix was **not live-validated in this run** (it was later: see below) |
| Chat control | pass | – | |

**Totals: 8 correct / 1 abstained / 0 wrong (provisional); 4/5 auto checks.** The Tavily account then rejected every request ("This request exceeds your plan's set usage limit"), although its usage endpoint reported 943/1,000 credits. Part of that budget went on this session's diagnostic searches. These were validated live on 2026-11-20 with a new Tavily key; see [Live validation, 2026-11-20](#live-validation-2026-11-20).

**Replay on real data instead:** the real Tavily response for the timing query (`Neon Launch pricing change`, full page text, saved earlier the same day) was replayed through the final code. It found neon.com/blog/new-usage-based-pricing (byline 2025-08-14, "Launch compute is $0.106 per CU-hour"), ignored the dated third-party pages (selfhost.dev, saaspricepulse.com), and produced `uncertain` / `already_outdated` / `before_conversation` with current value $0.106 per CU-hour. This checks the deterministic timing path on real page text. It isn't a full live run.

### 2026-11-20 additions

The Tavily account was still over its limit on 2026-11-20 (usage 1,001 / 1,000; every search returned HTTP 432). The free plan resets monthly, not daily. So the remaining checks used **real pages fetched directly** from cursor.com, fed to the **real Groq models** through the full pipeline in place of search results.

| Found on real data | Fix | Tests |
|---|---|---|
| Answer stated "Cursor Pro is **$25** per month for new customers" with a citation; no retrieved page contains $25 | **Unsupported-price guard:** a sentence (or table row) stating a price that appears in no evidence, comparison row, retrieved source text or earlier conversation is removed. Seat-count multiples (and ×12 annual totals) of supported prices are allowed | `dropUnsupportedPrices` tests |
| On a second run on the same pages the extractor didn't flag Pro as legacy at all (model variance) | **Legacy-plan tables read in code:** a "Legacy plan \| Price \| Comparable plan" table on a vendor-owned page (markdown or flattened HTML) gives the legacy price and the closest current tier with its price. The statement quotes the page's own sentence ("They aren't available to new customers…") | `parseLegacyTable` / `assessPlanStatus` tests |
| Weak status quote (a heading), "Cursor Pro Pro", "HubSpot Sales Hub Sales Hub Professional" | strongest verbatim "new customers" sentence; `planLabel` merges shared words | unit tests |
| A "none found" row inside a markdown table would have been replaced with prose (breaking the table) | table rows are removed whole; the statement goes after the answer | unit test |
| Exhausted search quota reported as generic failures, then retried | HTTP 432/433 → `SEARCH_QUOTA`: no retry, no further searches, and the answer says the search quota is exhausted | `search.test.ts` |

**Cursor control on real pages, real models (after the fixes):** *"The Cursor Pro plan is now a legacy offering at $20 / month [S1] [S3]. New customers are directed to the Premium tier, which costs $30 / month [S1]."* All three ground-truth facts are present and every price is on the cited page. This used real page text and real models, but not real search, so it is **not a full live run**. Sequence for the Cursor fix: the 17:47 full live run failed (no search credits) → this real-page/real-model test passed → with a new Tavily key, full live runs on 2026-11-20 passed it in 5 of 9 runs during development and on the final commit (below).

## Live validation, 2026-11-20

With a new Tavily key, `npm run eval:live` ran against real Groq + Tavily. Every answer was read against its comparison rows and sources, because automatic checks don't judge prose. Each defect found was fixed with a regression test built from the live text, and the suite was re-run. **The code changed between runs**, so the runs are a fix-and-verify sequence, not repeated samples of one version.

### Runs

| Run (UTC) | Auto checks | Correct / abstained / wrong / missing | What reading the answers showed → fix |
|---|---|---|---|
| 06:30 | 5/5 | 8 / 1 / 0 / 0 | Cursor: planner guessed `cursor.so`, only third-party pages, no legacy qualifier → vendor searches also cover `<brand>.com`. Neon: plan folded into vendor name defeated the timing check → fixed. Zoho "not comparable (USD vs INR)" called a "pricing shift"; "earlier answer was correct" despite a difference; `[S1][S1][S1]` → guard rules |
| 06:34 | 4/5 | 8 / 1 / 0 / 0 | **Neon now "already out of date"** (Neon's blog, byline 2025-08-14). CRM "all five remained on the same pricing tiers" though three were unverified → grouped "couldn't verify prices" rule. Grader flagged "only Salesforce announced" as a launch for every vendor → grader judges clauses |
| 06:39 | 5/5 | 9 / 0 / 0 / 0 | Cursor legacy page retrieved but its table not read (Tavily's ` --- ` separator row) → parser fixed |
| 06:43 | 5/5 | 8 / 1 / 0 / 0 | **Cursor complete.** Salesforce update found in 2 of 4 runs → dated vendor/news pages become "possible update" rows. Duplicate "couldn't verify" sentences → wider "already stated" patterns |
| 06:46 | 5/5 | 9 / 0 / 0 / 0 | CRM listed pre-conversation items as product updates; "【comparisons]"; Cursor named no successor (the help page's legacy table has no price for Premium) → launch-claim rule; tag placeholders removed; successor priced from the vendor's current "Plan \| Price" table |
| 06:50 | 5/5 | 8 / 1 / 0 / 0 | Freshsales abstained (pricing page not retrieved this run) |
| 06:52 | 5/5 | 9 / 0 / 0 / 0 | "major product update in Oct 2026", "remains as it was" → noun-phrase launch claims and wider "unchanged" patterns |
| **06:56** | **5/5** | **9 / 0 / 0 / 0** | All three demos and the Cursor control correct. **This run is shown in full in [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md)** (re-rendered with the current grader) |
| 07:06 | 4/5 | 9 / 0 / 0 / 0 | Zoho update marked "changed" from a third-party post about Zoho *Desk* → updates need vendor or news authority (third-party = possible update); a stray "not" no longer exempts a launch claim |
| 07:08 | 1/5 | 3 / 0 / 0 / 6 | **Final code.** CRM completed: 3/3, prose accurate. The other four cases failed: Groq's daily token quota was exhausted |
| 07:11 | 0/5 | – | Groq daily quota exhausted |
| **07:57** | **5/5** | **9 / 0 / 0 / 0** | **Final commit (83a5d11 code), full five-case run.** Every answer read against its rows and sources: CRM 3/3 (Salesforce Copilotforce from salesforce.com dated 17 Nov; the third-party Zoho *Desk* post now only a "possible update"); 3 November 3/3 plus Pro+ and Max; Postgres 3/3 with Neon "already out of date" (blog dated 2025-08-14); Cursor complete. **Shown in full in [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md)** |

Totals over the nine complete runs (06:30–07:06): **77 correct, 4 abstained, 0 wrong, 0 missing** (provisional ground truth). No run gave a confident verdict the ground truth contradicts. The four abstentions: Neon once (06:30, before the timing fix), Copilot Pro twice, Freshsales once.

### Hand-graded Cursor control (Pro is a $20 legacy plan, not sold to new customers; closest tier Premium $30)

| Run | Result |
|---|---|
| 06:30, 06:39 | incomplete: "$20/month" only (only third-party pages; legacy table not parsed) |
| 06:34, 06:46 | legacy + not sold to new customers; no successor |
| 06:43, 06:50, 06:52, 06:56, 07:06, final commit (07:32 single case, 07:57 full run) | **complete**: all three facts, cited to cursor.com |

### What stays variable (model and search variance, honest abstentions)

- **Copilot Pro** abstained in 2 of 9 runs: the extractor read GitHub's "$15 per month" *included AI-credit allowance* as Pro's price, and the conflict check refused a verdict. A deterministic credits-vs-price rule was rejected because it would also drop genuine prices on other vendors' pages.
- **Freshsales** abstained in 1 of 9 runs (its pricing page wasn't retrieved). **Salesforce's Copilotforce** update was extracted in about half the runs; the backstop now shows it as a possible update when a dated vendor page is in the sources.
- **Prose residue:** the guard enforces specific facts. Other wording is still the model's. In development runs: a Neon sentence that doesn't name Neon ("the earlier answer already listed this model"), and a pre-conversation GitHub billing change placed under "what changed since then". In the final run: the CRM answer says Salesforce's features changed and, in its last sentence, that no major release was confirmed for Salesforce; the Postgres answer files Neon under "What changed" before the appended statement says it predates the conversation. The comparison rows were correct in every case.

### Screenshots

`docs/screenshots/crm.png` and `postgres.png` were retaken from the app on 2026-11-20 (fresh database, same code except the last two guard rules). The earlier `nov3.png` (2026-11-19) was withdrawn on review: its prose said a billing change was "announced after your question" citing a page dated 28 Oct, before the 3 Nov conversation. It was **retaken on the final commit** (2026-11-20): prices unchanged per docs.github.com, Student / Pro+ / Max listed as also offered now, and no unsupported update claim.

## Human review (completed 2026-11-20)

The project author opened each official page below and confirmed the quoted text. Every graded entry in [evals/ground-truth.json](../evals/ground-truth.json) is now `review: "human-confirmed"` (the earlier agent check is kept in each entry's `agentCheck` field, and the change is in `changeLog`). No expectation was changed.

| Entry | URL | Confirmed |
|---|---|---|
| Neon Launch | neon.com/pricing · neon.com/blog/new-usage-based-pricing | Launch is usage-based ($0.106 per CU-hour); blog byline Aug 14, 2025 (before the 17 Nov conversation) |
| Supabase Pro | supabase.com/pricing | Pro $25/month |
| Railway Hobby | railway.com/pricing | Hobby $5/mo |
| GitHub Copilot Pro / Business / Enterprise, Pro+ / Max | docs.github.com/en/copilot/get-started/plans | $10 / $19 / $39 USD; Pro+ $39, Max $100 |
| Cursor control | cursor.com/docs/account/pricing/legacy-cursor-plans | Pro $20/mo is legacy → Premium ($30/mo); not available to new customers |
| HubSpot Professional, Freshsales Pro, Salesforce (Enterprise absent; Core / Advanced / Max offered) | URLs in ground-truth.json | HubSpot $90/seat (annual), Freshsales $39/user (annual), no Salesforce edition named "Enterprise" |

Render, AWS RDS, Pipedrive and Zoho stay **ungraded** (prices not retrievable: JavaScript-rendered, HTTP 403, or an INR placeholder).

## Final verification

- **Final code:** commit `83a5d1139c69fac6581d82ded42668552e0a7756` ("Final evaluation and docs updated"). The commit after it changes documentation, the evaluation report, ground-truth review labels, the 3 November screenshot, and the report re-render tool (`evals/live-runner.ts --from` now also recomputes completeness grades); no agent code changed.
- **CI:** GitHub Actions run 44693956464 on 83a5d11: **success**, all three jobs (Ubuntu Node 22, Ubuntu Node 24, Windows Node 24), each with clean install, typecheck, lint, tests, offline evaluation, the report-up-to-date check and build.
- **Fresh clone of 83a5d11** (`git clone` from GitHub, no `.env`, 2026-11-20): `npm install` ok · `npm run typecheck` 0 errors · `npm run lint` clean · `npm test` **226/226** (15 files) · `npm run eval` **54/54** (report content identical; only line endings differ under `core.autocrlf`) · `npm run build` ok · `npm run dev`: UI served, demo data seeded, `/api/health` names the missing keys, and chat returns a clear `NOT_CONFIGURED` error.
- **Live, final commit:** full five-case run (2026-11-20 07:57 UTC, real Groq + Tavily, default configuration) on the final code: **5/5 automatic checks, 9 correct / 0 abstained / 0 wrong** against human-confirmed ground truth. Hand-graded: Cursor control complete. Every answer was read against its rows and sources; the remaining prose residue is listed above. Shown in full in [evals/LIVE_REPORT.md](../evals/LIVE_REPORT.md). (An earlier attempt the same morning ran out of daily model quota; the run history records it.)
- **Live, development sequence:** across nine complete runs while fixes were being made (06:30–07:06): 77 correct / 4 abstained / 0 wrong (graded at the time against provisional ground truth; no expectation changed when it was confirmed).
- **Totals across all ten complete runs:** 86 correct / 4 abstained / 0 wrong / 0 missing. No run gave a confident verdict the ground truth contradicts.
