import { describe, expect, it } from "vitest";
import { assessCoverage, checkableFigures, figureSupported, namesEntity, ClaimGate, ensureRequiredFindings, gapQueries, requiredFindings, statedDates, verifyClaims, authorityOf } from "@minimi/core";
import type { Comparison, Source } from "@minimi/core";

const src = (id: string, domain: string, content: string, extra: Partial<Source> = {}): Source =>
  ({ id, title: `Page ${id}`, url: `https://${domain}/${id}`, sourceDomain: domain, snippet: "", content, kind: "third_party", rankScore: 1, retrievedAt: "2026-11-15T00:00:00Z", query: "q", provider: "t", ...extra }) as Source;

describe("checkableFigures", () => {
  it("normalises thousands, suffixes and versions; ignores small counts and citations", () => {
    expect(checkableFigures("Bun served 110k req/s [S12] across 3 runs")).toEqual(["110000"]);
    expect(checkableFigures("110,000 requests, 2.7× faster, Node 24, v1.91.0")).toEqual(["110000", "2.7", "24", "1.91.0"]);
    expect(checkableFigures("1.2 million users")).toEqual(["1200000"]);
    // Digits glued to letters are names (live 2026-11-20: "p99" was read as 99).
    expect(checkableFigures("p99 latency on an H100, GPT-5.1")).toEqual(["5.1"]);
  });

  it("accepts a rounded large figure (live: '≈112k req/s' for 112,400), never a rounded year or version", () => {
    const set = new Set(["112400", "71300", "2026", "1.91.0"]);
    expect(figureSupported("112000", set)).toBe(true);
    expect(figureSupported("71000", set)).toBe(true);
    expect(figureSupported("120000", set)).toBe(false);
    expect(figureSupported("2025", set)).toBe(false);
    expect(figureSupported("1.92.0", set)).toBe(false);
  });
});

describe("ClaimGate", () => {
  const sources = [
    src("S1", "nodejs.org", "Node.js 26.13.1 is the latest release. LTS support ends on 30 April 2029.", { publishedAt: "2026-11-11T00:00:00Z" }),
    src("S2", "blog.example.com", "Node 26 entered LTS in October 2026."),
  ];
  const run = (answer: string, context = "") => {
    const g = new ClaimGate(sources, context);
    // Stream in uneven chunks: lines are only released once complete.
    let out = "";
    for (let i = 0; i < answer.length; i += 7) out += g.push(answer.slice(i, i + 7));
    return { text: out + g.flush(), stats: g.stats };
  };

  it("keeps sentences whose figures are in a cited source, including its publication date", () => {
    const r = run("The latest release is 26.13.1, published 11 November 2026 [S1]. LTS ends 30 April 2029 [S1].\n");
    expect(r.text).toContain("26.13.1");
    expect(r.stats).toMatchObject({ checked: 2, supported: 2, removed: 0 });
  });

  it("re-cites a figure to the source that states it", () => {
    const r = run("Node 26 entered LTS in October 2026 [S1].");
    expect(r.text).toBe("Node 26 entered LTS in October 2026 [S1] [S2].");
    expect(r.stats.repaired).toBe(1);
  });

  it("adds a citation to an uncited sentence whose figures a source states", () => {
    expect(run("LTS support ends on 30 April 2029.").text).toBe("LTS support ends on 30 April 2029 [S1].");
  });

  it("removes a sentence whose figure is in no source, keeping the rest of the line", () => {
    const r = run("- Node 26 is current [S2]. It has 4.5 million weekly downloads [S1]. It is stable.");
    expect(r.text).toBe("- Node 26 is current [S2]. It is stable.");
    expect(r.stats.items.find((i) => i.status === "unsupported")).toMatchObject({ missing: ["4500000"] });
  });

  it("exempts figures from the question and the conversation", () => {
    const r = run("For your 40 developers, Node 26 is fine [S2].", "We have 40 developers.");
    expect(r.text).toContain("40 developers");
    expect(r.stats.removed).toBe(0);
  });

  it("passes sentences without figures (meaning is not judged)", () => {
    const r = run("Node is a JavaScript runtime [S1].");
    expect(r.stats).toMatchObject({ checked: 0, citedWithoutFigures: 1 });
  });
});

