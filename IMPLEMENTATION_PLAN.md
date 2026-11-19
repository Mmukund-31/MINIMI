# Implementation plan and progress

Status as of 2026-11-15. All phases completed. Commands below were run on Windows 11, Node 24.15.0, npm 11.12.1.

| Phase | Scope | Status | Key files | Verification |
|---|---|---|---|---|
| 0 | Repo inspection, plan, env, provider choice | ✅ | `.env.example`, `.gitignore` | Empty repo confirmed; Groq (free) + Tavily chosen; Anthropic adapter optional |
| 1 | Workspace, TS strict, Fastify, Vite/React, health, scripts | ✅ | `package.json`, `tsconfig*.json`, `apps/*` | `npm run typecheck`, `lint`, `build` pass; `/api/health` OK |
| 2 | SQLite schema, migrations, FTS5, repositories, persistence | ✅ | `packages/core/src/db/*` | persistence-across-restart test; manual restart check |
| 3 | Temporal resolver + hybrid retrieval | ✅ | `temporal/resolver.ts`, `memory/retrieval.ts` | `tests/unit/temporal.test.ts`, `tests/unit/memory.test.ts`; 16 eval scenarios |
| 4 | LLM abstraction + orchestrator | ✅ | `llm/*`, `agent/orchestrator.ts` | structured-output repair/budget tests; e2e tests |
| 5 | Web search (Tavily), normalize, dedupe, rank, cache | ✅ | `search/*` | adapter tests with fake fetch (retry, auth, timeout); cache tests |
| 6 | Research planning + evidence ledger + injection defense | ✅ | `research/planner.ts`, `research/evidence.ts` | validator, quote-recovery, quarantine tests |
| 7 | Deterministic change detection | ✅ | `research/price.ts`, `research/change-detector.ts` | price-model tests; 10 pricing/4 update scenarios |
| 8 | Synthesis + citation validation | ✅ | `agent/prompts.ts`, `agent/citations.ts` | streaming filter tests (chunk boundaries, variants, URLs) |
| 9 | Frontend | ✅ | `apps/web/src/*` | builds; screenshots via headless Edge of empty state and a research answer; SSE via Vite proxy |
| 10 | Evaluation framework | ✅ | `evals/*` | offline 49/49; live 5/5 (see `docs/evaluation.md`) |
| 11 | Reliability, security, observability | ✅ | `apps/api/src/*`, orchestrator | timeouts, cancellation, rate limits, typed errors, per-stage latency in `research_sessions.stats` |
| 12 | Docs + submission prep | ✅ | `README.md`, `DESIGN.md`, `docs/*` | clean-install verification (below) |

## Decisions that deviated from the original brief

| Brief said | Chosen | Why |
|---|---|---|
| Drizzle ORM + better-sqlite3 | `node:sqlite` + typed repositories + SQL migrations | better-sqlite3's native binary was blocked by Windows Application Control on the dev machine; `node:sqlite` has FTS5 and needs no native build. Drizzle has no `node:sqlite` driver (only async proxies). |
| Eight packages under `packages/` | One `@minimi/core` package with module folders | Same boundaries, without cross-package build overhead |
| Playwright e2e | Fastify-inject integration tests + headless-Edge screenshots | Avoids a heavy browser download in `npm install`; the HTTP/SSE contract is fully covered |
| Numeric confidence | Qualitative status + source type | No calibrated probabilities available; numbers would be fake precision |

## Test log (latest)

- `npm test`: 117 passed (10 files)
- `npm run eval`: 49/49 passed
- `npm run eval:live`: 5/5 passed automatic checks
- `npm run typecheck`, `npm run lint`: clean
- Clean install: deleted all `node_modules`, `dist/` outputs and the database. Then `npm install` (23 s), `typecheck` (0 errors), `lint` (clean), `test` (117/117), `eval` (49/49) and `build` all passed. `npm run dev` from an empty DB seeded 4 labeled demo conversations, and the "3 November" demo streamed end to end through the Vite proxy (memory, 4 searches, sources, comparisons, 221 token events).
- `npm start` (production): API and built UI on one port; SPA fallback 200; unknown `/api/*` routes 404.

## Outstanding issues and next steps

- JS-rendered pricing pages are invisible to search snippets → add a page-fetch step for official pricing URLs.
- No live factual-accuracy grading → build a hand-checked answer key.
- `npm audit`: 7 moderate advisories in dev-only lint tooling (typescript-eslint dependency chain); no runtime exposure.
- Anthropic adapter: unit-level contract only; live validation pending an API key in `.env` (`LLM_SYNTHESIS_PROVIDER=anthropic npm run eval:live -- --only=demo-postgres`).

