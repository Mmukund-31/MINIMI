import { describe, expect, it } from "vitest";
import { AppError } from "@minimi/core";
import { analysis } from "../../evals/fixtures/scenario-kit";
import { makeRuntime, runTurn } from "../helpers";

const chatScript = (extra: object = {}) => ({
  structured: { message_analysis: analysis({ intent: "chat", needsWebSearch: false }) },
  synthesis: "This is a long answer that will be cut off part of the way through streaming.",
  ...extra,
});

describe("official-domain-first search", () => {
  it("searches the vendor's domain first and falls back to an open search when it finds nothing", async () => {
    const { runtime, search } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ intent: "research", needsWebSearch: true, entities: ["Acme"], asksAboutPricing: true }),
          research_plan: { subjects: [{ name: "Acme", officialDomain: "acme.example" }], historicalClaims: [], searches: [{ query: "Acme pricing", purpose: "pricing", subject: "Acme" }] },
          evidence_extraction: { findings: [], updates: [] },
        },
        synthesis: "ok",
      },
      searchFixtures: { "acme pricing": [{ url: "https://reviews.example.org/acme", title: "Acme review", snippet: "Acme costs $10/month." }] },
    });
    const { events, error } = await runTurn(runtime, "What does Acme cost?");
    expect(error).toBeUndefined();
    const labels = events.filter((e) => e.type === "search" && e.status !== "start").map((e) => (e as { query: string }).query);
    expect(labels).toEqual(["Acme pricing · acme.example", "Acme pricing"]);
    expect(search!.queries).toHaveLength(2);
  });

  it("also searches the open web when the official page shows no visible price (JS-rendered)", async () => {
    const { runtime } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ intent: "research", needsWebSearch: true, entities: ["Acme"], asksAboutPricing: true }),
          research_plan: { subjects: [{ name: "Acme", officialDomain: "acme.example" }], historicalClaims: [], searches: [{ query: "Acme pricing", purpose: "pricing", subject: "Acme" }] },
          evidence_extraction: { findings: [], updates: [] },
        },
        synthesis: "ok",
      },
      searchFixtures: {
        "acme pricing": [
          { url: "https://acme.example/pricing", title: "Acme pricing", snippet: "Choose the plan that fits your team. Contact us." },
          { url: "https://reviews.example.org/acme", title: "Acme review", snippet: "Acme costs $10/month." },
        ],
      },
    });
    const { events } = await runTurn(runtime, "What does Acme cost?");
    const sources = events.find((e) => e.type === "sources") as { sources: Array<{ domain: string; kind: string }> };
    expect(sources.sources.map((s) => s.domain).sort()).toEqual(["acme.example", "reviews.example.org"]);
    expect(sources.sources.find((s) => s.domain === "acme.example")!.kind).toBe("official_pricing");
  });
});

describe("evidence extraction retry", () => {
  it("retries once when extraction is empty although sources show prices", async () => {
    const { runtime, llm } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ intent: "research", needsWebSearch: true, entities: ["Acme"], asksAboutPricing: true }),
          research_plan: { subjects: [{ name: "Acme", officialDomain: null }], historicalClaims: [], searches: [{ query: "Acme pricing", purpose: "pricing", subject: "Acme" }] },
          evidence_extraction: [
            { findings: [], updates: [] },
            { findings: [{ subject: "Acme", category: "pricing", attribute: "Pro", value: "$10/month", quote: "Acme Pro costs $10/month", sourceId: "S1" }], updates: [] },
          ],
        },
        synthesis: "Acme Pro is $10/month [S1].",
      },
      searchFixtures: { "acme pricing": [{ url: "https://acme.example/pricing", title: "Acme pricing", snippet: "Acme Pro costs $10/month." }] },
    });
    const { result } = await runTurn(runtime, "What does Acme cost?");
    expect(llm.structuredCalls().filter((c) => c === "evidence_extraction")).toHaveLength(2);
    expect(runtime.repos.research.evidenceForMessage(result!.id)).toHaveLength(1);
  });
});

