import { DateTime } from "luxon";
import type { Db } from "../db/connection";
import { transaction } from "../db/connection";
import type { Repositories } from "../db/repositories";

/**
 * SEEDED DEMONSTRATION DATA
 *
 * Inserts the conversations needed by the challenge's three example prompts.
 * Every seeded conversation and message carries `metadata.seeded = true`, the
 * title is prefixed with "[Demo]", and the UI shows a "Seeded demo" badge, so
 * seeded history is never presented as the user's real history.
 *
 * Dates are computed relative to "now" in the given timezone so that
 * "On Monday…", "Last Tuesday…" and "3 November" resolve correctly on any
 * day the demo is run. Prices reflect publicly listed prices as best known
 * when this seed was written; they are the *baseline* the agent re-checks.
 */

export const SEED_LABEL = "Seeded demonstration data";

interface SeedTurn {
  role: "user" | "assistant";
  content: string;
  /** minutes after the conversation start */
  offsetMin: number;
}

export interface SeedConversation {
  key: string;
  title: string;
  /** Local start time of the conversation. */
  start: DateTime;
  turns: SeedTurn[];
}

/** Most recent date with `weekday` (1=Mon) strictly before `today`. */
function previousWeekday(today: DateTime, weekday: number): DateTime {
  let diff = today.weekday - weekday;
  if (diff <= 0) diff += 7;
  return today.minus({ days: diff });
}

/** Most recent 3 November strictly before today. */
function previousNov3(today: DateTime): DateTime {
  const thisYear = today.set({ month: 11, day: 3 });
  return thisYear < today ? thisYear : thisYear.minus({ years: 1 });
}

export function buildDemoConversations(now: Date, timezone: string): SeedConversation[] {
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf("day");
  const monday = previousWeekday(today, 1);
  const tuesday = previousWeekday(today, 2);
  const nov3 = previousNov3(today);
  const distractor = today.minus({ days: 20 });

  return [
    {
      key: "crm",
      title: "[Demo] CRM shortlist for a 20-person sales team",
      start: monday.set({ hour: 10, minute: 12 }),
      turns: [
        {
          role: "user",
          offsetMin: 0,
          content: "We're a 20-person sales team choosing a CRM. Can you shortlist 5 options with their pricing?",
        },
        {
          role: "assistant",
          offsetMin: 1,
          content: [
            "Here's a shortlist of 5 CRMs that fit a 20-person sales team, with list prices:",
            "",
            "1. **HubSpot Sales Hub Professional**: $90 per seat/month, billed annually. Strong sequences, forecasting and reporting; easy adoption.",
            "2. **Salesforce Sales Cloud Enterprise**: $165 per user/month, billed annually. The most customisable option, with a heavier admin load.",
            "3. **Pipedrive Professional**: $49 per seat/month, billed annually. Pipeline-first and very easy for reps to use.",
            "4. **Zoho CRM Professional**: $23 per user/month, billed annually. Best value; solid automation and inventory features.",
            "5. **Freshsales Pro**: $39 per user/month, billed annually. Built-in phone and email, AI lead scoring.",
            "",
            "For 20 seats on annual billing that's roughly $21,600/yr (HubSpot), $39,600/yr (Salesforce), $11,760/yr (Pipedrive), $5,520/yr (Zoho) and $9,360/yr (Freshsales).",
          ].join("\n"),
        },
        { role: "user", offsetMin: 6, content: "Great, let's keep these five as our shortlist and revisit next week." },
        {
          role: "assistant",
          offsetMin: 7,
          content: "Noted. Your shortlist is HubSpot Sales Hub, Salesforce Sales Cloud, Pipedrive, Zoho CRM and Freshsales. Ask me any time and I'll check whether pricing or features have changed.",
        },
      ],
    },
    {
      key: "copilot",
      title: "[Demo] GitHub Copilot plans for a team of 10",
      start: nov3.set({ hour: 14, minute: 30 }),
      turns: [
        {
          role: "user",
          offsetMin: 0,
          content: "How much does GitHub Copilot cost for a team of 10 developers? What plans are there?",
        },
        {
          role: "assistant",
          offsetMin: 1,
          content: [
            "GitHub Copilot currently has these plans:",
            "",
            "- **Copilot Free**: $0, with limited completions and chat requests per month.",
            "- **Copilot Pro** (individuals): $10 per month.",
            "- **Copilot Business**: $19 per user/month.",
            "- **Copilot Enterprise**: $39 per user/month (requires GitHub Enterprise Cloud).",
            "",
            "For 10 developers, Copilot Business comes to **$190 per month** ($2,280/yr). Enterprise would be $390 per month.",
          ].join("\n"),
        },
      ],
    },
    {
      key: "postgres",
      title: "[Demo] Managed Postgres hosting options",
      start: tuesday.set({ hour: 16, minute: 5 }),
      turns: [
        {
          role: "user",
          offsetMin: 0,
          content: "I need managed Postgres hosting for a side project that might grow. Compare the main options and their prices.",
        },
        {
          role: "assistant",
          offsetMin: 2,
          content: [
            "Here are the main managed Postgres options and their entry paid plans:",
            "",
            "- **Neon Launch**: $19 per month. Serverless Postgres with branching and scale-to-zero.",
            "- **Supabase Pro**: $25 per month per organization. Postgres plus auth, storage and realtime; includes compute credits.",
            "- **Render Postgres Basic-1gb**: $19 per month. Simple, predictable instance pricing.",
            "- **AWS RDS for PostgreSQL (db.t4g.micro)**: about $0.016 per hour on-demand in us-east-1 (~$12/month) plus storage.",
            "- **Railway Hobby**: $5 per month, including $5 of usage.",
            "",
            "For a side project that may grow, Neon or Supabase are the easiest starting points; RDS gives the most control later.",
          ].join("\n"),
        },
      ],
    },
    {
      key: "pg-index",
      title: "[Demo] Speeding up a slow Postgres LIKE query",
      start: distractor.set({ hour: 11, minute: 40 }),
      turns: [
        { role: "user", offsetMin: 0, content: "My Postgres query with WHERE name LIKE '%foo%' is slow. How do I speed it up?" },
        {
          role: "assistant",
          offsetMin: 1,
          content: "A leading-wildcard LIKE can't use a B-tree index. Enable the pg_trgm extension and create a GIN trigram index: `CREATE INDEX ON items USING gin (name gin_trgm_ops);`. Then verify with EXPLAIN ANALYZE.",
        },
      ],
    },
  ];
}

