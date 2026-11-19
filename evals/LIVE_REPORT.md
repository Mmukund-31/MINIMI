# Live evaluation report

Run on 2026-11-19T14:41:46.260Z with `npm run eval:live` · LLM: groq (openai/gpt-oss-20b, openai/gpt-oss-120b) · search: Tavily.
Fresh temporary database seeded with the labelled demo conversations; search cache disabled; 20s pause between cases (one user asking one question at a time; Groq free-tier limits are per minute).

**Automatic checks (pass/fail):** completed · retrieved the right earlier conversation · searched when expected · every [S#] resolves to a retrieved source · research answers cite something · every vendor from the earlier conversation has a comparison row · structural checks (no verdict without an official source or an explicit third-party qualification, no amount change across incompatible terms, no 'changed' resting on a page published before the conversation).

**Ground-truth grading** uses [ground-truth.json](ground-truth.json) (official pages fetched 2026-11-19). Entries not marked `human-confirmed` make the grade **PROVISIONAL**. *abstained* = honest uncertain/not-comparable where a verdict was possible; *wrong* = a confident verdict the ground truth contradicts.

| Case | Auto checks | Ground truth (correct / abstained / wrong / missing · ungraded) | Plan attribution verified | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |
|---|---|---|---|---|---|---|---|---|
| demo-crm | pass | 2 / 1 / 0 / 0 · 2 (provisional) | 2/2 | 11.0s | 4 | 10 | 12499 | 5 / 0 |
| demo-nov3 | pass | 3 / 0 / 0 / 0 · 0 (provisional) | 15/15 | 10.7s | 4 | 3 | 13433 | 17 / 1 |
| demo-postgres | pass | 3 / 0 / 0 / 0 · 2 (provisional) | 5/7 | 8.8s | 4 | 10 | 12543 | 9 / 0 |
| control-research | pass | – | 5/5 | 5.2s | 4 | 2 | 8887 | 6 / 0 |
| control-chat | pass | – | – | 1.2s | 2 | 0 | 2516 | 0 / 0 |

## demo-crm

> On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| Freshsales · Pro | abstained | uncertain (evidence) | expected unchanged, system abstained (uncertain) |
| HubSpot Sales Hub · Professional | correct | unchanged (price_amount) | matches ground truth |
| Salesforce Sales Cloud · Enterprise | correct | uncertain (evidence) | matches ground truth |
| Zoho CRM · Professional | ungraded | uncertain (evidence) | not verifiable: on 2026-11-19 the calculator showed an identical '₹ 800 / Cost /user/month' on every edition tab (likely a placeholder) and the main pricing page is geo-served in INR; the round-3 'US$23' search excerpt could not be confirmed by opening the page, so the expectation was withdrawn |
| Pipedrive · Professional | ungraded | uncertain (evidence) | not verifiable: pricing page blocks automated fetches (HTTP 403); official-domain search returned no plan prices |

**Completeness (current plans not in the earlier answer):**

- Ground truth (provisional) for Salesforce Sales Cloud: found none; missed Core, Advanced, Max

- Memory: found ([Demo] CRM shortlist for a 20-person sales team), On Monday → Monday, 16 November 2026
- Searches: "HubSpot Sales Hub Professional pricing · hubspot.com" (done, 5); "Salesforce Sales Cloud Enterprise pricing · salesforce.com" (done, 5); "Pipedrive Professional pricing · pipedrive.com" (done, 5); "Salesforce Sales Cloud Enterprise pricing" (done, 5); "HubSpot Sales Hub new features announcement November 2026" (done, 5); "Salesforce Sales Cloud new features announcement November 2026" (done, 5); "Pipedrive new features announcement November 2026" (done, 5); "Zoho CRM Professional pricing · zoho.com" (done, 5); "Zoho CRM new features announcement November 2026" (done, 5); "Freshsales Pro pricing · freshsales.com" (done, 0)

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| HubSpot Sales Hub (Professional) | pricing | $90 per seat/month, billed annually | $90 per seat/month if billed annually | unchanged | price_amount |
| Salesforce Sales Cloud (Enterprise) | pricing | $165 per user/month, billed annually | - | uncertain | evidence |
| Pipedrive (Professional) | pricing | $49 per seat/month, billed annually | - | uncertain | evidence |
| Zoho CRM (Professional) | pricing | $23 per user/month, billed annually | - | uncertain | evidence |
| Freshsales (Pro) | pricing | $39 per user/month, billed annually | - | uncertain | evidence |
| HubSpot Sales Hub (Major update) | product_update | - | - | uncertain | feature |
| Salesforce Sales Cloud (Major update) | product_update | - | Copilotforce partnership announced | changed | feature |
| Pipedrive (Major update) | product_update | - | - | uncertain | feature |
| Zoho CRM (Major update) | product_update | - | - | uncertain | feature |
| Freshsales (Major update) | product_update | - | - | uncertain | feature |

**Answer:**

HubSpot’s pricing stayed the same (still $90 per seat/month when billed annually) [S1]. 
Salesforce announced a major product shift: the Copilotforce partnership, bringing Salesforce into the Microsoft Copilot ecosystem [S9]. 
No verifiable pricing changes or major releases were found for Pipedrive, Zoho, or Freshsales, and we couldn’t confirm any recent updates for them. 

*(Note: this response is based on the seeded demo conversation from Monday.)*

**Sources:**

- [S1] HubSpot’s Sales Hub pricing guide — essential features for every rep (https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)
- [S9] Salesforce and Microsoft Announce Copilotforce - Salesforce (https://salesforce.com/news/stories/copilotforce-announcement), published 2026-11-17

## demo-nov3

> What did I ask you on 3 November? Is your answer still correct today?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| GitHub Copilot · Pro | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Business | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Enterprise | correct | unchanged (price_amount) | matches ground truth |

**Completeness (current plans not in the earlier answer):**

- System listed for GitHub Copilot: Copilot Pro+ ($39 USD per month); Copilot Max ($100 USD per month)
- Ground truth (provisional) for GitHub Copilot: found Pro+, Max

- Memory: found ([Demo] GitHub Copilot plans for a team of 10), 3 November → Tuesday, 3 November 2026
- Searches: "GitHub Copilot pricing 2026" (done, 5); "GitHub Copilot pricing 2026 · github.com" (done, 5); "GitHub Copilot new features announcement November 2026" (done, 5)

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| GitHub Copilot (price) | pricing | $0, with limited completions and chat requests per month | - | uncertain | evidence |
| GitHub Copilot (Copilot Pro) | pricing | $10 per month | $10 USD per month | unchanged | price_amount |
| GitHub Copilot (Copilot Business) | pricing | $19 per user/month | $19 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Copilot Enterprise) | pricing | $39 per user/month (requires GitHub Enterprise Cloud) | $39 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Possible update) | product_update | - | GitHub Copilot moving to usage-based billing | uncertain | feature |