describe("extraction rate-limit fallback", () => {
  it("falls back to the fast model when the extraction model is rate-limited", async () => {
    const { runtime, llm } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ intent: "research", needsWebSearch: true, entities: ["Acme"], asksAboutPricing: true }),
          research_plan: { subjects: [{ name: "Acme", officialDomain: null }], historicalClaims: [], searches: [{ query: "Acme pricing", purpose: "pricing", subject: "Acme" }] },
          evidence_extraction: [
            new AppError("LLM_RATE_LIMIT", "daily quota", { retryable: true }),
            { findings: [{ subject: "Acme", category: "pricing", attribute: "Pro", value: "$10/month", quote: "Acme Pro costs $10/month", sourceId: "S1" }], updates: [] },
          ],
        },
        synthesis: "Acme Pro is $10/month [S1].",
      },
      searchFixtures: { "acme pricing": [{ url: "https://acme.example/pricing", title: "Acme pricing", snippet: "Acme Pro costs $10/month." }] },
    });
    // Give the extract role a distinct model so the fallback is meaningful.
    (runtime.llm as unknown as { roles: { extract: { model: string } } }).roles.extract.model = "scripted-extract";
    const { result } = await runTurn(runtime, "What does Acme cost?");
    expect(llm.structuredCalls().filter((c) => c === "evidence_extraction")).toHaveLength(2);
    expect(result!.metadata.notes!.join(" ")).toMatch(/rate-limited/);
    expect(runtime.repos.research.evidenceForMessage(result!.id)).toHaveLength(1);
  });
});

describe("plan escalation", () => {
  it("escalates planning to the extract model when the fast model's output is invalid twice", async () => {
    const { runtime, llm } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ intent: "research", needsWebSearch: true, entities: ["Acme"], asksAboutPricing: true }),
          research_plan: ["{bad", "still bad", { subjects: [{ name: "Acme", officialDomain: null }], historicalClaims: [], searches: [{ query: "Acme pricing", purpose: "pricing", subject: "Acme" }] }],
          evidence_extraction: { findings: [], updates: [] },
        },
        synthesis: "ok",
      },
      searchFixtures: {},
    });
    const { result } = await runTurn(runtime, "What does Acme cost?");
    expect(llm.structuredCalls().filter((c) => c === "research_plan")).toHaveLength(3);
    expect(result!.metadata.notes ?? []).not.toContain("Research planning fell back to a simple search strategy.");
  });
});

describe("reliability", () => {
  it("persists a partial answer, marked interrupted, when streaming fails mid-way", async () => {
    const { runtime } = makeRuntime({ script: chatScript({ streamFailure: { afterChars: 20, error: new AppError("LLM_ERROR", "connection reset", { retryable: true }) } }) });
    const { error, events } = await runTurn(runtime, "Tell me something");
    expect((error as AppError).code).toBe("LLM_ERROR");
    const convId = (events.find((e) => e.type === "conversation") as { conversationId: string }).conversationId;
    const msgs = runtime.repos.messages.listByConversation(convId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.metadata.status).toBe("error");
    expect(msgs[1]!.content.length).toBeGreaterThan(0);
    expect(msgs[1]!.metadata.notes!.join(" ")).toMatch(/interrupted/);
  });

  it("a retry reuses the interrupted question instead of duplicating it, and hides the partial from the model", async () => {
    const { runtime, llm } = makeRuntime({ script: chatScript({ streamFailure: { afterChars: 20, error: new AppError("LLM_ERROR", "reset", { retryable: true }) } }) });
    const first = await runTurn(runtime, "Tell me something");
    const convId = (first.events.find((e) => e.type === "conversation") as { conversationId: string }).conversationId;
    // Second attempt with a healthy provider on the same runtime.
    (llm as unknown as { opts: { streamFailure?: unknown } }).opts.streamFailure = undefined;
    const second = await runTurn(runtime, "Tell me something", convId);
    expect(second.error).toBeUndefined();
    const roles = runtime.repos.messages.listByConversation(convId).map((m) => `${m.role}:${m.metadata.status ?? ""}`);
    expect(roles).toEqual(["user:", "assistant:error", "assistant:complete"]);
    const lastPrompt = llm.calls.filter((c) => c.kind === "stream").at(-1)!.prompt;
    expect(lastPrompt).not.toContain("will be cut off");
  });

  it("rejects a concurrent second turn in the same conversation", async () => {
    const { runtime } = makeRuntime({ script: chatScript() });
    const first = await runTurn(runtime, "hello");
    const convId = first.result!.conversationId;
    const a = runtime.agent.run({ message: "one", conversationId: convId }, () => {});
    const b = runtime.agent.run({ message: "two", conversationId: convId }, () => {});
    await expect(b).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(a).resolves.toBeDefined();
    // The lock is released afterwards.
    await expect(runtime.agent.run({ message: "three", conversationId: convId }, () => {})).resolves.toBeDefined();
  });

  it("marks a client cancellation as cancelled", async () => {
    const { runtime } = makeRuntime({ script: chatScript() });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.agent.run({ message: "hi", signal: controller.signal }, () => {})).rejects.toBeInstanceOf(AppError);
    const row = runtime.db.prepare("SELECT execution_status FROM research_sessions ORDER BY started_at DESC LIMIT 1").get() as { execution_status: string };
    expect(row.execution_status).toBe("cancelled");
  });
});
