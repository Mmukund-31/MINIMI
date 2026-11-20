# Live evaluation report

Run on 2026-11-20T06:56:20.379Z with `npm run eval:live` · LLM: groq (openai/gpt-oss-20b, openai/gpt-oss-120b) · search: Tavily. Re-rendered from the saved run `live-2026-11-20T06-56-20-379Z.json`; ground-truth grading and the entity check were recomputed with the current grader, everything else is as recorded.
Fresh temporary database seeded with the labelled demo conversations; search cache disabled; 20s pause between cases (one user asking one question at a time; Groq free-tier limits are per minute).

**Automatic checks (pass/fail):** completed · retrieved the right earlier conversation · searched when expected · every [S#] resolves to a retrieved source · research answers cite something · every vendor from the earlier conversation has a comparison row · structural checks (no verdict without an official source or an explicit third-party qualification, no amount change across incompatible terms, no 'changed' resting on a page published before the conversation).

**Ground-truth grading** uses [ground-truth.json](ground-truth.json) (official pages fetched 2026-11-19). Entries not marked `human-confirmed` make the grade **PROVISIONAL**. *abstained* = honest uncertain/not-comparable where a verdict was possible; *wrong* = a confident verdict the ground truth contradicts.

| Case | Auto checks | Ground truth (correct / abstained / wrong / missing · ungraded) | Plan attribution verified | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |
|---|---|---|---|---|---|---|---|---|
| demo-crm | pass | 3 / 0 / 0 / 0 · 2 (provisional) | 3/4 | 7.1s | 4 | 10 | 13722 | 6 / 1 |
| demo-nov3 | pass | 3 / 0 / 0 / 0 · 0 (provisional) | 7/7 | 12.7s | 4 | 4 | 13207 | 9 / 0 |
| demo-postgres | pass | 3 / 0 / 0 / 0 · 2 (provisional) | 6/6 | 7.6s | 4 | 10 | 12858 | 7 / 0 |
| control-research | pass | – | 2/2 | 3.8s | 4 | 2 | 13023 | 2 / 0 |
| control-chat | pass | – | – | 1.4s | 2 | 0 | 2885 | 0 / 0 |

## demo-crm

> On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| Freshsales · Pro | correct | unchanged (price_amount) | matches ground truth |
| HubSpot Sales Hub · Professional | correct | unchanged (price_amount) | matches ground truth |
| Salesforce Sales Cloud · Enterprise | correct | uncertain (evidence) | matches ground truth |
| Zoho CRM · Professional | ungraded | uncertain (evidence) | not verifiable: on 2026-11-19 the calculator showed an identical '₹ 800 / Cost /user/month' on every edition tab (likely a placeholder) and the main pricing page is geo-served in INR; the round-3 'US$23' search excerpt could not be confirmed by opening the page, so the expectation was withdrawn |
| Pipedrive · Professional | ungraded | uncertain (evidence) | not verifiable: pricing page blocks automated fetches (HTTP 403); official-domain search returned no plan prices |

**Completeness (current plans not in the earlier answer):**

- Ground truth (provisional) for Salesforce Sales Cloud: found none; missed Core, Advanced, Max

- Memory: found ([Demo] CRM shortlist for a 20-person sales team), On Monday → Monday, 16 November 2026
- Searches: "HubSpot Sales Hub Professional pricing 2026 · hubspot.com" (done, 5); "Salesforce Sales Cloud Enterprise pricing 2026 · salesforce.com" (done, 5); "Pipedrive Professional pricing 2026 · pipedrive.com" (done, 5); "Freshsales Pro pricing 2026 · freshworks.com" (done, 5); "Zoho CRM Professional pricing 2026 · zoho.com" (done, 5); "Salesforce Sales Cloud new features announcement November 2026" (done, 5); "HubSpot Sales Hub new features announcement November 2026" (done, 5); "Zoho CRM new features announcement November 2026" (done, 5); "Pipedrive new features announcement November 2026" (done, 5); "Freshsales new features announcement November 2026" (done, 5)

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| HubSpot Sales Hub (Professional) | pricing | $90 per seat/month, billed annually | $90/month per user (billed annually) | unchanged | price_amount |
| Salesforce Sales Cloud (Enterprise) | pricing | $165 per user/month, billed annually | - | uncertain | evidence |
| Pipedrive (Professional) | pricing | $49 per seat/month, billed annually | - | uncertain | evidence |
| Zoho CRM (Professional) | pricing | $23 per user/month, billed annually | - | uncertain | evidence |
| Freshsales (Pro) | pricing | $39 per user/month, billed annually | $39/user/month, billed annually | unchanged | price_amount |
| HubSpot Sales Hub (Major update) | product_update | - | - | uncertain | feature |
| Salesforce Sales Cloud (Major update) | product_update | - | Copilotforce partnership announced | changed | feature |
| Pipedrive (Major update) | product_update | - | - | uncertain | feature |
| Zoho CRM (Major update) | product_update | - | - | uncertain | feature |
| Freshsales (Major update) | product_update | - | - | uncertain | feature |

**Answer:**

HubSpot Sales Hub Professional and Freshsales Pro keep the same annual price as we noted on Monday (HubSpot $90 and Freshsales $39 per user) [S1][S2]. 
Salesforce Sales Cloud Enterprise’s current price isn’t publicly confirmed in the vendor’s own page, so we can’t verify whether it has changed [S7]. However, Salesforce announced a major Copilotforce partnership on November 17 2026, a notable product update [S9]. 
No major feature or pricing changes were found for Pipedrive, Zoho CRM, or the other plans in the time since our last discussion. 

*(seeded demo data)*

I couldn't verify current prices for Salesforce Sales Cloud Enterprise, Pipedrive Professional or Zoho CRM Professional: no retrievable page stated a price for these plans, so I can't say whether they changed.

**Sources:**

- [S1] HubSpot’s Sales Hub pricing guide — essential features for every rep (https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)
- [S2] Freshsales CRM Pricing Comparison | Freshsales (https://freshworks.com/crm/pricing-compare)
- [S7] Salesforce Sales Pricing | Salesforce (https://salesforce.com/sales/pricing)
- [S9] Salesforce and Microsoft Announce Copilotforce - Salesforce (https://salesforce.com/news/stories/copilotforce-announcement), published 2026-11-17

## demo-nov3

> What did I ask you on 3 November? Is your answer still correct today?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| GitHub Copilot · Pro | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Business | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Enterprise | correct | unchanged (price_amount) | matches ground truth |

**Completeness (current plans not in the earlier answer):**

- System listed for GitHub Copilot: Copilot Student (Free); Copilot Pro+ ($39 USD per month.); Copilot Max ($100 USD per month)
- Ground truth (provisional) for GitHub Copilot: found Pro+, Max

- Memory: found ([Demo] GitHub Copilot plans for a team of 10), 3 November → Tuesday, 3 November 2026
- Searches: "GitHub Copilot new features announcement November 2026" (done, 5); "GitHub Copilot 2026 updates" (done, 5); "GitHub Copilot pricing 2026 · github.com" (done, 5); "GitHub Copilot pricing 2026" (done, 5)

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| GitHub Copilot (Copilot Pro) | pricing | $10 per month | $10 USD per month (free for some users) | unchanged | price_amount |
| GitHub Copilot (Copilot Business) | pricing | $19 per user/month | $19 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Copilot Enterprise) | pricing | $39 per user/month | $39 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Possible update) | product_update | - | GitHub Copilot is moving to usage-based billing | uncertain | feature |

**Answer:**

You asked on 3 Nov 2026 how much GitHub Copilot would cost a team of 10 developers and what plans were available. That answer – listing Copilot Free, Copilot Pro ($10 / user / month), Copilot Business ($19 / seat / month), and Copilot Enterprise ($39 / seat / month) – was correct then [S5]. 

**What changed since then** 
GitHub switched Copilot to usage‑based billing from 1 June 2026, so the fixed per‑seat prices are no longer the billing basis; cost now depends on AI‑credit usage or Actions minutes consumed [S2][S7]. 

**What remains true** 
The names of the plans (Free, Pro, Business, Enterprise) and the per‑seat price amounts for those plans were unchanged at the time of the earlier answer [S5], and the Enterprise plan still requires GitHub Enterprise Cloud [S5]. 

**New offerings now** 
In addition to the plans mentioned earlier, GitHub now offers Copilot Student (Free) and higher‑tier plans such as Copilot Pro+ ($39 / month) and Copilot Max ($100 / month), which were not part of the 3 Nov 2026 answer [S5].

**Sources:**

- [S2] GitHub Copilot is moving to usage-based billing - The GitHub Blog (https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing)
- [S5] Plans for GitHub Copilot - GitHub Docs (https://docs.github.com/en/copilot/get-started/plans)
- [S7] The new GitHub Copilot plans are an absolute disaster · community · Discussion #197782 · GitHub (https://github.com/orgs/community/discussions/197782)

## demo-postgres

> Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| Supabase · Pro | correct | unchanged (price_amount) | matches ground truth |
| Railway · Hobby | correct | unchanged (price_amount) | matches ground truth |
| Neon · Launch | correct | uncertain (pricing_model) | matches ground truth (already_outdated) |
| Render · Basic-1gb | ungraded | uncertain (evidence) | not verifiable: Postgres instance prices are not in the fetched page text (JavaScript-rendered) |
| AWS RDS for PostgreSQL · db.t4g.micro | ungraded | uncertain (evidence) | not verifiable: regional instance price tables are JavaScript-rendered; not fetched |

- Memory: found ([Demo] Managed Postgres hosting options), Last Tuesday → Tuesday, 17 November 2026
- Searches: "Render Postgres Basic-1gb pricing · render.com" (done, 5); "Supabase Pro pricing · supabase.com" (done, 5); "Neon Launch pricing · neon.tech" (done, 5); "Railway Hobby pricing · railway.app" (done, 5); "Neon Launch pricing" (done, 5); "AWS RDS db.t4g.micro pricing · aws.amazon.com" (done, 5); "Supabase Pro pricing" (done, 5); "AWS RDS db.t4g.micro pricing" (done, 5); "Render Postgres Basic-1gb pricing" (done, 5); "Neon Launch pricing change (timing check)" (done, 5)
- Notes: Interpreted "Last Tuesday" as Tuesday, 17 November 2026 (the most recent such weekday).

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| Neon Launch (Neon Launch) | pricing | $19 per month | $0.106 per CU-hour and $0.35 per GB-month | uncertain | pricing_model |
| Supabase Pro (Supabase Pro) | pricing | $25 per month per organization | $25/ month | unchanged | price_amount |
| Render Postgres Basic-1gb (Render Postgres Basic-1gb) | pricing | $19 per month | - | uncertain | evidence |
| AWS RDS for PostgreSQL (db.t4g.micro) (AWS RDS for PostgreSQL (db.t4g.micro)) | pricing | about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage | - | uncertain | evidence |
| Railway Hobby (Railway Hobby) | pricing | $5 per month, including $5 of usage | $5/mo | unchanged | price_amount |

**Answer:**

Neon’s pricing model has shifted to usage‑based, Supabase Pro and Railway Hobby have stayed the same, and there is no current evidence that Render or AWS RDS changed.

- **Neon Launch** – The plan now charges $0.106 per CU‑hour and $0.35 per GB‑month, with no monthly minimum [S4][S6]. 
 The earlier answer already listed this model before the 2026‑11‑17 conversation, so nothing has changed since then. 
- **Supabase Pro** – Still $25 per month per organization [S1]. 
- **Railway Hobby** – Still $5 per month (subscription includes $5 of usage) [S3]. 
- **Render Postgres Basic‑1gb** – No current pricing evidence is available; the latest pages did not reveal a price [S9]. 
- **AWS RDS (db.t4g.micro)** – No current pricing evidence is available; the latest pages did not reveal a price [S10].

I couldn't verify current prices for Render Postgres Basic-1gb or AWS RDS for PostgreSQL (db.t4g.micro): no retrievable page stated a price for these plans, so I can't say whether they changed.

Neon Launch: The vendor's own page (dated 2025-08-14, from its byline, before our conversation on 2026-11-17) already listed Neon Launch as usage-based ($0.106 per CU-hour) [S4] [S6]. The earlier answer was likely already out of date when given; this doesn't show a change since then. [S4][S6]

**Sources:**

- [S1] Pricing & Fees | Supabase (https://supabase.com/pricing)
- [S3] Pricing | Railway Docs (https://docs.railway.com/pricing)
- [S4] What are the limits and quotas for Neon's Free plan? - Neon FAQs (https://neon.com/faqs/free-plan-limits-and-quotas)
- [S6] Neon’s New Pricing, Explained: Usage-Based, No Minimum (https://neon.com/blog/new-usage-based-pricing)
- [S9] How much does cloud application hosting cost for small businesses (https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)
- [S10] Amazon RDS for MySQL pricing (https://aws.amazon.com/rds/mysql/pricing)

## control-research

> What is the current price of the Cursor Pro plan?

- Memory: not_requested
- Searches: "Cursor Pro plan pricing" (done, 5); "Cursor Pro plan pricing · cursor.so" (done, 5)

**Answer:**

Cursor Pro is no longer offered to new customers; it is a legacy plan listed as $20 / mo in the old pricing schedule [S1]. New users must choose the next tier, Premium, which costs $30 / mo [S3]. If you are an existing Pro subscriber you can keep the plan until you decide to upgrade or cancel [S1].

**Sources:**

- [S1] Pricing and plans | Cursor Docs (https://cursor.com/help/account-and-billing/pricing)
- [S3] Models & Pricing | Cursor Docs (https://cursor.com/docs/models-and-pricing)

## control-chat

> Thanks! What kinds of questions can you help me with?

- Memory: not_requested

**Answer:**

I can help with a wide range of questions—anything from quick facts and explanations to deeper research, summarizations, data interpretation, or brainstorming ideas. Just let me know what you need!

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
| 2026-11-19 17:47 | 4/5 | 8 / 1 / 0 / 0 |  |
| 2026-11-20 06:30 | 5/5 | 8 / 1 / 0 / 0 |  |
| 2026-11-20 06:34 | 4/5 | 8 / 1 / 0 / 0 |  |
| 2026-11-20 06:39 | 5/5 | 9 / 0 / 0 / 0 |  |
| 2026-11-20 06:43 | 5/5 | 8 / 1 / 0 / 0 |  |
| 2026-11-20 06:46 | 5/5 | 9 / 0 / 0 / 0 |  |
| 2026-11-20 06:50 | 5/5 | 8 / 1 / 0 / 0 |  |
| 2026-11-20 06:52 | 5/5 | 9 / 0 / 0 / 0 |  |
| 2026-11-20 06:56 | 5/5 | 9 / 0 / 0 / 0 |  |
| 2026-11-20 07:06 | 4/5 | 9 / 0 / 0 / 0 |  |
| 2026-11-20 07:08 | 1/5 | 3 / 0 / 0 / 6 | 4 case(s) failed: daily quota exhausted |
| 2026-11-20 07:11 | 0/5 | 0 / 0 / 0 / 9 | 5 case(s) failed: daily quota exhausted |
