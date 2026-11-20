/**
 * End-to-end (scripted LLM + fixture search, real pipeline) regressions from the final live run:
 * Neon's change predates the conversation; Cursor Pro is a legacy plan.
 */
import { describe, expect, it } from "vitest";
import { evidenceResponder, analysis, plan } from "../../evals/fixtures/scenario-kit";
import { pgMessage, pgScript, pgSearch } from "../../evals/fixtures/demo-fixtures";
import { makeRuntime, runTurn } from "../helpers";

const neonNow = {
  ...pgSearch,
  "neon pricing": [{ url: "https://neon.com/pricing", title: "Neon Pricing", snippet: "Launch: $0.106 per CU-hour, no monthly minimum. Scale: $0.222 per CU-hour." }],
};
const neonScript = (synthesis: string) => ({
  structured: {
    ...pgScript.structured,
    evidence_extraction: evidenceResponder([
      { domain: "neon.com", subject: "Neon", attribute: "Launch", value: "$0.106 per CU-hour", quote: "Launch: $0.106 per CU-hour" },
      { domain: "supabase.com", subject: "Supabase", attribute: "Pro", value: "$25 / month per organization", quote: "Pro: $25 / month per organization" },
    ]),
  },
  // The model's prose claims a change *since* the conversation (as the live answer did).
  synthesis,
});
const sinceProse = "Neon’s pricing model has changed since the last conversation: the flat rate was replaced by usage-based pricing [S1]. Supabase Pro is unchanged [S2].";

describe("Neon: flat → usage-based on undated pages", () => {
  it("with a self-dated vendor page from before the conversation: 'already out of date', the timing source is cited", async () => {
    const { runtime, search } = makeRuntime({
      script: neonScript(sinceProse),
      searchFixtures: {
        ...neonNow,
        "Neon Launch pricing change": [
          {
            url: "https://neon.com/blog/new-usage-based-pricing",
            title: "New usage-based pricing - Neon",
            snippet: "Pay for what you use",
            content: `# New usage-based pricing\nPay for what you use Mike Jerome–Product Manager Aug 14, 2025\nLaunch compute is $0.106 per CU-hour and paid plans have no monthly minimum.${" filler".repeat(80)}`,
          },
          { url: "https://selfhost.dev/blog/neon", title: "Neon pricing explained", snippet: "x", content: "Published on Jan 2, 2025. Launch $0.106/CU-hour" },
        ],
      },
    });
    const { result, error } = await runTurn(runtime, pgMessage);
    expect(error).toBeUndefined();
    expect(search!.queries).toContain("Neon Launch pricing change");
    expect(search!.queries.length).toBeLessThanOrEqual(runtime.config.budgets.maxSearches);
    const neon = result!.metadata.comparisons!.find((c) => c.subject === "Neon")!;
    expect(neon).toMatchObject({ status: "uncertain", historicalAccuracy: "already_outdated", changeTiming: "before_conversation", currentValue: "$0.106 per CU-hour" });
    const blog = result!.metadata.sources!.find((s) => s.url === "https://neon.com/blog/new-usage-based-pricing")!;
    expect(neon.sourceIds).toContain(blog.id);
    expect(result!.metadata.sources!.some((s) => s.domain === "selfhost.dev")).toBe(false); // third-party never dates the vendor's change
    expect(result!.content).not.toMatch(/changed since the last conversation/);
    expect(result!.content).toMatch(/already out of date/);
    expect(result!.content).toContain(`[${blog.id}]`);
  });

  it("without a dated page: 'changed' with unknown timing, and the prose can't claim 'since'", async () => {
    const { runtime } = makeRuntime({ script: neonScript(sinceProse), searchFixtures: { ...neonNow, "Neon Launch pricing change": [] } });
    const { result } = await runTurn(runtime, pgMessage);
    const neon = result!.metadata.comparisons!.find((c) => c.subject === "Neon")!;
    expect(neon).toMatchObject({ status: "changed", dimension: "pricing_model", changeTiming: "unknown" });
    expect(result!.content).not.toMatch(/changed since the last conversation/);
    expect(result!.content).toMatch(/can't tell whether it changed before or after our conversation/);
    expect(result!.content).toContain("Supabase Pro is unchanged [S2].");
    expect(result!.metadata.notes!.join(" ")).toMatch(/timing search for Neon found no dated page/);
  });
});

describe("Cursor control: legacy Pro plan", () => {
  const question = "What is the current price of the Cursor Pro plan?";
  const run = (synthesis: string) =>
    makeRuntime({
      script: {
        structured: {
          message_analysis: analysis({ standaloneQuestion: question, entities: ["Cursor"], asksAboutPricing: true }),
          research_plan: plan({ subjects: [{ name: "Cursor", officialDomain: "cursor.com" }], searches: [{ query: "Cursor Pro pricing", purpose: "pricing", subject: "Cursor" }] }),
          evidence_extraction: evidenceResponder([
            {
              domain: "cursor.com",
              subject: "Cursor",
              attribute: "Pro",
              value: "$20/mo",
              quote: "| Pro | $20/mo | Premium |",
              planStatus: "legacy",
              statusQuote: "Legacy plans aren't available to new customers, but existing subscribers keep them.",
              successor: "Premium",
            },
            { domain: "cursor.com", subject: "Cursor", attribute: "Premium", value: "$30/mo", quote: "Premium $30/mo" },
          ]),
        },
        synthesis,
      },
      searchFixtures: {
        "cursor pro pricing": [
          {
            url: "https://cursor.com/docs/account/pricing/legacy-cursor-plans",
            title: "Legacy Cursor plans",
            snippet: "Legacy plans aren't available to new customers, but existing subscribers keep them. | Plan | Price | Closest current plan | | Pro | $20/mo | Premium |",
          },
          { url: "https://cursor.com/pricing", title: "Pricing | Cursor", snippet: "Plus $8/mo. Premium $30/mo. Super $100/mo. Ultra $200/mo." },
        ],
      },
    });

  it("an answer that only says '$20 per month' is completed with all three facts", async () => {
    const { runtime } = run("The Cursor Pro plan is priced at $20 per month [S1].");
    const { result, error } = await runTurn(runtime, question);
    expect(error).toBeUndefined();
    const text = result!.content;
    expect(text).not.toBe("The Cursor Pro plan is priced at $20 per month [S1].");
    expect(text).toMatch(/\$20/); // the legacy Pro price
    expect(text).toMatch(/legacy plan that new customers can no longer buy/); // not sold to new customers
    expect(text).toMatch(/closest current tier is Premium at \$30\/mo/); // nearest current tier
    expect(result!.metadata.planStatus).toEqual([expect.objectContaining({ subject: "Cursor", plan: "Pro", successor: expect.objectContaining({ plan: "Premium", value: "$30/mo" }) })]);
  });
});
