/**
 * Lookup pipeline (fact questions) and chat, end to end with deterministic doubles.
 * Lookup: the analysis proposes the queries → one search round (+ targeted follow-up searches
 * only when coverage is thin) → the answer model reads the excerpts → claim gate.
 * The research pipeline (claim extraction + coverage loop) is covered in research.test.ts.
 */
import { describe, expect, it } from "vitest";
import { AppError, createRuntime, LLMClient, type AgentEvent } from "@minimi/core";
import { FixtureSearchProvider, ScriptedLLMProvider } from "@minimi/core/testing";
import type { CompletionRequest, LLMProvider, StreamChunk } from "@minimi/core";
import { FIXED_NOW, TZ } from "../../evals/fixtures/demo-fixtures";
import { analysis, promptText } from "../../evals/fixtures/scenario-kit";
import { eventsOf, makeRuntime, runTurn, testConfig } from "../helpers";

const bunVsDeno = "How fast is the Bun HTTP server compared with Deno.serve?";
const bunAnalysis = analysis({
  intent: "research",
  needsWebSearch: true,
  standaloneQuestion: bunVsDeno,
  entities: ["Bun"],
  searchQueries: ["Bun HTTP server performance 2026", "Deno 2 HTTP server production"],
});
const bunFixtures = {
  "Bun HTTP server": [
    { url: "https://bun.sh/docs/api/http", title: "HTTP server – Bun docs", snippet: "Bun.serve() starts a high-performance HTTP server.", content: "Bun.serve() starts a high-performance HTTP server. It supports WebSockets and streaming responses out of the box." },
    { url: "https://blog.example-bench.com/bun-deno-2026", title: "Bun vs Deno benchmarks 2026", snippet: "In our HTTP benchmark Bun served 110k req/s and Deno 95k req/s.", content: "In our HTTP benchmark Bun served 110k req/s and Deno 95k req/s on the same machine.", publishedAt: "2026-10-02T00:00:00Z" },
  ],
  "Deno 2 HTTP": [
    { url: "https://docs.deno.com/runtime/fundamentals/http_server/", title: "Writing an HTTP server – Deno docs", snippet: "Deno.serve is the recommended way to run an HTTP server in Deno 2.", content: "Deno.serve is the recommended way to run an HTTP server in Deno 2. Permissions are opt-in for security." },
  ],
};