describe("verifyClaims and coverage", () => {
  const sources = [
    src("S1", "rust-lang.org", "Rust 1.92.0 will be released on 11 December 2026.", { kind: "official" }),
    src("S2", "releases.example.dev", "The next stable, Rust 1.92.0, ships Dec 18, 2026."),
    src("S3", "news.example.com", "Rust adds a new edition guide."),
  ];

  it("maps labels, rejects unquoted claims, scores confidence in code", () => {
    const { claims, rejected } = verifyClaims(
      {
        claims: [
          { sourceId: "S1", entity: "rust", aspect: "Release date", claim: "Rust 1.92.0 releases on 11 December 2026.", quote: "Rust 1.92.0 will be released on 11 December 2026" },
          { sourceId: "S2", entity: "Rust", aspect: "release date", claim: "Rust 1.92.0 ships 18 December 2026.", quote: "Rust 1.92.0, ships Dec 18, 2026" },
          { sourceId: "S3", entity: "Rust", aspect: "release date", claim: "Rust 2.0 ships next week.", quote: "Rust 2.0 ships next week" },
          { sourceId: "S9", entity: "Rust", aspect: null, claim: "x", quote: "whatever text here" },
        ],
      },
      sources,
      { entities: ["Rust"], aspects: ["release date"] },
    );
    expect(claims.map((c) => c.sourceId)).toEqual(["S1", "S2"]);
    expect(claims[0]).toMatchObject({ entity: "Rust", aspect: "release date", confidence: 1 }); // official 0.9 + corroborated
    expect(claims[1]!.confidence).toBe(0.7); // secondary 0.6 + corroborated
    expect(rejected.map((r) => r.reason)).toEqual(["quote not found in source", "unknown source S9"]);

    const cov = assessCoverage({ entities: ["Rust"], aspects: ["release date", "new features"], claims, sources, round: 1 });
    expect(cov.cells.map((c) => c.status)).toEqual(["verified", "gap"]);
    // Two domains state different dates for the same thing: reported, not resolved.
    expect(cov.conflicts).toEqual([{ entity: "Rust", aspect: "release date", kind: "date", values: [{ value: "2026-12-11", sourceId: "S1" }, { value: "2026-12-18", sourceId: "S2" }] }]);
    expect(gapQueries(cov, { question: "When is Rust 1.92?", previous: [], max: 3, year: "2026" })).toEqual(["Rust new features 2026"]);
    expect(gapQueries(cov, { question: "When is Rust 1.92?", previous: ["rust new features 2026"], max: 3, year: "2026" })).toEqual([]);
  });

  it("parses stated dates in common formats", () => {
    expect(statedDates("on 3 October 2026, Oct 4, 2026 and 2026-10-05")).toEqual(["2026-10-05", "2026-10-03", "2026-10-04"]);
  });

  it("source authority", () => {
    expect(authorityOf("official", "x.com")).toBe("official");
    expect(authorityOf("news", "reuters.com")).toBe("primary");
    expect(authorityOf("third_party", "nist.gov")).toBe("primary");
    expect(authorityOf("third_party", "medium.com")).toBe("secondary");
  });
});

