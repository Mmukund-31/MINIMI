/**
 * Helpers for building deterministic scenarios (tests + offline evals).
 * Scripted model outputs reference sources by *domain*; these helpers map
 * domains to the runtime-assigned [S#] ids by reading the actual prompt, so
 * the real ranking/validation code decides the ids.
 */
import type { Analysis, Plan } from "@minimi/core";
import type { CompletionRequest, JsonCompletionRequest } from "@minimi/core";

export function promptText(req: JsonCompletionRequest | CompletionRequest): string {
  return req.messages.map((m) => m.content).join("\n");
}

/** Maps domain → source id from an evidence-extraction prompt. */
export function sourceIdsByDomain(prompt: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of prompt.matchAll(/<source id="(S\d+)" domain="([^"]+)"/g)) {
    const arr = map.get(m[2]!) ?? [];
    arr.push(m[1]!);
    map.set(m[2]!, arr);
  }
  return map;
}

export interface FindingSpec {
  domain: string;
  subject: string;
  attribute: string;
  value: string;
  quote: string;
  category?: "pricing" | "other";
  planStatus?: "current" | "legacy";
  statusQuote?: string;
  successor?: string;
}
export interface UpdateSpec {
  domain: string;
  subject: string;
  title: string;
  quote: string;
  significance: "major" | "minor";
}

/** Builds an evidence-extraction responder. `rawFindings` bypass domain mapping (for adversarial ids). */
export function evidenceResponder(
  findings: FindingSpec[],
  updates: UpdateSpec[] = [],
  rawFindings: Array<{ subject: string; category: "pricing" | "other"; attribute: string; value: string; quote: string; sourceId: string }> = [],
) {
  return (req: JsonCompletionRequest) => {
    const prompt = promptText(req);
    const ids = sourceIdsByDomain(prompt);
    const blocks = new Map([...prompt.matchAll(/<source id="(S\d+)"[^>]*>([\s\S]*?)<\/source>/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
    // Like a model would: cite the page on that domain that actually contains the quote (else the first one).
    const pick = (d: string, quote: string) => {
      const cands = ids.get(d) ?? [];
      return cands.find((id) => blocks.get(id)?.includes(quote.toLowerCase().slice(0, 30))) ?? cands[0];
    };
    return {
      findings: [
        ...findings
          .filter((f) => pick(f.domain, f.quote))
          .map((f) => ({ subject: f.subject, category: f.category ?? "pricing", attribute: f.attribute, value: f.value, quote: f.quote, sourceId: pick(f.domain, f.quote)!, ...(f.planStatus ? { planStatus: f.planStatus, statusQuote: f.statusQuote ?? null, successor: f.successor ?? null } : {}) })),
        ...rawFindings,
      ],
      updates: updates
        .filter((u) => pick(u.domain, u.quote))
        .map((u) => ({ subject: u.subject, title: u.title, quote: u.quote, sourceId: pick(u.domain, u.quote)!, significance: u.significance })),
    };
  };
}

/** A synthesis responder that cites whatever sources are listed (plus an optional bogus id). */
export function synthesisResponder(opts: { lead: string; bogusCitation?: boolean; inventUrl?: boolean }) {
  return (req: CompletionRequest) => {
    const p = promptText(req);
    const ids = [...new Set([...p.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]!))];
    const memoryNotFound = p.includes('<memory status="not_found">');
    const parts = [memoryNotFound ? "I couldn't find that conversation in my memory." : opts.lead];
    if (ids.length) parts.push(`Current pricing is listed on the vendor pages ${ids.slice(0, 3).map((i) => `[${i}]`).join("")}.`);
    if (opts.bogusCitation) parts.push("Another claim [S42].");
    if (opts.inventUrl) parts.push("See https://totally-made-up.example.com/pricing for details.");
    return parts.join(" ");
  };
}

export function analysis(partial: Partial<Analysis>): Analysis {
  return {
    intent: "research",
    needsMemory: false,
    needsWebSearch: true,
    standaloneQuestion: "",
    entities: [],
    temporalExpressions: [],
    asksAboutPricing: false,
    asksAboutProductUpdates: false,
    searchQueries: [],
    researchIntent: partial.needsMemory ? "historical_audit" : partial.needsWebSearch === false ? "chat" : partial.asksAboutPricing ? "pricing_diff" : "fact_lookup",
    aspects: [],
    officialDomains: [],
    ...partial,
  } as Analysis;
}

export function plan(partial: Partial<Plan>): Plan {
  return { subjects: [], historicalClaims: [], searches: [], ...partial };
}