describe("Lookup: a factual question", async () => {
  const { runtime, search, llm } = makeRuntime({
    script: {
      structured: { message_analysis: bunAnalysis },
      synthesis: (req) => {
        const p = promptText(req);
        const ids = [...new Set([...p.matchAll(/<source id="(S\d+)"/g)].map((m) => m[1]!))];
        return `Pick Bun for raw throughput, Deno for built-in security [${ids[0]}]. Bun served 110k req/s in one benchmark [${ids[0]}]. Deno reached 300k req/s in the same test [${ids[1]}]. See https://invented.example.org/x for more [S42].`;
      },
    },
    searchFixtures: bunFixtures,
    seed: false,
  });
  const { events, result, error, text } = await runTurn(runtime, bunVsDeno);

  it("answers with one structured call and no planning or extraction", () => {
    expect(error).toBeUndefined();
    expect(llm.structuredCalls()).toEqual(["message_analysis"]);
    expect(result!.metadata.stats!.llmCalls).toBe(2);
    expect(result!.metadata.stats!.mode).toBe("lookup");
    expect(result!.metadata.stats!.intent).toBe("fact_lookup");
    expect(result!.metadata.stats!.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("runs the queries the analysis proposed, and no broadened search when coverage is enough", () => {
    expect(search!.queries).toEqual(["Bun HTTP server performance 2026", "Deno 2 HTTP server production"]);
  });

  it("gives the answer model source excerpts (not just titles) under the direct prompt", () => {
    const call = llm.calls.find((c) => c.kind === "stream")!;
    expect(call.system).toContain("When <sources> are provided");
    expect(call.prompt).toMatch(/<source id="S\d" domain="[^"]+" kind="[^"]+" date="[^"]+">/);
    expect(call.prompt).toContain("110k req/s");
    expect(call.prompt).toContain("<search_status>ok</search_status>");
  });

  it("still strips invented citations and URLs", () => {
    expect(text).not.toContain("[S42]");
    expect(result!.content).not.toContain("invented.example.org");
    const valid = new Set(result!.metadata.sources!.map((s) => s.id));
    for (const m of result!.content.matchAll(/\[(S\d+)\]/g)) expect(valid.has(m[1]!)).toBe(true);
  });

  it("skips plan/evidence/compare, records coverage and the claim check, and no comparison rows or follow-ups", () => {
    const skipped = eventsOf(events, "stage").filter((e) => e.status === "skipped").map((e) => e.stage);
    expect(skipped).toEqual(expect.arrayContaining(["plan", "evidence", "compare"]));
    const r = result!.metadata.research!;
    expect(r.intent).toBe("fact_lookup");
    expect(r.coverage.rounds).toBe(1);
    expect(r.claimCheck.checked).toBe(2);
    // 110k is in the benchmark page but was cited to the docs page: re-cited. 300k is in no source: removed.
    expect(r.claimCheck.repaired).toBe(1);
    expect(r.claimCheck.removed).toBe(1);
    expect(result!.content).toContain("110k");
    expect(result!.content).not.toContain("300k");
    expect(text).not.toContain("300k");
    expect(result!.metadata.notes!.join(" ")).toContain("1 statement(s) were removed");
    expect(eventsOf(events, "comparison")).toHaveLength(0);
    expect(result!.metadata.followUps).toEqual([]);
  });
});

describe("Lookup: thin coverage triggers exactly one broadened search", async () => {
  const q = "What is the Zig 0.16 release about?";
  const { search, result } = await (async () => {
    const rt = makeRuntime({
      script: { structured: { message_analysis: analysis({ needsWebSearch: true, standaloneQuestion: q, entities: ["Zig"], searchQueries: ["zig 0.16 release notes"] }) }, synthesis: "Zig 0.16 focuses on the new async I/O [S1]." },
      searchFixtures: {
        "zig 0.16 release notes": [],
        [q]: [
          { url: "https://ziglang.org/download/0.16.0/release-notes.html", title: "0.16.0 Release Notes", snippet: "Zig 0.16 introduces the new async I/O interface.", content: "Zig 0.16 introduces the new async I/O interface." },
        ],
      },
      seed: false,
    });
    const r = await runTurn(rt.runtime, q);
    return { search: rt.search, result: r.result };
  })();

  it("broadens once with the standalone question, then stops", () => {
    expect(search!.queries).toEqual(["zig 0.16 release notes", q]);
    expect(result!.metadata.sources!.length).toBe(1);
  });
});

describe("Lookup: time-sensitive questions use the news index", () => {
  it("passes topic=news with a recency window", async () => {
    const seen: Array<{ topic?: string; recency?: string }> = [];
    const provider = new FixtureSearchProvider({}, [{ url: "https://www.reuters.com/tech/x", title: "AI news", snippet: "Model X launched on 12 November 2026.", publishedAt: "2026-11-12T00:00:00Z" }]);
    const orig = provider.search.bind(provider);
    provider.search = (query, opts) => {
      seen.push({ topic: opts.topic, recency: opts.recency });
      return orig(query, opts);
    };
    const llm = new ScriptedLLMProvider({
      structured: { message_analysis: analysis({ needsWebSearch: true, standaloneQuestion: "Latest AI model releases this week", searchQueries: ["AI model release this week"] }) },
      synthesis: "Model X launched on 12 November 2026 [S1].",
    });
    const runtime = createRuntime(testConfig(), { llm: new LLMClient({ fast: { provider: llm, model: "f" }, extract: { provider: llm, model: "e" }, synthesis: { provider: llm, model: "s" } }), searchProvider: provider, now: () => FIXED_NOW, seed: false });
    const { error } = await runTurn(runtime, "What are the latest AI model releases this week?");
    expect(error).toBeUndefined();
    expect(seen[0]).toEqual({ topic: "news", recency: "month" });
  });
});

describe("Lookup: unsupported prices are removed even outside the pricing pipeline", async () => {
  const { result } = await (async () => {
    const rt = makeRuntime({
      script: {
        structured: { message_analysis: analysis({ needsWebSearch: true, standaloneQuestion: "What is Fly.io?", entities: ["Fly.io"], searchQueries: ["Fly.io platform overview"] }) },
        synthesis: "Fly.io runs apps close to users [S1].\nIt costs $7.77 per month for everything [S1].",
      },
      fallback: [
        { url: "https://fly.io/docs/about/", title: "About Fly.io", snippet: "Fly.io runs your apps close to your users.", content: "Fly.io runs your apps close to your users on hardware in many regions." },
        { url: "https://en.wikipedia.org/wiki/Fly.io", title: "Fly.io - Wikipedia", snippet: "Fly.io is a cloud platform.", content: "Fly.io is a cloud platform founded in 2017." },
        { url: "https://news.example.com/fly", title: "Fly.io raises", snippet: "Fly.io raised funding.", content: "Fly.io raised funding in 2022." },
      ],
      seed: false,
    });
    return runTurn(rt.runtime, "What is Fly.io?");
  })();

  it("drops the sentence with a price no source contains", () => {
    expect(result!.content).toContain("close to users");
    expect(result!.content).not.toContain("$7.77");
  });
});

describe("Lookup: answer model rate-limited before any output", () => {
  it("retries once on the regular synthesis model", async () => {
    const used: string[] = [];
    const base = new ScriptedLLMProvider({
      structured: { message_analysis: analysis({ needsWebSearch: true, standaloneQuestion: "What is HTMX?", searchQueries: ["htmx"] }) },
      synthesis: "HTMX extends HTML with AJAX attributes [S1].",
    });
    const provider: LLMProvider = {
      name: "flaky",
      completeJson: (req) => base.completeJson(req),
      async *streamText(req: CompletionRequest): AsyncIterable<StreamChunk> {
        used.push(req.model);
        if (req.model === "big") throw new AppError("LLM_RATE_LIMIT", "slow down", { retryable: true });
        yield* base.streamText(req);
      },
    };
    const search = new FixtureSearchProvider({}, [{ url: "https://htmx.org/docs/", title: "htmx docs", snippet: "htmx gives you access to AJAX directly in HTML, using attributes." }]);
    const runtime = createRuntime(testConfig(), { llm: new LLMClient({ fast: { provider, model: "small" }, extract: { provider, model: "big" }, synthesis: { provider, model: "small" } }), searchProvider: search, now: () => FIXED_NOW, seed: false });
    const events: AgentEvent[] = [];
    const msg = await runtime.agent.run({ message: "What is HTMX?", timezone: TZ }, (e) => events.push(e));
    expect(used).toEqual(["big", "small"]);
    expect(msg.content).toContain("HTMX extends HTML");
  });
});

describe("Chat mode", async () => {
  const { runtime, search, llm } = makeRuntime({
    script: { structured: { message_analysis: analysis({ intent: "chat", needsWebSearch: false, standaloneQuestion: "What can you help with?" }) }, synthesis: "I can research current topics on the web and recall our earlier conversations." },
  });
  const { result, error } = await runTurn(runtime, "Thanks! What kinds of questions can you help me with?");

  it("makes no search and uses the conversational prompt without memory instructions", () => {
    expect(error).toBeUndefined();
    expect(search!.queries).toHaveLength(0);
    const call = llm.calls.find((c) => c.kind === "stream")!;
    expect(call.system).toContain("Don't mention memory or earlier conversations unless the user asks");
    expect(call.prompt).not.toContain("<memory");
    expect(call.prompt).not.toContain("<search_status>");
    expect(result!.metadata.stats!.mode).toBe("chat");
  });
});

describe("Routing stays deep for memory and concrete price checks", async () => {
  it("a price question about a named product uses the verified pipeline", async () => {
    const { runtime, llm } = makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ needsWebSearch: true, standaloneQuestion: "Price of Acme Pro?", entities: ["Acme"], asksAboutPricing: true }),
          research_plan: { subjects: [{ name: "Acme", officialDomain: "acme.com" }], historicalClaims: [], searches: [{ query: "Acme Pro pricing", purpose: "pricing", subject: "Acme" }] },
          evidence_extraction: { findings: [], updates: [] },
        },
        synthesis: "I couldn't verify Acme's price.",
      },
      seed: false,
    });
    const { result } = await runTurn(runtime, "What does Acme Pro cost?");
    expect(llm.structuredCalls()[0]).toBe("message_analysis");
    expect(llm.structuredCalls()).toContain("research_plan");
    expect(result!.metadata.stats!.mode).toBe("deep");
  });
});