export function seedDemoData(repos: Repositories, db: Db, opts: { now?: Date; timezone: string }): number {
  const convs = buildDemoConversations(opts.now ?? new Date(), opts.timezone);
  transaction(db, () => {
    for (const c of convs) {
      const createdAt = c.start.toUTC().toISO()!;
      const conv = repos.conversations.create({
        title: c.title,
        timezone: opts.timezone,
        createdAt,
        metadata: { seeded: true, seedLabel: SEED_LABEL },
      });
      let last = createdAt;
      for (const t of c.turns) {
        last = c.start.plus({ minutes: t.offsetMin }).toUTC().toISO()!;
        repos.messages.add({ conversationId: conv.id, role: t.role, content: t.content, createdAt: last, metadata: { seeded: true } });
      }
      repos.conversations.touch(conv.id, last);
    }
  });
  return convs.length;
}

/** Seeds only when the database has no conversations (first start). */
export function seedIfEmpty(repos: Repositories, db: Db, opts: { now?: Date; timezone: string }): number {
  if (repos.conversations.count() > 0) return 0;
  return seedDemoData(repos, db, opts);
}

/** Removes seeded conversations (cascades to messages) and re-seeds with fresh relative dates. */
export function resetDemoData(repos: Repositories, db: Db, opts: { now?: Date; timezone: string }): number {
  const seeded = db.prepare(`SELECT id FROM conversations WHERE json_extract(metadata, '$.seeded') = 1`).all() as Array<{ id: string }>;
  transaction(db, () => {
    for (const r of seeded) db.prepare("DELETE FROM conversations WHERE id = ?").run(r.id);
  });
  return seedDemoData(repos, db, opts);
}
