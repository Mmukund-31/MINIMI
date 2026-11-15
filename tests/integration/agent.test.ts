/**
 * End-to-end orchestrator tests with deterministic test doubles (scripted LLM
 * outputs + fixture search results). The real temporal, memory, ranking,
 * validation, comparison, citation and persistence code all runs.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@minimi/core";
import { crmMessage, crmScript, crmSearch, nov3Message, nov3Script, nov3Search, pgMessage, pgScript, pgSearch } from "../../evals/fixtures/demo-fixtures";
import { analysis } from "../../evals/fixtures/scenario-kit";
import { eventsOf, makeRuntime, runTurn } from "../helpers";

describe("Demo 1: CRM shortlist (memory + pricing + product updates)", async () => {
  const { runtime, search, llm } = makeRuntime({ script: crmScript, searchFixtures: crmSearch });
  const { events, result, error, text } = await runTurn(runtime, crmMessage);

  it("completes without error and streams the answer", () => {
    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    expect(text.length).toBeGreaterThan(20);
  });

  it("retrieves Monday's seeded shortlist from memory", () => {
    const mem = eventsOf(events, "memory")[0]!;
    expect(mem.summary.status).toBe("found");
    expect(mem.exchanges[0]!.conversationTitle).toContain("CRM shortlist");
    expect(mem.summary.seeded).toBe(true);
  });

  it("runs only bounded, planned searches", () => {
    expect(search!.queries.length).toBeLessThanOrEqual(runtime.config.budgets.maxSearches);
    expect(llm.structuredCalls()).toEqual(["message_analysis", "research_plan", "evidence_extraction"]);
  });

  it("quarantines the prompt-injection result", () => {
    const urls = eventsOf(events, "sources")[0]!.sources.map((s) => s.url);
    expect(urls.some((u) => u.includes("seo-spam"))).toBe(false);
    expect(result!.metadata.notes!.join(" ")).toMatch(/instructions aimed at AI systems/);
  });

  it("computes the expected statuses deterministically", () => {
    const cmp = result!.metadata.comparisons!;
    const pricing = Object.fromEntries(cmp.filter((c) => c.category === "pricing").map((c) => [c.subject, c.status]));
    expect(pricing).toEqual({
      "HubSpot Sales Hub": "changed",
      "Salesforce Sales Cloud": "changed",
      Pipedrive: "uncertain",
      "Zoho CRM": "unchanged",
      Freshsales: "uncertain",
    });
    // The invented "Monday.com" claim (not in memory) was dropped.
    expect(cmp.some((c) => c.subject === "Monday.com")).toBe(false);
    const updates = cmp.filter((c) => c.category === "product_update");
    expect(updates.find((c) => c.subject === "HubSpot Sales Hub")!.status).toBe("changed");
    // Salesforce's 2025 article predates the conversation: not reported as a change.
    expect(updates.find((c) => c.subject === "Salesforce Sales Cloud")!.status).toBe("uncertain");
  });

  it("removes citations to non-existent sources and invented URLs from the answer", () => {
    expect(text).not.toContain("[S42]");
    expect(result!.content).not.toContain("[S42]");
    expect(result!.content).not.toContain("totally-made-up.example.com");
    const valid = new Set(result!.metadata.sources!.map((s) => s.id));
    for (const m of result!.content.matchAll(/\[(S\d+)\]/g)) expect(valid.has(m[1]!)).toBe(true);
  });

  it("persists research, evidence and message-evidence links (fabricated evidence excluded)", () => {
    const db = runtime.db;
    const session = db.prepare("SELECT * FROM research_sessions WHERE id = ?").get(result!.metadata.executionId!) as Record<string, unknown>;
    expect(session.execution_status).toBe("completed");
    const searches = db.prepare("SELECT COUNT(*) n FROM search_records WHERE research_session_id = ?").get(session.id as string) as { n: number };
    expect(Number(searches.n)).toBe(search!.queries.length);
    const ev = runtime.repos.research.evidenceForMessage(result!.id);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.some((e) => String(e.claim).includes("$52"))).toBe(false); // fabricated quote
    expect(ev.some((e) => String(e.claim).includes("$45"))).toBe(false); // hallucinated source S99
  });

  it("emits stages in pipeline order", () => {
    const order = eventsOf(events, "stage").filter((e) => e.status === "start").map((e) => e.stage);
    expect(order).toEqual(["temporal", "analyze", "memory", "plan", "search", "evidence", "compare", "synthesize"]);
  });
});

describe("Demo 2: '3 November' recall", async () => {
  const { runtime } = makeRuntime({ script: nov3Script, searchFixtures: nov3Search });
  const { result, error } = await runTurn(runtime, nov3Message);
  it("retrieves the Copilot question and confirms the answer still holds", () => {
    expect(error).toBeUndefined();
    expect(result!.metadata.memory!.status).toBe("found");
    const cmp = result!.metadata.comparisons!;
    expect(cmp.filter((c) => c.category === "pricing").map((c) => c.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    // "Is your answer still correct?" also triggers an update check for the subject.
    expect(cmp.filter((c) => c.category === "product_update").map((c) => c.subject)).toEqual(["GitHub Copilot"]);
  });
});

describe("Demo 3: Postgres hosting with a search timeout", async () => {
  const { runtime } = makeRuntime({ script: pgScript, searchFixtures: pgSearch });
  const { result, error, events } = await runTurn(runtime, pgMessage);
  it("degrades gracefully: the RDS search times out but the answer completes", () => {
    expect(error).toBeUndefined();
    expect(eventsOf(events, "search").some((e) => e.status === "failed")).toBe(true);
    expect(result!.metadata.notes!.join(" ")).toMatch(/searches failed/);
  });
  it("classifies each provider honestly", () => {
    const s = Object.fromEntries(result!.metadata.comparisons!.map((c) => [c.subject, c.status]));
    expect(s).toEqual({ Neon: "uncertain", Supabase: "unchanged", Render: "unchanged", "AWS RDS for PostgreSQL": "uncertain", Railway: "unchanged" });
  });
});

describe("conversational behaviour", () => {
  it("answers small talk without memory or search", async () => {
    const { runtime, search, llm } = makeRuntime({
      script: { structured: { message_analysis: analysis({ intent: "chat", needsWebSearch: false, standaloneQuestion: "hi" }) }, synthesis: "Hi! How can I help?" },
      searchFixtures: {},
    });
    const { result } = await runTurn(runtime, "hi there");
    expect(result!.content).toBe("Hi! How can I help?");
    expect(search!.queries).toEqual([]);
    expect(llm.structuredCalls()).toEqual(["message_analysis"]);
  });

  it("falls back to heuristics when the model returns invalid structured output twice", async () => {
    const r = makeRuntime({ script: { structured: { message_analysis: ["{bad json", "still bad"] }, synthesis: "fine" }, searchFixtures: {} });
    const { events, result } = await runTurn(r.runtime, "hello");
    expect(eventsOf(events, "done")).toHaveLength(1);
    expect(result!.content).toBe("fine");
  });

  it("says so honestly when the referenced conversation does not exist", async () => {
    const { runtime } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ intent: "memory_recall", needsMemory: true, needsWebSearch: false, temporalExpressions: ["1 November"] }),
        },
        synthesis: (req) => (req.messages[0]!.content.includes('status="not_found"') ? "I couldn't find a conversation from 1 November." : "WRONG"),
      },
      searchFixtures: {},
    });
    const { result } = await runTurn(runtime, "What did I ask you on 1 November?");
    expect(result!.content).toContain("couldn't find");
    expect(result!.metadata.memory!.status).toBe("not_found");
  });

  it("continues a conversation and includes recent turns as context", async () => {
    const { runtime, llm } = makeRuntime({
      script: { structured: { message_analysis: analysis({ intent: "chat", needsWebSearch: false }) }, synthesis: "ok" },
      searchFixtures: {},
    });
    const first = await runTurn(runtime, "My team uses Python and Go.");
    await runTurn(runtime, "Which of those is faster?", first.result!.conversationId);
    const lastSynth = llm.calls.filter((c) => c.kind === "stream").at(-1)!;
    expect(lastSynth.prompt).toContain("My team uses Python and Go.");
  });

  it("degrades to a memory-only answer when search is not configured", async () => {
    const { runtime } = makeRuntime({ script: crmScript, searchFixtures: null });
    const { result } = await runTurn(runtime, crmMessage);
    expect(result!.metadata.notes!.join(" ")).toMatch(/Web search isn't configured/);
    expect(result!.metadata.memory!.status).toBe("found");
  });

  it("rejects empty and oversized messages", async () => {
    const { runtime } = makeRuntime({ script: { structured: {}, synthesis: "x" } });
    expect((await runTurn(runtime, "   ")).error).toBeInstanceOf(AppError);
    expect(((await runTurn(runtime, "x".repeat(5000))).error as AppError).code).toBe("VALIDATION");
  });

  it("marks the research session failed when synthesis errors", async () => {
    const { runtime } = makeRuntime({
      script: { structured: { message_analysis: analysis({ intent: "chat", needsWebSearch: false }) }, synthesis: new AppError("LLM_RATE_LIMIT", "slow down", { retryable: true }) },
    });
    const { error } = await runTurn(runtime, "hello");
    expect((error as AppError).code).toBe("LLM_RATE_LIMIT");
    const row = runtime.db.prepare("SELECT execution_status, error_code FROM research_sessions ORDER BY started_at DESC LIMIT 1").get() as Record<string, string>;
    expect({ ...row }).toEqual({ execution_status: "failed", error_code: "LLM_RATE_LIMIT" });
  });
});