---

## Review round 2 (2026-11-15): independent audit and fixes

The baseline at the start was green (117 tests, 49/49 offline evals). The audit found the defects below, verified empirically before fixing. Each fix has regression tests.

| # | Defect | Fix | Files |
|---|---|---|---|
| 1 | Look-alike subdomains (`neon.selfhost.dev`) classed as official | official = registrable domain; model domain hints filtered (no review/aggregator sites) | `search/ranking.ts` |
| 2 | Evidence accepted from pages about a different vendor | entity check: source must mention the vendor | `research/evidence.ts` |
| 3 | Price not tied to the named plan | `planVerified` (plan named in quote, or plan name followed by that price); unverified prices can't prove "changed" | `research/evidence.ts`, `change-detector.ts` |
| 4 | "Google Cloud SQL" ≈ "Google Workspace" | token-subset subject matching | `shared/text.ts` |
| 5 | Old pages could prove a change "since" | historical cutoff on publication date | `change-detector.ts` |
| 6 | Stale/off-topic pages not demoted | title-year staleness and relevance penalties | `search/ranking.ts` |
| 7–8 | Flat → usage not a pricing-model change; no change dimensions | `dimension` on every row; pricing-model verdict with official confirmation; UI shows it | `types.ts`, `change-detector.ts`, prompts, UI |
| 9 | Live eval checked grounding only | ground truth (provisional, quoted), grader (correct/abstained/wrong/missing), structural checks, run history, `--from` re-render | `evals/grading.ts`, `evals/live-runner.ts`, `evals/ground-truth.json` |
| 10 | Partial answers lost on failure/cancel | persisted with `status: error`, retry reuses the question, partial hidden from model | `orchestrator.ts`, UI |
| 11 | Concurrent turns in one conversation | per-conversation lock → HTTP 409 | `orchestrator.ts`, `routes/chat.ts` |
| 12 | `evals/REPORT.md` changed on every run | deterministic report; CI checks it's committed up to date | `evals/runner.ts`, CI |
| 13 | No CI, long DESIGN.md, no screenshots | GitHub Actions (Ubuntu Node 22/24, Windows Node 24); DESIGN.md ≈ 640 words; README rewritten with screenshots | `.github/workflows/ci.yml`, docs |

Found by live testing during this round (all fixed, with tests): no official sources returned by open search → vendor-domain-first search with open fallback; JS-rendered official pages → focused excerpts; nondeterministic source-slot allocation; extractor skipping renamed plans; `per calendar month` parsed as usage; citation format variants (`[5]`, `[ S3 S7 ]`); uncited verified facts; planner invalid JSON → escalation; empty extraction → nudged retry; rate-limited extraction model → fallback; cancellation not checked between stages.

### Test log (end of round 2)

- `npm test`: 152 passed (13 files)
- `npm run eval`: 53/53 (report stable across runs)
- `npm run typecheck`, `npm run lint`: clean
- Live: 9 graded complete runs → 38 correct / 22 abstained / **0 wrong** / 3 missing (provisional ground truth); details in `docs/evaluation.md`

### Outstanding

- Human confirmation of `evals/ground-truth.json` entries (set `review` to `human-confirmed`).
- Re-run `npm run eval:live` after the Groq daily quota resets: the final citation and grader fixes are verified offline only.
- Retake the 3-November and Postgres screenshots (removed because they showed since-fixed citation glitches).
- ~~Your local `.env` still has `MAX_SEARCHES=6`. The new default is 14.~~ Superseded: the default is 10 everywhere since Round 3/4.

---

## Round 3 (2026-11-15): final quality sprint

