# Live evaluation report

Run on 2026-11-20T07:57:47.554Z with `npm run eval:live` · LLM: groq (openai/gpt-oss-20b, openai/gpt-oss-120b) · search: Tavily. Re-rendered from the saved run `live-2026-11-20T07-57-47-554Z.json`; ground-truth and completeness grading and the entity check were recomputed with the current grader and ground truth, everything else is as recorded.
Fresh temporary database seeded with the labelled demo conversations; search cache disabled; 20s pause between cases (one user asking one question at a time; Groq free-tier limits are per minute).

**Automatic checks (pass/fail):** completed · retrieved the right earlier conversation · searched when expected · every [S#] resolves to a retrieved source · research answers cite something · every vendor from the earlier conversation has a comparison row · structural checks (no verdict without an official source or an explicit third-party qualification, no amount change across incompatible terms, no 'changed' resting on a page published before the conversation).

**Ground-truth grading** uses [ground-truth.json](ground-truth.json). Official pages were first fetched 2026-11-19; the project author re-reviewed the expectations on 2026-11-20 and marked every graded entry `human-confirmed` (a review date, separate from the run date above). Every grade in this run uses `human-confirmed` entries, so none is provisional. Vendor/plan entries whose price could not be verified on the official page have no expected value and stay ungraded (never guessed). *abstained* = honest uncertain/not-comparable where a verdict was possible; *wrong* = a confident verdict the ground truth contradicts.

| Case | Auto checks | Ground truth (correct / abstained / wrong / missing · ungraded) | Plan attribution verified | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |
|---|---|---|---|---|---|---|---|---|
| demo-crm | pass | 3 / 0 / 0 / 0 · 2 | 3/4 | 15.7s | 4 | 10 | 13190 | 8 / 0 |
| demo-nov3 | pass | 3 / 0 / 0 / 0 · 0 | 22/23 | 16.4s | 4 | 5 | 15768 | 24 / 4 |
| demo-postgres | pass | 3 / 0 / 0 / 0 · 2 | 8/8 | 21.7s | 4 | 10 | 12947 | 11 / 0 |
| control-research | pass | – | 4/4 | 14.8s | 4 | 2 | 10414 | 5 / 0 |
| control-chat | pass | – | – | 1.6s | 2 | 0 | 3108 | 0 / 0 |

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

- Ground truth for Salesforce Sales Cloud: found none; missed Core, Advanced, Max

- Memory: found ([Demo] CRM shortlist for a 20-person sales team), On Monday → Monday, 16 November 2026
- Searches: "HubSpot Sales Hub Professional pricing 2026 · hubspot.com" (done, 5); "Pipedrive Professional pricing 2026 · pipedrive.com" (done, 5); "Salesforce Sales Cloud Enterprise pricing 2026 · salesforce.com" (done, 5); "HubSpot Sales Hub new features announcement November 2026" (done, 5); "Salesforce Sales Cloud new features announcement November 2026" (done, 5); "Zoho CRM Professional pricing 2026 · zoho.com" (done, 5); "Freshsales Pro pricing 2026 · freshworks.com" (done, 5); "Pipedrive new features announcement November 2026" (done, 2); "Freshsales new features announcement November 2026" (done, 5); "Zoho CRM new features announcement November 2026" (done, 5)

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
| Zoho CRM (Possible update) | product_update | - | Zoho Desk adds Blended Agents built on Zia Agents | uncertain | feature |
| Freshsales (Major update) | product_update | - | - | uncertain | feature |

**Answer:**

Only Salesforce’s feature set has changed – the Copilotforce partnership was announced on Nov 17 2026 [S8]. 
HubSpot Sales Hub and Freshsales kept the same pricing we listed before: $90 per user/month (annual) for HubSpot [S1] and $39 per user/month (annual) for Freshsales [S2]. 
No new prices or major releases have been confirmed for Salesforce, Pipedrive, or Zoho, so their current terms are still unverified and no additional features were noted.

**Sources:**

- [S1] HubSpot’s Sales Hub pricing guide — essential features for every rep (https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)
- [S2] Freshsales CRM Pricing Comparison | Freshsales (https://freshworks.com/crm/pricing-compare)
- [S8] Salesforce and Microsoft Announce Copilotforce - Salesforce (https://salesforce.com/news/stories/copilotforce-announcement), published 2026-11-17
- [S11] Zoho Desk adds Blended Agents built on Zia Agents (https://forgex.ai/news/zoho-desk-adds-blended-agents-built-on-zia-agents), published 2026-11-16

## demo-nov3

> What did I ask you on 3 November? Is your answer still correct today?


| Ground truth | Grade | System said | Why |
|---|---|---|---|
| GitHub Copilot · Pro | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Business | correct | unchanged (price_amount) | matches ground truth |
| GitHub Copilot · Enterprise | correct | unchanged (price_amount) | matches ground truth |

**Completeness (current plans not in the earlier answer):**

- System listed for GitHub Copilot: Copilot Pro+ ($39 USD per month); Copilot Max ($100 USD per month)
- Ground truth for GitHub Copilot: found Pro+, Max

- Memory: found ([Demo] GitHub Copilot plans for a team of 10), 3 November → Tuesday, 3 November 2026
- Searches: "GitHub Copilot Enterprise pricing · github.com" (done, 5); "GitHub Copilot Business pricing · github.com" (done, 5); "GitHub Copilot new features announcement November 2026" (done, 5); "GitHub Copilot Business pricing" (done, 5); "GitHub Copilot Enterprise pricing" (done, 5)

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| GitHub Copilot (price) | pricing | $0 | - | uncertain | evidence |
| GitHub Copilot (Copilot Pro) | pricing | $10 per month | $10 USD per month | unchanged | price_amount |
| GitHub Copilot (Copilot Business) | pricing | $19 per user/month | $19 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Copilot Enterprise) | pricing | $39 per user/month (requires GitHub Enterprise Cloud) | $39 USD per granted seat per month | unchanged | price_amount |
| GitHub Copilot (Possible update) | product_update | - | Transition to usage‑based billing | uncertain | feature |

**Answer:**

You asked on 3 Nov: “How much does GitHub Copilot cost for a team of 10 developers? What plans are there?” 

The pricing you received—Copilot Pro $10 / month, Business $19 / seat, Enterprise $39 / seat—remains accurate today; the prices are unchanged per the official list [S4]. 

What has changed: GitHub now also offers Copilot Pro+ at $39 / month and Copilot Max at $100 / month, which were not included in the earlier reply [S4] [S1]. The earlier answer is still correct for the plans it named, but it is incomplete relative to the current full set of offerings.

**Sources:**

- [S1] GitHub Copilot seats and billing cycles for organizations and enterprises - GitHub Docs (https://docs.github.com/copilot/concepts/billing/organizations-and-enterprises)
- [S4] Plans for GitHub Copilot - GitHub Docs (https://docs.github.com/en/copilot/get-started/plans)
- [S2] Choosing your enterprise's plan for GitHub Copilot - GitHub Docs (https://docs.github.com/copilot/get-started/choose-enterprise-plan)
- [S3] GitHub Copilot is moving to usage-based billing - The GitHub Blog (https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing)
- [S6] GitHub Copilot licenses - GitHub Docs (https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses)
- [S9] Github Copilot Individual or Business Subscription · community · Discussion #195495 · GitHub (https://github.com/orgs/community/discussions/195495)
- [S11] GitHub Copilot Pricing Plans, Hidden Costs, and 5 Ways to Control Them (https://finout.io/blog/github-copilot-pricing-plans-hidden-costs-and-5-ways-to-control-them)
- [S12] GitHub Copilot Business Pricing ($19/seat/mo) (https://aipricing.guru/subscriptions/github-copilot-business)

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
- Searches: "Supabase Pro pricing 2026 · supabase.com" (done, 5); "Neon Launch pricing 2026 · neon.tech" (done, 5); "Render Postgres Basic-1gb pricing 2026 · render.com" (done, 5); "Railway Hobby pricing 2026 · railway.app" (done, 5); "Neon Launch pricing 2026" (done, 5); "AWS RDS PostgreSQL db.t4g.micro pricing 2026 · aws.amazon.com" (done, 5); "Supabase Pro pricing 2026" (done, 5); "Render Postgres Basic-1gb pricing 2026" (done, 5); "AWS RDS PostgreSQL db.t4g.micro pricing 2026" (done, 5); "Neon Launch pricing change (timing check)" (done, 5)
- Notes: Interpreted "Last Tuesday" as Tuesday, 17 November 2026 (the most recent such weekday).

| Subject | Category | Then | Now | Status | Dimension |
|---|---|---|---|---|---|
| Neon (Launch) | pricing | $19 per month | $0.106 per CU-hour | uncertain | pricing_model |
| Supabase (Pro) | pricing | $25 per month per organization | $25 per month | unchanged | price_amount |
| Render (Postgres Basic-1gb) | pricing | $19 per month | - | uncertain | evidence |
| AWS (RDS for PostgreSQL (db.t4g.micro)) | pricing | about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage | - | uncertain | evidence |
| Railway (Hobby) | pricing | $5 per month, including $5 of usage | $5/mo | unchanged | price_amount |

**Answer:**

**Short answer:** 
Neon’s pricing model has shifted to usage‑based (≈$0.106 per CU‑hour) instead of a flat $19 /month plan [S2] [S4]. Supabase Pro, Railway Hobby, and (by the data we have) Render and AWS remain unchanged or cannot be verified.

**What was discussed then (17 Nov 2026):** 
You asked for a side‑project‑ready Postgres hosting comparison. The answer listed Neon Launch at $19 /month, Supabase Pro at $25 /month, Render Basic‑1 GB at $19 /month, AWS RDS db.t4g.micro at ~$12 /month, and Railway Hobby at $5 /month [S6] [S8].

**What changed:** 
*Neon Launch* – the plan is now fully usage‑based, $0.106 per compute‑unit hour, not a fixed monthly fee [S2].

**What stayed the same:** 
*Supabase Pro* – still $25 /month per organization [S6]. 
*Railway Hobby* – still $5 /month (includes first $5 of usage) [S7].

**What could not be confirmed:** 
Render’s Basic‑1 GB and AWS RDS db.t4g.micro pricing could not be retrieved; the vendor pages are not reliably accessible for automated scraping, so we have no current evidence [S9][S10].

*(Seeded demo data was used to reconstruct the prior answer.)*

Neon Launch: The vendor's own page (dated 2025-08-14, from its byline, before our conversation on 2026-11-17) already listed Launch as usage-based ($0.106 per CU-hour) [S2] [S4]. The earlier answer was likely already out of date when given; this doesn't show a change since then. [S2]

**Sources:**

- [S2] Neon’s New Pricing, Explained: Usage-Based, No Minimum (https://neon.com/blog/new-usage-based-pricing)
- [S4] Making pricing more predictable (https://neon.com/blog/making-pricing-more-predictable)
- [S6] Pricing & Fees | Supabase (https://supabase.com/pricing)
- [S7] Pricing | Railway Docs (https://docs.railway.com/pricing)
- [S8] How much does a database-only Supabase project cost? | Supabase Knowledge Base (https://supabase.com/kb/faqs/platform/database-only-cost)
- [S9] How much does cloud application hosting cost for small businesses (https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)
- [S10] Amazon RDS for PostgreSQL Pricing (https://aws.amazon.com/rds/postgresql/pricing)

## control-research

> What is the current price of the Cursor Pro plan?

- Memory: not_requested
- Searches: "Cursor Pro plan pricing · cursor.so" (done, 5); "Cursor Pro plan pricing" (done, 5)

**Answer:**

Cursor Pro is priced at $20 per month [S1][S4]. 
This is a legacy plan and is no longer available to new customers; the nearest current individual tier is Premium at $30 per month [S3].

**Sources:**

- [S1] Pricing and plans | Cursor Docs (https://cursor.com/help/account-and-billing/pricing)
- [S3] Models & Pricing | Cursor Docs (https://cursor.com/docs/models-and-pricing)
- [S4] Clarifying our pricing · Cursor (https://cursor.com/blog/june-2025-pricing)

## control-chat

> Thanks! What kinds of questions can you help me with?

- Memory: not_requested

**Answer:**

I don’t have a record of a prior conversation with you, so I’m starting fresh. I can help with a wide range of questions—from general knowledge, research, and summarizing text to math, coding, language learning, and practical advice on many topics.

## Run history

Every complete live run saved in `evals/results/` (checks and grades as recorded by the code and ground truth of that time, not re-graded with the current grader; grades recorded before the human review on 2026-11-20, including that morning's development runs, were made against then-provisional ground truth, and the review changed no expectation; earlier runs had fewer checks; live results vary because search results and model outputs vary).

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
| 2026-11-20 07:35 | 0/5 | 0 / 0 / 0 / 9 | 5 case(s) failed: daily quota exhausted |
| 2026-11-20 07:57 | 5/5 | 9 / 0 / 0 / 0 |  |
