import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildFtsQuery, createRepositories, MemoryRetriever, openDatabase, resolveTemporal, seedDemoData } from "@minimi/core";
import { FIXED_NOW, TZ } from "../../evals/fixtures/demo-fixtures";

function setup() {
  const db = openDatabase(":memory:");
  const repos = createRepositories(db);
  seedDemoData(repos, db, { now: FIXED_NOW, timezone: TZ });
  const current = repos.conversations.create({ timezone: TZ });
  const retriever = new MemoryRetriever(repos.messages, repos.conversations);
  const ask = (text: string, terms: string[] = []) =>
    retriever.retrieve({
      text,
      terms,
      temporal: resolveTemporal(text, { now: FIXED_NOW, timezone: TZ }).references,
      currentConversationId: current.id,
      now: FIXED_NOW.toISOString(),
    });
  const titleOf = (id: string) => repos.conversations.get(id)!.title;
  return { db, repos, ask, titleOf, current };
}

describe("buildFtsQuery", () => {
  it("produces a safe OR query of quoted tokens with prefix matching", () => {
    expect(buildFtsQuery(["Postgres hosting pricing?"])).toBe('"postgres"* OR "hosting"* OR "pricing"*');
    expect(buildFtsQuery(['") OR 1=1; DROP TABLE messages; --'])).not.toContain(";");
    expect(buildFtsQuery(["what did I ask you"])).toBe("");
  });
});

describe("MemoryRetriever", () => {
  const { ask, titleOf, repos, current } = setup();

  it("recovers the Postgres conversation from 'last Tuesday' and the topic", () => {
    const r = ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(r.summary.status).toBe("found");
    expect(r.summary.conversationIds.map(titleOf)).toEqual(["[Demo] Managed Postgres hosting options"]);
    expect(r.exchanges[0]!.assistant!.content).toContain("Neon Launch");
    expect(r.summary.seeded).toBe(true);
  });

  it("recovers everything asked on 3 November even with no topic words", () => {
    const r = ask("What did I ask you on 3 November? Is your answer still correct today?");
    expect(r.summary.conversationIds.map(titleOf)).toEqual(["[Demo] GitHub Copilot plans for a team of 10"]);
    expect(r.exchanges[0]!.user!.content).toContain("GitHub Copilot");
  });

  it("recovers all five shortlisted CRMs from 'On Monday'", () => {
    const r = ask("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?");
    const text = r.exchanges.map((e) => e.assistant?.content ?? "").join("\n");
    for (const name of ["HubSpot", "Salesforce", "Pipedrive", "Zoho", "Freshsales"]) expect(text).toContain(name);
  });

  it("is honest when no conversation exists on the requested date", () => {
    const r = ask("What did we discuss on 1 November?");
    expect(r.summary.status).toBe("not_found");
    expect(r.notes.join(" ")).toMatch(/no saved conversation from Sunday, 1 November 2026/);
  });

  it("falls back to a topic match from another date, and says so", () => {
    const r = ask("What did I ask about CRM tools on 1 November?", ["CRM"]);
    expect(r.summary.status).toBe("found");
    expect(r.notes.join(" ")).toMatch(/different date/);
  });

  it("uses topic-only retrieval when there is no date", () => {
    const r = ask("How did you suggest fixing the slow LIKE query with trigram indexes?");
    expect(r.summary.conversationIds.map(titleOf)[0]).toBe("[Demo] Speeding up a slow Postgres LIKE query");
  });

  it("resolves 'since our last discussion' to the previous conversation", () => {
    const r = ask("Has anything changed since our last discussion?");
    expect(r.summary.status).toBe("found");
    expect(r.summary.interpretation).toMatch(/previous conversation/);
    expect(r.summary.conversationIds).not.toContain(current.id);
    expect(repos.conversations.get(r.summary.conversationIds[0]!)).not.toBeNull();
  });

  it("bounds the number of exchanges returned", () => {
    const r = ask("On Monday we shortlisted CRM tools");
    expect(r.exchanges.length).toBeLessThanOrEqual(6);
  });
});

describe("persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "minimi-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps conversations and the FTS index across restarts", () => {
    const path = join(dir, "test.db");
    let db = openDatabase(path);
    let repos = createRepositories(db);
    const c = repos.conversations.create({ timezone: TZ, title: "persist" });
    repos.messages.add({ conversationId: c.id, role: "user", content: "Remember the Kubernetes ingress question" });
    db.close();

    db = openDatabase(path); // re-open: migrations must not re-run destructively
    repos = createRepositories(db);
    expect(repos.messages.listByConversation(c.id)).toHaveLength(1);
    expect(repos.messages.search('"kubernetes"*')).toHaveLength(1);
    db.close();
  });
});
