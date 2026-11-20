import { describe, expect, it } from "vitest";
import { buildDirectContext, chooseIntent, enforceRouting, heuristicAnalysis, isTimeSensitive, LLMClient, pipelineFor, questionTerms, requestedMajorVersions, versionMismatch } from "@minimi/core";
import { ScriptedLLMProvider } from "@minimi/core/testing";
import type { Source } from "@minimi/core";
import { analysis } from "../../evals/fixtures/scenario-kit";

describe("chooseIntent / pipelineFor", () => {
  const route = (a: Parameters<typeof chooseIntent>[0], msg = "") => {
    const intent = chooseIntent(a, msg);
    return [intent, pipelineFor(intent)];
  };
  it("routes by what the question needs, decided in code", () => {
    expect(route(analysis({ needsWebSearch: false }))).toEqual(["chat", "chat"]);
    expect(route(analysis({ needsWebSearch: true }))).toEqual(["fact_lookup", "lookup"]);
    expect(route(analysis({ needsWebSearch: true, researchIntent: "general_research" }))).toEqual(["general_research", "research"]);
    expect(route(analysis({ needsWebSearch: true, aspects: ["auth features", "region availability"] }))).toEqual(["general_research", "research"]);
    expect(route(analysis({ needsWebSearch: true, asksAboutPricing: true, entities: ["Neon"] }))).toEqual(["pricing_diff", "deep"]);
    // Pricing cues with nothing concrete to price are not a price check.
    expect(route(analysis({ needsWebSearch: true, asksAboutPricing: true, entities: [] }))).toEqual(["fact_lookup", "lookup"]);
    expect(route(analysis({ needsMemory: true, needsWebSearch: false }))).toEqual(["historical_audit", "deep"]);
    expect(route(analysis({ needsMemory: true, needsWebSearch: true, asksAboutPricing: true }))).toEqual(["pricing_diff", "deep"]);
  });

  it("comparisons need two options; price is one criterion among several, not a price diff", () => {
    expect(route(analysis({ researchIntent: "comparison", entities: ["Bun", "Deno"] }))).toEqual(["comparison", "research"]);
    expect(route(analysis({ entities: ["Bun", "Deno"] }), "Bun vs Deno?")[0]).toBe("comparison");
    expect(route(analysis({ researchIntent: "comparison", entities: ["Bun"] }))[0]).toBe("fact_lookup");
    const mixed = analysis({ researchIntent: "comparison", entities: ["Cursor", "Copilot"], asksAboutPricing: true, aspects: ["pricing model", "privacy"] });
    expect(route(mixed)[0]).toBe("comparison");
    const pureprice = analysis({ researchIntent: "comparison", entities: ["Neon", "Supabase"], asksAboutPricing: true, aspects: ["price"] });
    expect(route(pureprice)[0]).toBe("pricing_diff");
  });

  it("the three challenge prompts always take the verified pipeline, whatever the model says", () => {
    const prompts = [
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
      "What did I ask you on 3 November? Is your answer still correct today?",
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    ];
    for (const p of prompts) {
      const routed = enforceRouting(analysis({ intent: "chat", needsWebSearch: false, researchIntent: "chat" }), p, [{ expression: "x" } as never]);
      expect(pipelineFor(chooseIntent(routed, p))).toBe("deep");
    }
  });
});

describe("search queries", () => {
  it("falls back to the question when the model proposes none", () => {
    const routed = enforceRouting(analysis({ needsWebSearch: true, standaloneQuestion: "Who maintains Vite?", searchQueries: [] }), "Who maintains Vite?", []);
    expect(routed.searchQueries).toEqual(["Who maintains Vite?"]);
  });
  it("heuristic analysis proposes the message as a query only when fresh facts are needed", () => {
    expect(heuristicAnalysis("hi", []).searchQueries).toEqual([]);
    expect(heuristicAnalysis("What is the latest Node release?", []).searchQueries).toEqual(["What is the latest Node release?"]);
  });
});

describe("isTimeSensitive", () => {
  it("detects recent-event questions", () => {
    expect(isTimeSensitive("What's the latest news on the EU AI Act?")).toBe(true);
    expect(isTimeSensitive("Who won the match yesterday?")).toBe(true);
    expect(isTimeSensitive("How does TCP slow start work?")).toBe(false);
  });
});