**Answer:**

On 3 Nov 2026 you asked how much GitHub Copilot costs for a team of 10 developers and which plans exist. 
The pricing you were given—$10 / month for Copilot Pro, $19 / seat for Copilot Business, and $39 / seat for Copilot Enterprise—is still accurate today [S5]. That means a 10‑developer team would still pay $190 / month for Business or $390 / month for Enterprise. 

However, two additional plans are now offered that weren’t mentioned in that earlier answer: Copilot Pro+ at $39 / month and Copilot Max at $100 / month [S5]. There is also an announced shift toward usage‑based billing, but it is not yet clear whether that change is in effect [S2].

**Sources:**

- [S2] GitHub Copilot is moving to usage-based billing - The GitHub Blog (https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing)
- [S5] Plans for GitHub Copilot - GitHub Docs (https://docs.github.com/en/copilot/get-started/plans)
- [S7] GitHub Copilot licenses - GitHub Docs (https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses)
- [S9] GitHub Copilot Pricing 2026: Plans, Per-Seat Cost in USD and INR (https://opslyft.com/blog/github-copilot-pricing)

## demo-postgres

> Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| Supabase · Pro | correct | unchanged (price_amount) | matches ground truth |
| Railway · Hobby | correct | unchanged (price_amount) | matches ground truth |
| Neon · Launch | correct | changed (pricing_model) | matches ground truth |
| Render · Basic-1gb | ungraded | uncertain (evidence) | not verifiable: Postgres instance prices are not in the fetched page text (JavaScript-rendered) |
| AWS RDS for PostgreSQL · db.t4g.micro | ungraded | uncertain (evidence) | not verifiable: regional instance price tables are JavaScript-rendered; not fetched |

- Memory: found ([Demo] Managed Postgres hosting options), Last Tuesday → Tuesday, 17 November 2026
- Searches: "Render Postgres Basic-1gb pricing · render.com" (done, 5); "Neon Launch pricing · neon.tech" (done, 5); "Supabase Pro pricing · supabase.com" (done, 5); "Railway Hobby pricing · railway.app" (done, 5); "Supabase Pro pricing" (done, 5); "Neon Launch pricing" (done, 5); "Render Postgres Basic-1gb pricing" (done, 5); "AWS RDS db.t4g.micro pricing" (done, 5); "AWS RDS db.t4g.micro pricing · aws.amazon.com" (done, 5); "Railway Hobby pricing" (done, 5)
- Notes: Interpreted "Last Tuesday" as Tuesday, 17 November 2026 (the most recent such weekday).

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| Neon (Launch) | pricing | $19 per month | $0.106 per CU-hour | changed | pricing_model |
| Supabase (Pro) | pricing | $25 per month per organization | $25 per month | unchanged | price_amount |
| Render (Basic-1gb) | pricing | $19 per month | - | uncertain | evidence |
| AWS RDS for PostgreSQL (db.t4g.micro) | pricing | about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage | - | uncertain | evidence |
| Railway (Hobby) | pricing | $5 per month, including $5 of usage | $5/mo | unchanged | price_amount |

**Answer:**

Neon’s pricing model has changed since the last conversation, while Supabase Pro and Railway Hobby remain the same. Render and AWS RDS pricing details are still unverified. 

- **Neon Launch**: The flat $19 / month rate from 17 Nov 2026 was replaced by a usage‑based model of $0.106 per CU‑hour (plus $0.35 / GB‑month storage) [S7]. 
- **Supabase Pro**: The $25 / month per organization price is unchanged on comparable terms [S2]. 
- **Railway Hobby**: The $5 / month price is still in effect [S5]. 
- **Render Basic‑1 GB**: No current evidence confirms a price; the previous $19 / month figure is uncertain. 
- **AWS RDS db.t4g.micro**: Current on‑demand pricing is not verifiable from the available pages; earlier estimates of ~$12 / month are uncertain. 

The earlier answer (17 Nov 2026) correctly listed Neon at $19 / month, Supabase at $25 / month, Render at $19 / month, AWS RDS at ~$12 / month, and Railway at $5 / month [S2] [S4]. The only confirmed change is Neon’s shift from a flat rate to usage‑based pricing.

**Sources:**

- [S2] Pricing & Fees | Supabase (https://supabase.com/pricing)
- [S4] How much does a database-only Supabase project cost? | Supabase Knowledge Base (https://supabase.com/kb/faqs/platform/database-only-cost)
- [S5] Pricing | Railway Docs (https://docs.railway.app/pricing)
- [S7] What are the limits and quotas for Neon's Free plan? - Neon FAQs (https://neon.tech/unify?a=9b8c4834-5d58-49ee-b654-a9a54a67429a&n=faqs%2Ffree-plan-limits-and-quotas)

## control-research

> What is the current price of the Cursor Pro plan?

- Memory: not_requested
- Searches: "Cursor Pro pricing" (done, 5); "Cursor Pro pricing · cursor.com" (done, 5)

**Answer:**

The Cursor Pro plan is priced at $20 per month [S1] [S3]. It’s now a usage‑credit model that includes $20 of frontier‑model usage per month at API pricing [S1][S2]

**Sources:**

- [S1] Pricing and plans | Cursor Docs (https://cursor.com/help/account-and-billing/pricing)
- [S2] Clarifying our pricing · Cursor (https://cursor.com/blog/june-2025-pricing)
- [S3] Cursor pricing explained: plans, credit system, and real costs in 2026 (https://jetadmin.io/blog/cursor-pricing-explained-plans-credit-system-and-real-costs-in-2026)

## control-chat

> Thanks! What kinds of questions can you help me with?

- Memory: not_requested

**Answer:**

I can help with a wide range of topics, such as:

- **Information & explanations** – facts, definitions, or background on science, history, technology, culture, and more.
- **Practical guidance** – how‑to advice, troubleshooting tips, recipe steps, travel planning, and lifestyle recommendations.
- **Creative support** – brainstorming ideas, drafting stories, poems, emails, or marketing copy.
- **Technical help** – coding assistance, debugging, data analysis explanations, and understanding algorithms.
- **Learning & study aid** – summarizing concepts, explaining difficult subjects, and preparing for exams.
- **Decision making** – comparing options, evaluating pros and cons, and providing insights for choices you’re facing.

Feel free to ask anything that’s on your mind, and I’ll do my best to assist!

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
| 2026-11-19 14:30 | 5/5 | 3 / 4 / 0 / 1 |  |
| 2026-11-19 14:35 | 5/5 | 7 / 1 / 0 / 0 |  |
| 2026-11-19 14:41 | 5/5 | 8 / 1 / 0 / 0 |  |
