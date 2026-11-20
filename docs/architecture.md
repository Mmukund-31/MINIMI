# Architecture

Companion to [DESIGN.md](../DESIGN.md). This document maps the design onto the code.

## Request lifecycle

`POST /api/chat {conversationId?, message, timezone}` → `text/event-stream`.
Route: [apps/api/src/routes/chat.ts](../apps/api/src/routes/chat.ts). The route validates the body with Zod, rate-limits, hijacks the reply for SSE, and aborts the execution if the client disconnects.

### Research intents and pipelines

After `analyze`, [`chooseIntent`](../packages/core/src/agent/heuristics.ts) decides the intent from the model's proposal plus deterministic cues, and `pipelineFor` maps it to a pipeline:

| Intent | Rule (code) | Pipeline | Stages | LLM calls |
|---|---|---|---|---|
| `chat` | no web search, no memory | chat | analyze → answer | 2 |
| `fact_lookup` | default for web questions | lookup | search → coverage (+ ≤ 3 gap queries) → answer + claim gate | 2 |
| `general_research` | model says so, or ≥ 2 requested aspects | research | search → claim extraction → coverage (+ gap queries) → answer + claim gate | 3 |
| `comparison` | ≥ 2 options and a comparative cue; pricing may be one criterion among others | research | as above; round 1 searches every option | 3 |
| `historical_audit` | memory needed, no pricing | deep | memory → plan → search → evidence → compare → answer + claim gate + guard | ≤ 8 |
| `pricing_diff` | memory + pricing, or pricing of named products with no other aspect | deep | the full table below, + required findings | ≤ 8 |

**Research loop** ([general-evidence.ts](../packages/core/src/research/general-evidence.ts)). The extraction call (`CLAIMS_SYSTEM`, fast model, ≤ 9K chars of sources) proposes atomic claims with verbatim quotes, tagged by entity and aspect. `verifyClaims` keeps a claim only if its quote occurs in the source (`quoteFound`), it isn't instruction-like, and it adds no figure absent from the source. It maps labels onto the requested entities and aspects and sets confidence in code (official 0.9, primary 0.8, secondary 0.6, +0.1 when another domain corroborates the same cell). `assessCoverage` builds the entities × aspects matrix: `verified` (a claim answers it), `mentioned` (a source names the entity and aspect), or `gap`. It also lists *sources that differ*: full dates or versions in one cell from different domains, with nothing in common. `gapQueries` produces one targeted query per gap, never repeating an earlier one. There are at most two rounds; round-2 sources are appended (ids stay stable) and checked by the claim gate rather than a second extraction call (Groq per-minute quota). `buildResearchEvidence` exposes the general evidence model (`ResearchEvidence`: authority, relevance, claims with supporting quotes and confidence).

**Claim gate** ([claim-gate.ts](../packages/core/src/agent/claim-gate.ts)). It sits in the stream after the citation and URL filters, and releases text only in complete lines. Each sentence or table row with figures (numbers > 10, decimals, versions, date numbers; digits glued to letters are names) needs every figure in a source it cites, publication dates included. Large rounded figures (≥ 1,000, not years) match within 2%. A sentence is re-cited if one or two other sources hold the figures, and removed and recorded otherwise. Figures from the question, the conversation, the remembered exchange and today's date are exempt. Results go to `metadata.research.claimCheck`, and removals are noted in the answer.

**Source selection** (lookup/research): one round-1 query restricted to the official domains the analysis names (`trustedDomainHint` drops review sites and implausible hosts; `vendorDomains` adds the brand .com), and those domains mark official pages in ranking. Pages for a different major version than one named with a "v" in the question (`versionMismatch`: `v3.` subdomains, `/v3/` paths) are dropped when other sources remain. Claims and coverage require the full entity name (`namesEntity`), and when no source names an entity, the answer model is told.

**Gate streaming**: sentences are released as soon as each is complete and checked; table rows and fenced code are released as whole lines; code is never checked. Table rows are checked cell by cell. Totals derived from a count in the user's words (v × k, v × k × 12, base + v × k) are supported.

**Required findings** ([required-findings.ts](../packages/core/src/agent/required-findings.ts), deep): changed rows and possible updates go to the model as `<must_mention>`; any the prose doesn't state (subject + a distinctive word of the finding) are appended under "Also found".

**Answer models.** Chat, lookup and research answers stream on `LLMClient.strongStreamRole()`: the larger extract model when it shares the provider (idle on these paths, with its own Groq quota), retried once on the synthesis model if it is rate-limited before any output. `LLM_SYNTHESIS_PROVIDER` is respected. Stats record `intent`, `mode`, `rounds`, `firstStatusMs` and `firstTokenMs`.

### Deep mode stages

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

## History import

`POST /api/conversations/import` ([memory/import.ts](../packages/core/src/memory/import.ts)) stores a past conversation with its original timestamps, so date-based recall can be tested on real history. Validation: strict Zod schema (1–100 messages, `user`/`assistant` roles only, ≤ 8,000 chars each, ISO timestamps with offset), chronological order, nothing in the future (5-minute skew), 1 MB body limit, 10 requests/minute. One transaction; FTS triggers index the messages; conversation and messages carry `metadata.imported`.

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