describe("buildDirectContext", () => {
  const src = (id: string, content: string, extra: Partial<Source> = {}): Source =>
    ({ id, title: `Title ${id}`, url: `https://ex${id}.com`, sourceDomain: `ex${id}.com`, snippet: "", content, kind: "third_party", rankScore: 1, retrievedAt: "2026-11-15T00:00:00Z", query: "q", provider: "t", ...extra }) as Source;

  it("includes bounded, query-focused excerpts with ids, kinds and dates", () => {
    const long = `${"filler text ".repeat(800)} The Raft leader election timeout is randomized between 150 and 300 ms. ${"more filler ".repeat(800)}`;
    const ctx = buildDirectContext({
      question: "How does Raft leader election work?",
      nowLocal: "Sunday 15 November 2026, 12:00",
      timezone: "Europe/London",
      recent: [],
      sources: [src("S1", long, { publishedAt: "2026-10-01T00:00:00Z" }), src("S2", "short page")],
      notes: [],
      searchStatus: "ok",
      focusTerms: questionTerms("How does Raft leader election work?"),
      maxChars: 6000,
    });
    expect(ctx).toContain('<source id="S1" domain="exS1.com" kind="third_party" date="2026-10-01">');
    expect(ctx).toContain('date="unknown"');
    expect(ctx).toContain("randomized between 150 and 300 ms");
    expect(ctx.length).toBeLessThan(7000);
  });

  it("omits search status for chat", () => {
    const ctx = buildDirectContext({ question: "hi", nowLocal: "", timezone: "UTC", recent: [], sources: [], notes: [], searchStatus: "not_needed", focusTerms: [], maxChars: 1000 });
    expect(ctx).not.toContain("search_status");
  });
});

describe("LLMClient.strongStreamRole", () => {
  const p = new ScriptedLLMProvider({ structured: {}, synthesis: "" });
  const q = new ScriptedLLMProvider({ structured: {}, synthesis: "" });
  it("uses the idle, larger extract model on a single provider", () => {
    expect(new LLMClient({ fast: { provider: p, model: "20b" }, extract: { provider: p, model: "120b" }, synthesis: { provider: p, model: "20b" } }).strongStreamRole()).toBe("extract");
  });
  it("keeps synthesis when it is the same model, or routed to another provider on purpose", () => {
    expect(new LLMClient({ fast: { provider: p, model: "m" }, extract: { provider: p, model: "m" }, synthesis: { provider: p, model: "m" } }).strongStreamRole()).toBe("synthesis");
    expect(new LLMClient({ fast: { provider: p, model: "20b" }, extract: { provider: p, model: "120b" }, synthesis: { provider: q, model: "claude" } }).strongStreamRole()).toBe("synthesis");
  });
});

describe("routing overrides from live runs (2026-11-20)", () => {
  it("a version question is always searched, whatever the model says", () => {
    const routed = enforceRouting(analysis({ intent: "chat", needsWebSearch: false, researchIntent: "chat" }), "How do I configure dark mode in Tailwind CSS v4?", []);
    expect(routed.needsWebSearch).toBe(true);
    expect(pipelineFor(chooseIntent(routed))).not.toBe("chat");
  });
  it("small talk stays chat", () => {
    const routed = enforceRouting(analysis({ intent: "chat", needsWebSearch: false, researchIntent: "chat" }), "Thanks! What kinds of questions can you help me with?", []);
    expect(routed.needsWebSearch).toBe(false);
  });
  it("a follow-up inside a conversation uses recent turns, not cross-conversation memory", () => {
    const model = analysis({ needsMemory: true, needsWebSearch: true, standaloneQuestion: "webpack latest version" });
    expect(enforceRouting(model, "What about the second one's latest version?", [], { inConversation: true }).needsMemory).toBe(false);
    // With an explicit cue, memory stays on.
    expect(enforceRouting(model, "What did I ask you about it last time?", [], { inConversation: true }).needsMemory).toBe(true);
  });
});

describe("version-aware source selection", () => {
  it("drops pages for another major version than the one asked about", () => {
    expect(requestedMajorVersions("dark mode in Tailwind CSS v4?")).toEqual([4]);
    expect(versionMismatch("https://v3.tailwindcss.com/docs/dark-mode", [4])).toBe(true);
    expect(versionMismatch("https://tailwindcss.com/docs/dark-mode", [4])).toBe(false);
    expect(versionMismatch("https://example.com/docs/v4/dark-mode", [4])).toBe(false);
    expect(versionMismatch("https://example.com/docs/v3/dark-mode", [4])).toBe(true);
    expect(versionMismatch("https://v3.tailwindcss.com/docs", [])).toBe(false);
  });
});
