# Live evaluation report

Run on 2026-11-14T19:52:05.669Z with `npm run eval:live` · LLM: groq (openai/gpt-oss-20b, openai/gpt-oss-120b) · search: Tavily.
Fresh temporary database seeded with the labelled demo conversations; search cache disabled.
Automatic checks: completed, retrieved the right conversation, searched when expected, every [S#] resolves to a retrieved source.
**Not automatically checked:** whether current prices are factually right. Open the cited sources below to verify.

| Case | Result | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |
|---|---|---|---|---|---|---|
| demo-crm | pass | 15.5s | 4 | 10 | 12878 | 6 / 1 |
| demo-nov3 | pass | 11.5s | 4 | 3 | 13586 | 13 / 1 |
| demo-postgres | pass | 47.4s | 4 | 5 | 11675 | 5 / 0 |
| control-research | pass | 20.4s | 4 | 1 | 5853 | 3 / 2 |
| control-chat | pass | 1.5s | 2 | 0 | 1951 | 0 / 0 |

## demo-crm

> On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?

- Memory: found ([Demo] CRM shortlist for a 20-person sales team), On Monday → Monday, 9 November 2026
- Searches: "Salesforce Sales Cloud Enterprise pricing" (done, 5); "Pipedrive Professional pricing" (done, 5); "HubSpot Sales Hub Professional pricing" (done, 5); "Freshsales Pro pricing" (done, 5); "Zoho CRM Professional pricing" (done, 5); "HubSpot Sales Hub new features announcement November 2026" (done, 5); "Salesforce Sales Cloud new features announcement November 2026" (done, 5); "Zoho CRM new features announcement November 2026" (done, 2); "Pipedrive new features announcement November 2026" (done, 2); "Freshsales new features announcement November 2026" (done, 5)

| Subject | Category | Then | Now | Status |
|---|---|---|---|---|
| HubSpot Sales Hub (Professional) | pricing | $90 per seat/month, billed annually | $90/mo/seat, billed annually | uncertain |
| Salesforce Sales Cloud (Enterprise) | pricing | $165 per user/month, billed annually | - | uncertain |
| Pipedrive (Professional) | pricing | $49 per seat/month, billed annually | $49 per user per month, billed annually | uncertain |
| Zoho CRM (Professional) | pricing | $23 per user/month, billed annually | $23 per user/month, billed annually | unchanged |
| Freshsales (Pro) | pricing | $39 per user/month, billed annually | $39/user/mo, billed annually | unchanged |
| HubSpot Sales Hub (Major update) | product_update | - | - | uncertain |
| Salesforce Sales Cloud (Major update) | product_update | - | - | uncertain |
| Pipedrive (Major update) | product_update | - | - | uncertain |
| Zoho CRM (Major update) | product_update | - | - | uncertain |
| Freshsales (Major update) | product_update | - | - | uncertain |

**Answer:**

No new pricing or major releases have been confirmed for Zoho CRM or Freshsales, while the other three tools have uncertain status. 

**What was discussed on 9 Nov 2026** 
- We shortlisted HubSpot Sales Hub Professional, Salesforce Sales Cloud Enterprise, Pipedrive Professional, Zoho CRM Professional, and Freshsales Pro for a 20‑person sales team.

**Pricing changes (current evidence)** 
- **Zoho CRM Professional** – price unchanged at $23 per user/month, billed annually[S6]. 
- **Freshsales Pro** – price unchanged at $39 per user/month, billed annually[S4]. 
- **HubSpot Sales Hub Professional** – sources conflict ($90 vs. $100 per seat/month) and no definitive change is documented[S1]. 
- **Salesforce Sales Cloud Enterprise** – no current price listed; only the Professional plan appears at $165 per user/month[S5]. 
- **Pipedrive Professional** – only a third‑party 2024 source lists $49 per user/month; no update is confirmed[S9].

**Major product updates** 
No evidence of a major update for any of the five CRMs appears in the current sources; the lack of post‑November‑2026 announcements in the data set does not prove nothing shipped, but no new releases are documented.

*Note:* The memory of this discussion is from a seeded demo conversation dated Monday, 9 November 2026.

**Sources:**

- [S1] Sales Software Pricing | HubSpot (https://hubspot.com/pricing/sales)
- [S4] Freshsales Pricing 2026: $9 to $59/User (Real TCO After Hidden Add-Ons) | Blog | MarketBetter (https://marketbetter.ai/blog/freshsales-pricing-breakdown-2026)
- [S5] Salesforce Sales Cloud Pricing in 2026: What Enterprises Actually Pay (https://vendorbenchmark.com/vendors/salesforce-sales-cloud-pricing)
- [S6] Zoho CRM Pricing Explained: Plans and Real Costs (2026) (https://i2webservices.com/pricing/zoho-crm-pricing)
- [S9] How much does Pipedrive cost in 2024? | Pipedrive Pricing (https://lessannoyingcrm.com/crm-pricing/how-much-does-pipedrive-cost)

## demo-nov3

> What did I ask you on 3 November? Is your answer still correct today?

- Memory: found ([Demo] GitHub Copilot plans for a team of 10), 3 November → Tuesday, 3 November 2026
- Searches: "GitHub Copilot Business pricing 2026" (done, 5); "GitHub Copilot new features announcement November 2026" (done, 5); "GitHub Copilot Pro pricing 2026" (done, 5)

| Subject | Category | Then | Now | Status |
|---|---|---|---|---|
| GitHub Copilot (price) | pricing | $0, with limited completions and chat requests per month | - | uncertain |
| GitHub Copilot (Copilot Pro) | pricing | $10 per month | $10 per month | unchanged |
| GitHub Copilot (Copilot Business) | pricing | $19 per user/month | $19/user/month, including $19 in monthly AI Credits | unchanged |
| GitHub Copilot (Copilot Enterprise) | pricing | $39 per user/month (requires GitHub Enterprise Cloud) | $39/user/month, including $39 in monthly AI Credits | unchanged |
| GitHub Copilot (Major update) | product_update | - | Copilot added to JetBrains Air and Xcode | changed |

**Answer:**

The user asked on 3 Nov 2026 how much GitHub Copilot costs for a team of ten developers and what plans were available. That answer remains accurate today: Copilot Pro is $10 per user per month, Copilot Business is $19 per user per month (so $190 per month for ten users), and Copilot Enterprise is $39 per user per month [S4][S1]. The free tier still exists but has usage limits, and no evidence indicates it has changed. 

- **What was discussed then (3 Nov 2026)** 
 The question was about pricing and plan options for a 10‑person team. 

- **Has anything changed?** 
 Pricing for Pro, Business, and Enterprise tiers is unchanged according to current evidence and the comparison table. 

- **Unverified or missing** 
 The free tier’s limits are not reflected in the evidence, so no citation is provided for that detail. 

*Note: the conversation referenced here is seeded demo data.*

**Sources:**

- [S1] GitHub Copilot is moving to usage-based billing - The GitHub Blog (https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing)
- [S4] GitHub Copilot Pro 价格：2026 套餐、AI Credits 与用量账单 | Omid Saffari (https://omidsaffari.com/zh-cn/blog/github-copilot-pricing-zh-cn)
- [S5] GitHub Copilot in Xcode and JetBrains Air: 2 Days [2026] (https://shattered.io/github-copilot-xcode-jetbrains-air-two-days-2026), published 2026-11-06
- [S7] GitHub Copilot Pricing 2026: Free, Pro, Pro+, Max and Business - Credit for Startups (https://creditforstartups.com/resources/github-copilot-pricing)
- [S8] GitHub Copilot Pricing: Definitive Guide 2026 (https://techjacksolutions.com/ai-tools/github-copilot/github-copilot-pricing)
- [S9] GitHub Copilot Business Pricing ($19/seat/mo) (https://aipricing.guru/subscriptions/github-copilot-business)

## demo-postgres

> Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?

- Memory: found ([Demo] Managed Postgres hosting options), Last Tuesday → Tuesday, 10 November 2026
- Searches: "Supabase Pro pricing" (done, 5); "Neon Launch pricing" (done, 5); "Render Postgres Basic-1gb pricing" (done, 5); "Railway Hobby pricing" (done, 5); "AWS RDS db.t4g.micro pricing" (done, 5)
- Notes: Interpreted "Last Tuesday" as Tuesday, 10 November 2026 (the most recent such weekday).

| Subject | Category | Then | Now | Status |
|---|---|---|---|---|
| Neon Launch (Neon Launch) | pricing | $19 per month | $0.106/CU-hour; $0.35/GB-month | not_comparable |
| Supabase Pro (Supabase Pro) | pricing | $25 per month per organization | $25/org/month | unchanged |
| Render Postgres Basic-1gb (Render Postgres Basic-1gb) | pricing | $19 per month | $19/month | unchanged |
| AWS RDS for PostgreSQL (db.t4g.micro) (AWS RDS for PostgreSQL (db.t4g.micro)) | pricing | about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage | $0.016/hr | unchanged |
| Railway Hobby (Railway Hobby) | pricing | $5 per month, including $5 of usage | $5 / month | unchanged |

**Answer:**

The only pricing shift since last Tuesday is Neon Launch, which moved from a flat $19‑per‑month plan to a usage‑based model at $0.106 per CU‑hour and $0.35 per GB‑month [S12]. Supabase Pro, Render Postgres Basic‑1gb, AWS RDS db.t4g.micro, and Railway Hobby have kept their current prices unchanged [S4][S1][S10][S2]. This is based on the latest comparison data; no other provider’s pricing has been updated.

**Sources:**

- [S1] Pricing | Render (https://render.com/exp/c557451f-e48b-4281-a0a6-e3f1de93c47a)
- [S2] Pricing Plans | Railway Docs (https://docs.railway.com/pricing/plans)
- [S4] Supabase pricing: plans, free tier, and hidden costs (https://cloudzero.com/blog/supabase-pricing)
- [S10] Amazon RDS Pricing | Every Engine Cost & Hidden Fee (2026) (https://go-cloud.io/amazon-rds-pricing)
- [S12] Neon Pricing 2026: Plans, Costs & Limits (https://jetadmin.io/blog/neon-pricing)

## control-research

> What is the current price of the Cursor Pro plan?

- Memory: not_requested
- Searches: "Cursor Pro plan pricing" (done, 5)

**Answer:**

The Cursor Pro plan costs **$20 per month**[S1][S3][S5].

**Sources:**

- [S1] Cursor pricing explained: plans, credit system, and real costs in 2026 (https://jetadmin.io/blog/cursor-pricing-explained-plans-credit-system-and-real-costs-in-2026)
- [S3] Cursor Pricing July 2026: Free, Pro, Ultra and Teams Costs | NxCode (https://nxcode.io/resources/news/cursor-ai-pricing-plans-guide-2026)
- [S5] Cursor Pricing in 2026: Every Plan | Coworker AI (https://coworker.ai/blog/cursor-pricing)

## control-chat

> Thanks! What kinds of questions can you help me with?

- Memory: not_requested

**Answer:**

I can help with a wide range of topics—from answering factual queries and explaining concepts to assisting with writing, brainstorming ideas, and offering general advice. If you have a specific question or task in mind, just let me know!