describe("required findings (deep pipeline)", () => {
  const rows = [
    { subject: "Zoho CRM", category: "product_update", attribute: "Possible update", dimension: "feature", currentValue: "Zoho Desk adds Blended Agents built on Zia Agents", status: "uncertain", explanation: "Reported only by a third-party page published 2026-11-16; not confirmed by the vendor or reputable news.", evidenceIds: ["e1"], sourceIds: ["S11"] },
    { subject: "Salesforce Sales Cloud", category: "product_update", attribute: "Major update", dimension: "feature", currentValue: "Copilotforce partnership announced", status: "changed", explanation: "Published 2026-11-17.", evidenceIds: ["e2"], sourceIds: ["S8"] },
    { subject: "HubSpot", category: "product_update", attribute: "Major update", dimension: "feature", status: "uncertain", explanation: "No major update dated after our conversation appeared.", evidenceIds: [], sourceIds: [] },
  ] as unknown as Comparison[];

  it("appends a finding the prose omitted (live CRM answer, 2026-11-20)", () => {
    const prose = "Only Salesforce's feature set has changed: the Copilotforce partnership was announced [S8]. No new prices or major releases have been confirmed for Pipedrive or Zoho.";
    const req = requiredFindings(rows);
    expect(req.map((r) => r.subject)).toEqual(["Zoho CRM", "Salesforce Sales Cloud"]);
    const out = ensureRequiredFindings(prose, req);
    expect(out.added).toEqual(["Zoho CRM"]);
    expect(out.text).toContain("**Also found:**\n- Zoho CRM: possible update: Zoho Desk adds Blended Agents built on Zia Agents (reported only by a third-party page published 2026-11-16) [S11]");
  });

  it("adds nothing when every finding is stated", () => {
    const prose = "Salesforce announced the Copilotforce partnership [S8]. A third-party page reports Zoho Desk adds Blended Agents [S11].";
    expect(ensureRequiredFindings(prose, requiredFindings(rows)).added).toEqual([]);
  });
});

describe("live 2026-11-20 fixes", () => {
  const pricing = [
    { id: "S1", title: "Copilot pricing", url: "https://github.com/features/copilot/plans", sourceDomain: "github.com", snippet: "", content: "Copilot Business costs $19 per user per month.", kind: "official_pricing", rankScore: 1, retrievedAt: "2026-11-20T00:00:00Z", query: "q", provider: "t" },
    { id: "S2", title: "Windsurf pricing", url: "https://windsurf.com/pricing", sourceDomain: "windsurf.com", snippet: "", content: "Teams: $80 per month base plus $40 per seat.", kind: "official_pricing", rankScore: 1, retrievedAt: "2026-11-20T00:00:00Z", query: "q", provider: "t" },
  ] as unknown as Source[];

  it("accepts totals derived from a source figure and a count the user gave; marks an unsupported cell instead of dropping the row", () => {
    const g = new ClaimGate(pricing, "Compare tools for a team of 10 developers.", "Compare tools for a team of 10 developers.");
    const table = [
      "| Tool | Pricing (10 devs) | Privacy |",
      "|---|---|---|",
      "| Copilot | $19/user; 10 users ≈ $190/month [S1] | TLS encryption [S1] |",
      "| Windsurf | $80 base + $40 per seat = $480/month [S2] | 99.99% uptime SLA [S2] |",
      "",
    ].join("\n");
    const out = g.push(table) + g.flush();
    expect(out).toContain("$190/month [S1]");
    expect(out).toContain("$480/month [S2]");
    expect(out).toContain("| Windsurf |");
    expect(out).toContain("| not verified |");
    expect(g.stats).toMatchObject({ checked: 3, supported: 2, removed: 1 });
  });

  it("namesEntity requires every distinctive token of the name", () => {
    expect(namesEntity("Zentrix Zeus quantum poster", "Zentrix QuantumDB 9")).toBe(false);
    expect(namesEntity("Zentrix QuantumDB 9 ships in May", "Zentrix QuantumDB 9")).toBe(true);
    expect(namesEntity("Node.js 26 is LTS", "Node.js")).toBe(true);
  });
});

describe("ClaimGate streaming", () => {
  const sources = [src("S1", "nodejs.org", "Node.js 26 is LTS until 30 April 2029.")];

  it("releases each checked sentence before the paragraph ends", () => {
    const g = new ClaimGate(sources, "");
    expect(g.push("Node.js 26 is the LTS line [S1]. It is supported until 30 Apr")).toBe("Node.js 26 is the LTS line [S1]. ");
    expect(g.push("il 2029 [S1]. Upgrade soon.\n")).toBe("It is supported until 30 April 2029 [S1]. Upgrade soon.\n");
  });

  it("passes code blocks through untouched", () => {
    const g = new ClaimGate(sources, "");
    const code = "Run this:\n```js\napp.listen(8080);\n```\nDone.\n";
    expect(g.push(code) + g.flush()).toBe(code);
    expect(g.stats.removed).toBe(0);
  });
});