| Priority | Finding (traced on real data) | Change | Files |
|---|---|---|---|
| 1 Neon | Comparator picked an unverified, superseded $0.14 blog quote over a plan-verified official FAQ ($0.106); undated tie → arbitrary order | plan-verified evidence ranks first among vendor-owned sources; regression test fails on `fff7739`. Same page under several URLs is merged, keeping all excerpts | `research/change-detector.ts`, `search/normalize.ts` |
| 2 CRM | Freshsales card layout (price before plan); Zoho geo-served ₹ page and a "$2323" artifact; Pipedrive pricing page not retrievable | vendor-owned tier → plan-verified → page type ordering; >5× change treated as an artifact; "why no evidence" explanation from the retrieved sources | `change-detector.ts`, `agent/orchestrator.ts` |
| 3 Completeness | Accuracy of earlier claims, change since, and omitted plans were conflated | `historicalAccuracy` per row; `offering` note (vendor-verified plans not in the earlier answer, "also offered now"); prompt + UI | `shared/types.ts`, `change-detector.ts`, `agent/context.ts`, `agent/prompts.ts`, `MessageItem.tsx` |
| 4 Updates | Grader didn't validate launches | `updateChecks`: dated after baseline, official/news, names the product, no uncited launch claims; offering recall grading | `evals/grading.ts`, `evals/live-runner.ts` |
| 5 Ground truth | Neon's transition predates the conversation; Zoho now verifiable via an official excerpt | `alsoCorrect` for Neon (still provisional), Zoho entry added, offering truths, per-entry method, `changeLog`, non-verifiable entries documented | `evals/ground-truth.json` |
| 6 Performance | Search limit 14 had been raised without measurement; data shows no coverage gain | default back to 10; `npm run eval:perf` | `shared/config.ts`, `.env.example`, `evals/perf-report.ts` |
| 6 Providers | Anthropic adapter never run live | validated: Haiku structured + stream, Opus structured with refusal-fallback params (~700 tokens); adapters exported | `packages/core/src/index.ts` |

### Test log (end of round 3)

- `npm ci` → `typecheck` (0 errors) → `lint` (clean) → `test` 168/168 → `eval` 54/54 → `build` OK (recorded in the final verification run)
- CI on GitHub for `fff7739`: all 3 jobs green, including "offline evaluation report is up to date"
- Live: not re-run this round (120b daily quota exhausted; `TAVILY_API_KEY` empty in `.env`)

### Outstanding (needs a person)

- Set `TAVILY_API_KEY` again and run `npm run eval:live` once Groq's 120b daily quota resets; then `npm run eval:perf`.
- Confirm each `provisional` ground-truth entry by opening the official page.
- Retake the 3-November and Postgres screenshots after a live run.

---

## Round 4 (2026-11-19): submission verification

| Area | Finding (live, real Groq + Tavily) | Change | Files |
|---|---|---|---|
| Config | `.env.example` still said `MAX_SEARCHES=14` | 10 everywhere (code default, `.env.example`, local `.env`) | `.env.example` |
| Completeness | Copilot Pro reported as "also offered now" although the earlier answer named it; meters ("Compute", "Storage") listed as plans | offering skips plans mentioned in the earlier answer text (whole-phrase, "Pro" ≠ "Pro+") and plan-less/meter attributes | `research/change-detector.ts`, `agent/orchestrator.ts` |
| Plan matching | extractor folded the plan into the subject ("Neon Launch" + "price") | plan-less attributes match via the subject; meters never plan-verified; prompt asks for plan as attribute | `change-detector.ts`, `research/evidence.ts`, `agent/prompts.ts` (evidence@6) |
| Claims | planner extracted "Cost for 10 developers" | derived claims dropped in `normalizeClaims` | `research/planner.ts` |
| Source authority | forum.cursor.com thread classified as official | user-generated hosts/paths on vendor domains are third-party | `search/ranking.ts` |
| Answer | "Not checked" folded into "none found" | synthesis prompt rule (synthesize@8). Prompt-only: not followed in the final CRM run | `agent/prompts.ts` |
| Ground truth | all quoted entries re-opened | agent-verified 2026-11-19; Copilot Business/Enterprise added; Zoho withdrawn (₹800 placeholder); Pipedrive/Render/AWS documented as not verifiable; Cursor control truth | `evals/ground-truth.json` |

### Test log (end of round 4)

- Clean `npm ci` → `typecheck` 0 errors → `lint` clean → `test` 177/177 → `eval` 54/54 (REPORT.md unchanged) → `build` OK
- Live (`npm run eval:live`, 3 runs): 3/4/0/1 → 7/1/0/0 → **8 correct / 1 abstained / 0 wrong / 0 missing**, 5/5 auto checks (provisional ground truth)
- Hand-graded: Cursor control incomplete (omits that Pro is legacy); Postgres prose overstates the timing of Neon's change
- CI: success on `801250e`. Round-4 changes are **uncommitted** (owner commits manually), so CI hasn't run on them
- Screenshots `crm.png`, `home.png`, `nov3.png`, `postgres.png` retaken from the final app

### Outstanding (needs a person)

- Commit, then confirm CI is green on that commit.
- Open each ground-truth page and set `review: "human-confirmed"` where it matches.
