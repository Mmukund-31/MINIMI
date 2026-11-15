# Live evaluation report

Run on 2026-11-15T10:42:34.309Z with `npm run eval:live` · LLM: groq (openai/gpt-oss-20b, openai/gpt-oss-120b) · search: Tavily. Re-rendered from the saved run `live-2026-11-15T10-42-34-309Z.json`; ground-truth grading and the entity check were recomputed with the current grader, everything else is as recorded.
Fresh temporary database seeded with the labelled demo conversations; search cache disabled; 20s pause between cases (one user asking one question at a time; Groq free-tier limits are per minute).

**Automatic checks (pass/fail):** completed · retrieved the right earlier conversation · searched when expected · every [S#] resolves to a retrieved source · research answers cite something · every vendor from the earlier conversation has a comparison row · structural checks (no verdict without an official source or an explicit third-party qualification, no amount change across incompatible terms, no 'changed' resting on a page published before the conversation).

**Ground-truth grading** uses [ground-truth.json](ground-truth.json) (official pages fetched 2026-11-15). Entries not marked `human-confirmed` make the grade **PROVISIONAL**. *abstained* = honest uncertain/not-comparable where a verdict was possible; *wrong* = a confident verdict the ground truth contradicts.

| Case | Auto checks | Ground truth (correct / abstained / wrong / missing · ungraded) | Plan attribution verified | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |
|---|---|---|---|---|---|---|---|---|
| demo-crm | pass | 2 / 1 / 0 / 0 · 2 (provisional) | 3/4 | 10.7s | 5 | 14 | 11997 | 6 / 0 |
| demo-nov3 | pass | 1 / 0 / 0 / 0 · 2 (provisional) | 11/11 | 39.2s | 5 | 3 | 12023 | 14 / 0 |
| demo-postgres | pass | 2 / 1 / 0 / 0 · 2 (provisional) | 5/6 | 41.1s | 5 | 10 | 11132 | 6 / 2 |
| control-research | pass | – | 3/3 | 22.2s | 5 | 2 | 7761 | 3 / 0 |
| control-chat | pass | – | – | 1.1s | 2 | 0 | 2435 | 0 / 0 |

## demo-crm

> On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| Freshsales · Pro | abstained | uncertain (evidence) | expected unchanged, system abstained (uncertain) |
| HubSpot Sales Hub · Professional | correct | uncertain (billing_terms) | matches ground truth |
| Salesforce Sales Cloud · Enterprise | correct | uncertain (plan_availability) | matches ground truth |
| Zoho CRM · Professional | ungraded | uncertain (evidence) | price digits not visible in fetched text |
| Pipedrive · Professional | ungraded | uncertain (evidence) | fetch blocked (HTTP 403) |

- Memory: found ([Demo] CRM shortlist for a 20-person sales team), On Monday → Monday, 9 November 2026
- Searches: "Pipedrive Professional pricing · pipedrive.com" (done, 5); "Salesforce Sales Cloud Enterprise pricing · salesforce.com" (done, 5); "HubSpot Sales Hub Professional pricing · hubspot.com" (done, 5); "Zoho CRM Professional pricing · zoho.com" (done, 5); "Freshsales Pro pricing · freshsales.com" (done, 0); "HubSpot new features announcement 2026" (done, 5); "Salesforce new releases 2026" (done, 5); "Pipedrive product updates 2026" (done, 5); "Zoho CRM new features 2026" (done, 5); "Freshsales Pro pricing" (done, 5); "HubSpot Sales Hub Professional pricing" (done, 5); "Salesforce Sales Cloud Enterprise pricing" (done, 5); "Pipedrive Professional pricing" (done, 5); "Freshsales new releases 2026" (done, 5)
- Notes: The primary extraction model was rate-limited, so a smaller model extracted the evidence.

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| HubSpot Sales Hub (Professional) | pricing | $90 per seat/month, billed annually | $57/mo/seat (was $95/mo/seat) | uncertain | billing_terms |
| Salesforce Sales Cloud (Enterprise) | pricing | $165 per user/month, billed annually | - | uncertain | plan_availability |
| Pipedrive (Professional) | pricing | $49 per seat/month, billed annually | - | uncertain | evidence |
| Zoho CRM (Professional) | pricing | $23 per user/month, billed annually | - | uncertain | evidence |
| Freshsales (Pro) | pricing | $39 per user/month, billed annually | - | uncertain | evidence |
| HubSpot Sales Hub (Major update) | product_update | - | - | uncertain | feature |
| Salesforce Sales Cloud (Possible update) | product_update | - | New Salesforce editions announced | uncertain | feature |
| Pipedrive (Major update) | product_update | - | - | uncertain | feature |
| Zoho CRM (Major update) | product_update | - | - | uncertain | feature |
| Freshsales (Major update) | product_update | - | - | uncertain | feature |

**Answer:**

HubSpot’s Professional tier now lists $57 /mo per seat rather than the $90 /mo quoted in the original shortlist (billing terms differ, so the amount isn’t a direct price change) [S4]. Salesforce’s Enterprise edition has been superseded by a Core edition, indicating a change in plan availability [S6]. No pricing or major update evidence has surfaced for Pipedrive, Zoho, or Freshsales since the Monday shortlist. (This summary is based on the seeded demo data from the conversation.)

**Sources:**

- [S4] Sales Software Pricing | HubSpot (https://hubspot.com/pricing/sales)
- [S6] Salesforce Sales Pricing | Salesforce (https://salesforce.com/sales/pricing)

## demo-nov3

> What did I ask you on 3 November? Is your answer still correct today?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| GitHub Copilot · Pro | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Business | ungraded | unchanged (price_amount) | not visible in fetched text |
| GitHub Copilot · Enterprise | ungraded | unchanged (price_amount) | page shows 'Contact sales' only |

- Memory: found ([Demo] GitHub Copilot plans for a team of 10), 3 November → Tuesday, 3 November 2026
- Searches: "GitHub Copilot new features announcement November 2026" (done, 5); "GitHub Copilot pricing" (done, 5); "GitHub Copilot pricing · github.com" (done, 5)
- Notes: The primary extraction model was rate-limited, so a smaller model extracted the evidence.

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| GitHub Copilot (price) | pricing | $0, with limited completions and chat requests per month. | - | uncertain | evidence |
| GitHub Copilot (Copilot Pro) | pricing | $10 per month. | $10/month | unchanged | price_amount |
| GitHub Copilot (Copilot Business) | pricing | $19 per user/month. | $19 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Copilot Enterprise) | pricing | $39 per user/month (requires GitHub Enterprise Cloud). | $39 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Major update) | product_update | - | - | uncertain | feature |

**Answer:**

You asked on 3 Nov 2026: “How much does GitHub Copilot cost for a team of 10 developers [S7] [S2]? What plans are there?” The answer you received listed Free, Pro ($10 / mo), Business ($19 / mo), and Enterprise ($39 / mo) and calculated $190 / mo for 10 users under Business.

That pricing is still accurate for the plans mentioned—Pro, Business, and Enterprise remain at the same rates [S2][S1]. However, GitHub now also offers Pro+ ($39 / mo) and Max ($100 / mo) [S1], so the earlier answer omitted those options. Thus, while the figures for the listed plans are unchanged, the answer is incomplete relative to the current full set of plans.

**Sources:**

- [S1] Plans for GitHub Copilot - GitHub Docs (https://docs.github.com/en/copilot/get-started/plans)
- [S2] GitHub Copilot is moving to usage-based billing - The GitHub Blog (https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing)
- [S7] GitHub Copilot · Your AI coding agent · GitHub · GitHub (https://github.com/features/copilot)
- [S4] GitHub · Plans & pricing for every developer and team · GitHub (https://github.com/pricing)

## demo-postgres

> Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| Supabase · Pro | correct | unchanged (price_amount) | matches ground truth |
| Railway · Hobby | correct | unchanged (price_amount) | matches ground truth |
| Neon · Launch | abstained | uncertain (pricing_model) | expected changed, system abstained (uncertain) |
| Render · Basic-1gb | ungraded | uncertain (evidence) | not visible in fetched text |
| AWS RDS for PostgreSQL · db.t4g.micro | ungraded | uncertain (evidence) | not fetched |

- Memory: found ([Demo] Managed Postgres hosting options), Last Tuesday → Tuesday, 10 November 2026
- Searches: "Supabase Pro pricing · supabase.com" (done, 5); "Neon Launch pricing · neon.tech" (done, 5); "Render Postgres Basic-1gb pricing · render.com" (done, 5); "Railway Hobby pricing · railway.app" (done, 5); "AWS RDS db.t4g.micro pricing · aws.amazon.com" (done, 5); "Neon Launch pricing" (done, 5); "Render Postgres Basic-1gb pricing" (done, 5); "Supabase Pro pricing" (done, 5); "AWS RDS db.t4g.micro pricing" (done, 5); "Railway Hobby pricing" (done, 5)
- Notes: Interpreted "Last Tuesday" as Tuesday, 10 November 2026 (the most recent such weekday). The primary extraction model was rate-limited, so a smaller model extracted the evidence.

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| Neon (Launch) | pricing | $19 per month | Pay‑as‑you‑go compute at $0.14 per CU‑hour and storage at $0.35 per GB‑month, no minimum | uncertain | pricing_model |
| Supabase (Pro) | pricing | $25 per month per organization | $25 per month | unchanged | price_amount |
| Render (Postgres Basic-1gb) | pricing | $19 per month | - | uncertain | evidence |
| Amazon Web Services (AWS RDS for PostgreSQL (db.t4g.micro)) | pricing | about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage | - | uncertain | evidence |
| Railway (Hobby) | pricing | $5 per month, including $5 of usage | $5 per month, includes $5 of usage credit | unchanged | price_amount |

**Answer:**

The earlier conversation was seeded demo data. 

Since then, Neon has switched from a flat $19 per‑month plan to a usage‑based model with no minimum, charging $0.14 per compute‑unit‑hour and $0.35 per GB‑month [S3]. Supabase Pro remains $25 per month, and Railway Hobby stays at $5 per month with a $5 usage credit [S2][S4]. No current pricing evidence for Render or AWS RDS was found, so any changes for those providers cannot be confirmed.

**Sources:**

- [S2] Pricing & Fees | Supabase (https://supabase.com/pricing)
- [S3] Neon’s New Pricing, Explained: Usage-Based, No Minimum - Neon (https://neon.tech/unify?a=60b78afa-0fce-41f2-99a7-0fa7656a57fa&n=blog%2Fnew-usage-based-pricing)
- [S4] Pricing | Railway Docs (https://docs.railway.app/pricing)

## control-research

> What is the current price of the Cursor Pro plan?

- Memory: not_requested
- Searches: "Cursor Pro plan pricing" (done, 5); "Cursor Pro plan pricing · cursor.com" (done, 5)
- Notes: The primary extraction model was rate-limited, so a smaller model extracted the evidence.

**Answer:**

The Cursor Pro plan is priced at $20 per month [S1] [S2]. [S1][S2]

**Sources:**

- [S1] Pricing and plans | Cursor Docs (https://cursor.com/help/account-and-billing/pricing)
- [S2] Legacy Cursor plans | Cursor Docs (https://cursor.com/docs/account/pricing/legacy-cursor-plans)

## control-chat

> Thanks! What kinds of questions can you help me with?

- Memory: not_requested

**Answer:**

I can help with a wide range of topics—from general knowledge, explanations, and technical support to math, science, language questions, and practical advice on travel, cooking, finance, and more. Feel free to ask anything you need!

## Run history

Every complete live run saved in `evals/results/` (checks and grades as recorded by the code of that time; earlier runs had fewer checks; live results vary because search results and model outputs vary).

| Run (UTC) | Auto checks | Ground truth correct / abstained / wrong / missing | Notes |
|---|---|---|---|
| 2026-11-14 19:26 | 1/5 | – (run predates grading) |  |
| 2026-11-14 19:32 | 5/5 | – (run predates grading) |  |
| 2026-11-14 19:38 | 5/5 | – (run predates grading) |  |
| 2026-11-14 19:42 | 4/5 | – (run predates grading) |  |
| 2026-11-14 19:47 | 5/5 | – (run predates grading) |  |
| 2026-11-14 19:52 | 5/5 | – (run predates grading) |  |
| 2026-11-15 09:57 | 5/5 | 5 / 2 / 0 / 0 |  |
| 2026-11-15 10:01 | 3/5 | 4 / 3 / 0 / 0 |  |
| 2026-11-15 10:06 | 5/5 | 4 / 3 / 0 / 0 |  |
| 2026-11-15 10:08 | 4/5 | 6 / 1 / 0 / 0 |  |
| 2026-11-15 10:11 | 4/5 | 4 / 3 / 0 / 0 |  |
| 2026-11-15 10:13 | 3/5 | 3 / 1 / 0 / 3 |  |
| 2026-11-15 10:34 | 4/5 | 5 / 2 / 0 / 0 |  |
| 2026-11-15 10:37 | 1/5 | 2 / 5 / 0 / 0 |  |
| 2026-11-15 10:42 | 4/5 | 5 / 2 / 0 / 0 | 4 case(s) used the fallback extractor |
| 2026-11-15 10:52 | 0/5 | 0 / 0 / 0 / 7 | 5 case(s) failed: daily quota exhausted |
