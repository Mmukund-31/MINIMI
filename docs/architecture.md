# Architecture

Companion to [DESIGN.md](../DESIGN.md). This document maps the design onto the code.

## Request lifecycle

`POST /api/chat {conversationId?, message, timezone}` → `text/event-stream`.
Route: [apps/api/src/routes/chat.ts](../apps/api/src/routes/chat.ts). The route validates the body with Zod, rate-limits, hijacks the reply for SSE, and aborts the execution if the client disconnects.

[`AgentOrchestrator.run`](../packages/core/src/agent/orchestrator.ts) executes these stages and emits an event for each:

| Stage | Module | LLM? | Failure behavior |
|---|---|---|---|
| validate | orchestrator | no | 400 / `VALIDATION` |
| temporal | [temporal/resolver.ts](../packages/core/src/temporal/resolver.ts) | no | unparsed phrases are reported in notes |
| analyze | [agent/prompts.ts](../packages/core/src/agent/prompts.ts) `ANALYZE_*` | fast | invalid output → [heuristics.ts](../packages/core/src/agent/heuristics.ts) fallback; routing guarantees always applied |
| memory | [memory/retrieval.ts](../packages/core/src/memory/retrieval.ts) | no | `not_found` is surfaced, never guessed |
| plan | prompts `PLAN_*` + [research/planner.ts](../packages/core/src/research/planner.ts) | fast | fallback plan from entities; claims normalized, then verified against memory |
| search | [search/*](../packages/core/src/search) | no | pricing: vendor domain first (Tavily `include_domains`), open web if no prices are visible or budget remains; updates: dated news index; 3 concurrent, timeout + one retry; failures recorded and noted |
| evidence | prompts `EVIDENCE_*` + [research/evidence.ts](../packages/core/src/research/evidence.ts) | extract | skipped if the budget is low; otherwise every item quote-verified |
| compare | [research/change-detector.ts](../packages/core/src/research/change-detector.ts) | no | — |
| synthesize | prompts `SYNTHESIZE_*` + [agent/citations.ts](../packages/core/src/agent/citations.ts) | synthesis | streamed through the citation + URL filters; error → `error` event, session marked failed |
| persist | [db/repositories.ts](../packages/core/src/db/repositories.ts) | no | transaction |

SSE events: `conversation`, `stage`, `memory`, `search`, `sources`, `comparison`, `token`, `done`, `error` (typed in [shared/types.ts](../packages/core/src/shared/types.ts)).

## Budgets (env-configurable, enforced in code)

| Budget | Default | Enforced by |
|---|---|---|
| LLM calls per message | 8 (one always reserved for the answer) | `UsageTracker`, `LLMClient.generateStructured` |
| Searches per message | 10 (14 measured: no coverage gain) | `finalizeSearchPlan`, `UsageTracker.beginSearch` |
| Results per search / sources kept | 5 / 12 | Tavily request, `rankSources` |
| Search timeout | 15 s | `AbortSignal.timeout` in the Tavily adapter |
| LLM timeout | 90 s (+2 SDK retries) | SDK client options |
| Whole execution | 180 s | `AbortSignal.any([client, deadline])`, checked at every stage boundary |
| Max output tokens reserved | analyze 1.5K · plan 3K · extract 4K · answer 3K | Groq counts reserved tokens against per-minute quota |
| Prompt context | 24K chars, split per block | [agent/context.ts](../packages/core/src/agent/context.ts) |

## Data model ([db/migrations.ts](../packages/core/src/db/migrations.ts))

- `conversations` (id, title, timezone, timestamps, metadata incl. `seeded`)
- `messages` (+ `messages_fts`: FTS5 external-content index kept in sync by triggers; indexes on `(conversation_id, created_at)` and `created_at`)
- `research_sessions` (one per message: status, error code, stats with per-stage latency, tokens, calls)
- `search_records` (query, provider, status, result URLs)
- `evidence_records` + `message_evidence` (claim, quote, source URL, published/retrieved dates, strength, and which answer cited it)
- `search_cache` (hashed query + options → normalized results, TTL)

All timestamps are stored in UTC; dates are interpreted in the conversation's IANA timezone (sent by the browser).

## LLM providers

`LLMProvider` ([llm/types.ts](../packages/core/src/llm/types.ts)) has two methods: `completeJson` and `streamText`. `LLMClient` adds role routing, budgets, token accounting and Zod validation with one repair attempt.

- [openai-compatible.ts](../packages/core/src/llm/openai-compatible.ts): Groq/OpenAI; `json_schema` response format with a fallback to `json_object`; `reasoning_effort` for gpt-oss.
- [anthropic.ts](../packages/core/src/llm/anthropic.ts): `output_config.format` JSON schema, `effort`, refusal stop-reason handling, server-side refusal fallback on supported models.
- [testing/index.ts](../packages/core/src/testing/index.ts): scripted provider for tests and offline evals only.

## Security notes

- Keys stay server-side; the browser only calls `/api/*`. Logger redacts auth headers.
- Input: Zod schemas with `.strict()`, a 4,000-char message cap, a 64 KB body limit, and per-route rate limiting.
- Output: markdown rendered without raw HTML; link protocols restricted to http/https/mailto; citation chips link only to retrieved sources.
- Web content: control characters stripped, length-capped, injection-pattern quarantine, delimited as untrusted data in prompts; the model's outputs are data, never executed.
- FTS queries are built from sanitized tokens (no user-controlled FTS syntax).

## Comparison semantics

Each pricing row carries a `status` and a `dimension` ([shared/types.ts](../packages/core/src/shared/types.ts)):

| Dimension | Meaning | Can be "changed" when… |
|---|---|---|
| `price_amount` | same plan, same terms (currency, period, billing, per-seat, usage unit) | amounts differ, the source is not published before the conversation, and the price is tied to the plan |
| `pricing_model` | flat subscription ↔ usage-based, or a different meter | an official page shows it, the rate is tied to the plan, and no official source still shows the old flat price |
| `billing_terms` / `currency` | prices on different terms | never: always `not_comparable` (no monetary verdict) |
| `plan_availability` | the plan wasn't among the current plans seen | never automatically: reported as `uncertain` with the current plans listed |
| `feature` | dated product launches after the conversation | major update published after the conversation |
| `evidence` | no evidence, or equally authoritative sources disagree | never |

**Evidence selection** for a row: vendor-owned before news before third-party, then plan-verified before unverified, then page type, then comparable terms, then recency. No gate depends on this order. Unverified attribution, pre-conversation publication and >5× jumps (likely scraping artifacts) all block "changed".

**Completeness** is reported separately from change:
- `historicalAccuracy`: `consistent`, `already_outdated` (a vendor page published before the conversation already showed a different value), or `unknown`.
- `offering`: plans on vendor pages, tied to their prices, that the earlier answer didn't mention. The UI shows them as "Also offered now".

## Reliability

- **One answer at a time per conversation.** A concurrent request gets HTTP 409 (`CONFLICT`).
- **Cancellation.** A client disconnect aborts in-flight LLM and search calls and is checked between stages. The session is recorded as `cancelled`.
- **Partial answers.** If streaming fails or is cancelled mid-answer, the text already shown is saved as an assistant message with `status: "error"` and an "interrupted" note. A retry reuses the original question, and the partial text is never fed back to the model.
- **Model fallbacks.** Invalid plan output from the fast model escalates once to the extract model. If the extract model is rate-limited, extraction falls back to the fast model and says so in the answer notes. Empty extraction despite visible prices gets one nudged retry. All of these respect the call budget, which always keeps one call for the answer.
