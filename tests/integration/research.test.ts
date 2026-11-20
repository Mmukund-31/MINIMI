/**
 * Research pipeline end to end (comparison and general research): round-1 search → claim
 * extraction verified in code → entities × aspects coverage → one targeted follow-up round for
 * gaps → answer over verified claims + coverage → claim gate.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@minimi/core";
import type { JsonCompletionRequest } from "@minimi/core";
import { analysis, promptText, sourceIdsByDomain } from "../../evals/fixtures/scenario-kit";
import { eventsOf, makeRuntime, runTurn } from "../helpers";

const question = "Bun vs Deno for a new HTTP API: performance and security model?";
const comparison = analysis({
  intent: "research",
  researchIntent: "comparison",
  needsWebSearch: true,
  standaloneQuestion: question,
  entities: ["Bun", "Deno"],
  aspects: ["performance", "security model"],
  searchQueries: ["Bun HTTP performance", "Deno HTTP performance"],
});
const fixtures = {
  "Bun HTTP performance": [
    { url: "https://bun.sh/blog/bun-benchmarks", title: "Bun benchmarks", snippet: "Bun.serve handles 110k requests per second in our HTTP benchmark.", content: "Bun.serve handles 110k requests per second in our HTTP benchmark on a single core." },
  ],
  "Deno HTTP performance": [
    { url: "https://docs.deno.com/runtime/fundamentals/http_server/", title: "Deno HTTP server", snippet: "Deno.serve handles 95k requests per second.", content: "Deno.serve handles 95k requests per second. Deno is secure by default: permissions are opt-in for file, network and environment access." },
    { url: "https://deno.com/blog/v2.6", title: "Deno 2.6 release notes", snippet: "Deno 2.6 was released on 3 October 2026.", content: "Deno 2.6 was released on 3 October 2026 with faster HTTP handling." },
  ],
  // Only the gap (Bun · security model) is searched again.
  "Bun security model": [
    { url: "https://bun.sh/docs/runtime/security", title: "Bun security", snippet: "Bun has no permission system; scripts run with full access, like Node.js.", content: "Bun has no permission system; scripts run with full access, like Node.js. Its security model relies on the operating system." },
  ],
};

const extraction = (req: JsonCompletionRequest) => {
  const ids = sourceIdsByDomain(promptText(req));
  const bun = ids.get("bun.sh")?.[0];
  const deno = ids.get("docs.deno.com")?.[0];
  return {
    claims: [
      { sourceId: bun, entity: "Bun", aspect: "performance", claim: "Bun.serve handles 110k requests per second.", quote: "Bun.serve handles 110k requests per second" },
      { sourceId: deno, entity: "Deno", aspect: "performance", claim: "Deno.serve handles 95k requests per second.", quote: "Deno.serve handles 95k requests per second" },
      { sourceId: deno, entity: "Deno", aspect: "Security", claim: "Deno permissions are opt-in.", quote: "permissions are opt-in for file, network and environment access" },
      // Fabricated quote and an invented figure: both rejected in code.
      { sourceId: bun, entity: "Bun", aspect: "security model", claim: "Bun sandboxes all scripts.", quote: "Bun sandboxes every script by default" },
      { sourceId: deno, entity: "Deno", aspect: "performance", claim: "Deno handles 250k requests per second.", quote: "Deno.serve handles 95k requests per second" },
    ].filter((c) => c.sourceId),
  };
};

describe("Research: a comparison with a coverage gap", async () => {
  const { runtime, search, llm } = makeRuntime({
    script: {
      structured: { message_analysis: comparison, claim_extraction: extraction },
      synthesis: (req) => {
        const p = promptText(req);
        const ids = sourceIdsByDomain(p);
        const bun = ids.get("bun.sh") ?? [];
        const deno = ids.get("docs.deno.com")?.[0];
        return [
          "Bun is faster; Deno is safer by default.",
          "",
          "| Option | Performance | Security model |",
          "|---|---|---|",
          `| Bun | 110k req/s [${bun[0]}] | no permission system [${bun[1] ?? bun[0]}] |`,
          `| Deno | 95k req/s [${deno}] | opt-in permissions [${deno}] |`,
          `| Node | 400k req/s [${deno}] | n/a |`,
          "",
          p.includes("<verified_claims>") && p.includes('<coverage rounds="2">') ? "CONTEXT_OK" : "CONTEXT_MISSING",
        ].join("\n");
      },
    },
    searchFixtures: fixtures,
    seed: false,
  });
  const { events, result, error } = await runTurn(runtime, question);

  it("runs the research pipeline: analysis + one extraction + the answer", () => {
    expect(error).toBeUndefined();
    expect(llm.structuredCalls()).toEqual(["message_analysis", "claim_extraction"]);
    expect(result!.metadata.stats).toMatchObject({ mode: "research", intent: "comparison", llmCalls: 3, rounds: 2 });
  });

  it("keeps only claims whose quotes are in the source and that add no figures", () => {
    const claims = result!.metadata.research!.claims;
    expect(claims.map((c) => c.claim)).toEqual(["Bun.serve handles 110k requests per second.", "Deno.serve handles 95k requests per second.", "Deno permissions are opt-in."]);
    // "Security" was mapped onto the requested aspect; confidence is computed in code (official source).
    expect(claims[2]).toMatchObject({ entity: "Deno", aspect: "security model", confidence: 0.9 });
  });

  it("searches only the gap in round 2, never repeating a query", () => {
    expect(search!.queries).toEqual(["Bun HTTP performance", "Deno HTTP performance", "Bun security model"]);
    const cov = result!.metadata.research!.coverage;
    const cell = (e: string, a: string) => cov.cells.find((c) => c.entity === e && c.aspect === a)!.status;
    expect(cell("Bun", "performance")).toBe("verified");
    expect(cell("Deno", "performance")).toBe("verified");
    expect(cell("Deno", "security model")).toBe("verified");
    expect(cell("Bun", "security model")).toBe("mentioned");
    expect(cov.followUpQueries).toEqual(["Bun security model"]);
    expect(eventsOf(events, "search").some((e) => e.query.endsWith("· follow-up"))).toBe(true);
  });

  it("gives the answer model verified claims and the coverage matrix", () => {
    expect(result!.content).toContain("CONTEXT_OK");
  });

  it("checks table rows like sentences: supported rows stay, a row with an unsupported figure is removed", () => {
    expect(result!.content).toContain("| Bun | 110k req/s");
    expect(result!.content).toContain("| Deno | 95k req/s");
    expect(result!.content).not.toContain("400k");
    const check = result!.metadata.research!.claimCheck;
    expect(check.removed).toBe(1);
    expect(check.items.find((i) => i.status === "unsupported")?.missing).toEqual(["400000"]);
  });
});

describe("Research: extraction failure degrades to answering from excerpts", async () => {
  const { result, error } = await (async () => {
    const rt = makeRuntime({
      script: {
        structured: { message_analysis: comparison, claim_extraction: new AppError("LLM_RATE_LIMIT", "slow down", { retryable: true }) },
        synthesis: "Bun is faster on benchmarks; Deno has opt-in permissions.",
      },
      searchFixtures: fixtures,
      seed: false,
    });
    return runTurn(rt.runtime, question);
  })();

  it("still answers, with coverage from source mentions only", () => {
    expect(error).toBeUndefined();
    expect(result!.metadata.research!.claims).toEqual([]);
    expect(result!.metadata.research!.coverage.cells.every((c) => c.status !== "verified")).toBe(true);
  });
});

describe("Research: no gaps means no second round", async () => {
  const { search, result } = await (async () => {
    const rt = makeRuntime({
      script: {
        structured: { message_analysis: analysis({ ...comparison, aspects: ["performance"] }), claim_extraction: extraction },
        synthesis: "Both are fast.",
      },
      searchFixtures: fixtures,
      seed: false,
    });
    const r = await runTurn(rt.runtime, question);
    return { search: rt.search, result: r.result };
  })();

  it("stops after round 1 when every cell is covered", () => {
    expect(search!.queries).toEqual(["Bun HTTP performance", "Deno HTTP performance"]);
    expect(result!.metadata.research!.coverage.rounds).toBe(1);
  });
});

describe("Official sources first (general questions)", async () => {
  const seen: Array<{ query: string; includeDomains?: string[] }> = [];
  const rt = makeRuntime({
    script: {
      structured: { message_analysis: analysis({ needsWebSearch: true, standaloneQuestion: "Latest Node.js LTS?", entities: ["Node.js"], searchQueries: ["Node.js latest LTS version"], officialDomains: ["nodejs.org", "g2.com"] }) },
      synthesis: (req) => `Node.js 26 is the active LTS [${sourceIdsByDomain(promptText(req)).get("nodejs.org")?.[0]}].`,
    },
    searchFixtures: {
      "Node.js latest LTS": [
        { url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases", snippet: "Node.js 26 is in Active LTS.", content: "Node.js 26 is in Active LTS." },
        { url: "https://someblog.example.com/node", title: "Node LTS explained", snippet: "Node 26 became LTS.", content: "Node 26 became LTS." },
      ],
    },
    seed: false,
  });
  const orig = rt.search!.search.bind(rt.search!);
  rt.search!.search = (query, opts) => {
    seen.push({ query, includeDomains: opts.includeDomains });
    return orig(query, opts);
  };
  const { result, error } = await runTurn(rt.runtime, "What is the latest Node.js LTS?");

  it("runs one query restricted to the vetted official domains (review sites dropped) alongside the open search", () => {
    expect(error).toBeUndefined();
    expect(seen.find((s) => s.includeDomains?.length)?.includeDomains).toContain("nodejs.org");
    expect(seen.some((s) => s.includeDomains?.some((d) => d.includes("g2")))).toBe(false);
    expect(seen.some((s) => !s.includeDomains?.length)).toBe(true);
  });

  it("ranks the official page first", () => {
    expect(result!.metadata.sources![0]!.domain).toBe("nodejs.org");
  });
});
