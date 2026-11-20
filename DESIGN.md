# Design

## Problem and objective

Answer *"Last Tuesday I asked you about X. Has anything changed since?"* with one tool, web search. The answer says what changed, what didn't, and exactly what couldn't be verified. Being right matters more than sounding complete.

## Architecture and request lifecycle

```
resolve dates → analyze (LLM) → recall memory → plan (LLM) → search → extract evidence (LLM)
   → verify → compare (code) → stream answer (LLM) → enforce facts + citations (code) → persist
```

One orchestrator runs this typed pipeline per message, streamed over SSE, within a budget (≤ 8 LLM calls, ≤ 10 searches). Each stage degrades instead of failing. Storage is SQLite (`node:sqlite`, FTS5).

## Why deterministic orchestration

The questions have a known shape, so a fixed pipeline gives bounded cost, reproducible tests and local failures. The model reads and writes; code decides what runs and computes every verdict. In live tests, models compared "$190 for 10 seats" with "$19/seat" and claimed changes "since" our conversation from undated pages.

## Memory and temporal reasoning

Date phrases are resolved in code, in the user's timezone. An ambiguous phrase yields ordered candidates; the one whose conversation matches the topic wins, and the answer says which was used. Retrieval is a date filter plus FTS5 bm25 and a topical score, capped at 6 exchanges. A historical claim is kept only if its text occurs in a retrieved answer.

## Evidence verification and comparison

- **Evidence:** each price needs a verbatim quote from a source that names the vendor; verdicts also need the price tied to the plan. Pricing searches target the vendor's own domain first. Forum pages count as third-party, and injected instructions are quarantined.
- **Comparison:** a parser extracts currency, period, billing, per-seat and usage unit. Each row gets a status (`changed`, `unchanged`, `uncertain`, `not_comparable`) and a dimension (price, pricing model, billing terms, currency, plan availability, feature). No evidence means "uncertain".
- **Timing:** vendor pages are rarely dated, so a difference alone is "timing unknown". One bounded search looks for a page that dates itself (URL slug, "last updated" line, blog byline). If it already showed the current state before the conversation, the earlier answer was out of date; nothing changed since.
- **Updates:** "changed" needs a dated vendor or news page after the conversation. A third-party post is only a "possible update".
- **Answer guard:** the prose is checked against the rows. A contradicting sentence is replaced by a statement built from the row, and a missing required fact is added. Each rule came from a live failure:
  - "none found" when no search ran;
  - launches no dated row supports;
  - "unchanged" for unverified prices;
  - "since" for claims that were already out of date;
  - legacy plans without their status;
  - prices that appear in no source.

## Rejected alternatives

- **Autonomous tool loops and multi-agents:** unbounded and hard to test.
- **Vector memory:** dates and product names match exactly with filters and FTS5.
- **LLM-decided verdicts and prompt-only rules:** the live model ignored a prompt rule until it was enforced in code.
- **better-sqlite3:** its native binary was blocked by Windows Application Control.

## Limitations and next steps

- Accuracy is bounded by search coverage. JavaScript-rendered or bot-blocked pricing pages end up "uncertain".
- The guard enforces specific facts; other wording is the model's.
- Ground truth is agent-verified, not human-confirmed, and results vary between runs.

With another week:
1. Render and parse official pricing pages directly.
2. Build a human-confirmed answer key, run nightly with calibration tracking.
3. Learn date disambiguation from user corrections.
4. Add accounts and Postgres for multiple users.
