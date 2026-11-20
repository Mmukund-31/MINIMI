# Design

## Problem and objective

A chat agent with one tool, web search: fast on everyday questions, right on hard ones (*"Last Tuesday I asked you about X. Has anything changed since?"*). Answers say what was found, what wasn't, and where sources disagree. Being right matters more than sounding complete.

## Architecture: typed intents, four pipelines, decided in code

```
resolve dates → analyze (LLM: intent, entities, aspects, queries) → chooseIntent (code) → pipeline
  chat              → answer                                                    2 calls
  fact_lookup       → lookup:   search → coverage → [follow-up] → answer + claim gate      2 calls
  general_research  ┐
  comparison        ┘ research: search → extract claims → coverage → [follow-up] → answer + gate   3 calls
  historical_audit  ┐
  pricing_diff      ┘ deep:     memory → plan → vendor-first search → verified evidence → compare (code)
                                → answer → guard + required findings                  ≤ 8 calls
→ persist (SQLite, node:sqlite + FTS5)
```

The model proposes an intent; code decides. A reference to an earlier conversation can't skip memory, and a price check can't skip the pricing verifier. Every pipeline streams progress over SSE, runs within budgets (≤ 8 LLM calls, ≤ 10 searches, 180 s) and degrades instead of failing.

## Bounded adaptive research

Round 1 runs the proposed queries concurrently; a comparison searches every option. Research intents then make one extraction call: atomic claims with verbatim quotes, tagged by entity and aspect. Code keeps a claim only if its quote is in the source and it adds no figure the source lacks. Code then builds an entities × aspects coverage matrix (verified / mentioned / gap) and flags sources that state different dates or versions for the same cell. Each gap gets one targeted query ("Bun security model"), never a repeat. Then the loop stops: no gaps, two rounds, or budget spent. An agent loop's benefit, with a known worst case. Sources are official-first (one round-1 query restricted to vetted official domains), version-aware (pages for another major version are dropped), and evidence must name the entity in full. Each rule came from a live failure.

## Checking answers claim by claim

- **Claim gate (lookup, research, non-pricing audits):** each sentence is shown only after every figure in it (numbers, dates, versions) is found in a source it cites. Otherwise it is re-cited to the source that has the figure, or removed and recorded. Rounded figures ("≈112k") and totals from a count the user gave ("10 seats × $19") are accepted. Table cells are checked one by one ("not verified"), and code passes through. It needs no model call, and nothing unverified is streamed early.
- **Code-rendered output:** coverage, differences between sources and claim-check results are metadata the UI renders, not prose.
- **Required findings (deep):** code lists every computed change and possible update, sends them as `<must_mention>`, and appends any the prose omits. One general check instead of a text rule per omission (the live CRM answer had dropped a possible Zoho update).
- **Pricing (deep):** the price parser, plan attribution, timing and guard stay; no new pricing rules were added.

## Memory and temporal reasoning

Date phrases are resolved in code, in the user's timezone; ambiguous phrases yield ranked candidates, and the topic picks between them. Retrieval is a date filter plus FTS5 bm25, capped at 6 exchanges, and historical claims are kept only if their text occurs in a retrieved answer. Past conversations can be imported with original timestamps (sidebar button or `POST /api/conversations/import`), so recall can be tested on real history.

## Rejected alternatives

- **One verified pipeline for every question:** correct but slow and narrow; it was the first version.
- **An unbounded tool loop or multi-agent planner:** unpredictable cost and latency, hard to test.
- **An LLM judge for each claim:** another call per answer and another model to trust. A lexical gate on figures catches the most damaging hallucinations at zero latency.
- **A second extraction call in round 2:** it doesn't fit Groq's free-tier quota (8K tokens/min per model). Round-2 results are checked by the gate instead.
- **Model-decided verdicts, vector memory, full-page fetching:** untestable; unnecessary for exact dates and names; seconds per page.

## Limitations

- The gate checks figures, not meaning: a figure-free sentence passes on its citation alone.
- Coverage depends on the model labelling claims; unlabelled facts show as "mentioned", not "verified".
- Accuracy is bounded by search coverage; bot-blocked or JS-rendered pages stay unverified.
- The gate checks figures against the *cited* source, not whether that source is right (a third-party page's wrong price passes).
- Live (28 cases): challenge prompts 8 correct / 1 abstained / 0 wrong against human-confirmed ground truth; automatic checks 21/28 in the full run, with all 7 failures fixed or corrected and passing on re-run. General answers await human review. Search dominates latency (p50: lookup 6 s, research 10 s, deep 16 s).

## With another week

1. Human grading of the general live set, and a semantic faithfulness check (entailment) behind the figure gate.
2. Speculative search on the raw message while the analysis runs (about 1 s to first words).
3. Headless rendering of official pages for the deep path, with a per-domain cache.
4. Learn date disambiguation from user corrections; add accounts and Postgres for multiple users.
