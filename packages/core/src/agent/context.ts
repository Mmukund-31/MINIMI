import { formatLocal } from "../temporal/resolver";
import { planLabel, truncate } from "../shared/text";
import type { Comparison, Evidence, HistoricalClaim, MemoryExchange, MemorySummary, Message, OfferingNote, PlanStatusNote, Source } from "../shared/types";

/**
 * Context assembly. Every block is size-bounded so prompts stay within the
 * configured budget (MAX_CONTEXT_CHARS) regardless of history or page size.
 */

export function formatRecent(messages: Message[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of [...messages].reverse()) {
    const line = `${m.role === "user" ? "User" : "Assistant"}: ${truncate(m.content.replace(/\s+/g, " "), 700)}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n");
}

export function formatMemory(exchanges: MemoryExchange[], timezone: string, maxChars: number, withIds: boolean): string {
  if (exchanges.length === 0) return "";
  const perExchange = Math.max(600, Math.floor(maxChars / exchanges.length));
  const blocks = exchanges.map((e) => {
    const when = formatLocal(e.at, timezone);
    const parts = [`--- Conversation "${e.conversationTitle}" (${when})${e.seeded ? " [seeded demo data]" : ""}`];
    if (e.user) parts.push(`User asked: ${truncate(e.user.content, Math.floor(perExchange * 0.3))}`);
    if (e.assistant) {
      parts.push(`Assistant answered${withIds ? ` [messageId=${e.assistant.id}]` : ""}: ${truncate(e.assistant.content, Math.floor(perExchange * 0.7))}`);
    }
    return parts.join("\n");
  });
  return truncate(blocks.join("\n"), maxChars);
}

/**
 * Query-focused excerpt: when a page is longer than the budget, keep verbatim
 * windows around prices and the focus terms (plan/vendor names) instead of just
 * the start of the page (pricing tables are rarely at the top). Windows are
 * joined with " … ", which the quote verifier understands as an elision.
 */
export function focusedExcerpt(text: string, budget: number, focusTerms: string[] = []): string {
  if (text.length <= budget) return text;
  const anchors: number[] = [];
  for (const m of text.matchAll(/[$€£₹¥]\s?\d/g)) anchors.push(m.index);
  for (const term of focusTerms.map((t) => t.trim()).filter((t) => t.length >= 3)) {
    // Whole-word matches only ("Pro" must not match "Products").
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    for (const m of text.matchAll(re)) {
      if (anchors.length >= 400) break;
      anchors.push(m.index);
    }
  }
  if (anchors.length === 0) return truncate(text, budget);
  const radius = 160;
  const maxWindow = Math.max(4 * radius, Math.floor(budget / 2));
  const windows = anchors
    .sort((a, b) => a - b)
    .map((a) => [Math.max(0, a - radius), Math.min(text.length, a + radius)] as [number, number])
    .reduce<Array<[number, number]>>((acc, w) => {
      const last = acc[acc.length - 1];
      // Merge overlapping windows, but never into one block too big to fit the budget.
      if (last && w[0] <= last[1] && Math.max(last[1], w[1]) - last[0] <= maxWindow) last[1] = Math.max(last[1], w[1]);
      else acc.push([...w]);
      return acc;
    }, []);
  // Price windows first (they carry the facts), then the rest, until the budget is used.
  const hasPrice = (w: [number, number]) => /[$€£₹¥]\s?\d/.test(text.slice(w[0], w[1]));
  const ordered = [...windows.filter(hasPrice), ...windows.filter((w) => !hasPrice(w))];
  const picked: Array<[number, number]> = [];
  let used = 0;
  for (const w of ordered) {
    if (used + (w[1] - w[0]) > budget) continue;
    picked.push(w);
    used += w[1] - w[0] + 3;
  }
  if (picked.length === 0) return truncate(text, budget);
  // Trim to word boundaries so no window starts or ends mid-word.
  return picked
    .sort((a, b) => a[0] - b[0])
    .map(([s, e]) => text.slice(s, e).replace(/^\S*\s/, s === 0 ? "$&" : "").replace(/\s\S*$/, e === text.length ? "$&" : ""))
    .join(" … ");
}

/** Sources wrapped as clearly delimited, untrusted data blocks. */
export function formatSourcesForExtraction(sources: Source[], maxChars: number, focusTerms: string[] = []): string {
  if (sources.length === 0) return "(no results)";
  const per = Math.max(400, Math.floor(maxChars / sources.length) - 120);
  return sources
    .map((s) => {
      const body = focusedExcerpt(`${s.snippet}\n${s.content ?? ""}`.trim(), per, focusTerms).replace(/<\/?source[^>]*>/gi, "");
      return `<source id="${s.id}" domain="${s.sourceDomain}" kind="${s.kind}" published="${s.publishedAt?.slice(0, 10) ?? "unknown"}">\nTitle: ${truncate(s.title, 160)}\n${body}\n</source>`;
    })
    .join("\n");
}

export function formatClaims(claims: HistoricalClaim[]): string {
  return claims.map((c) => `- ${c.subject} | ${c.attribute} | ${c.value}`).join("\n");
}

export interface SynthesisInput {
  question: string;
  nowLocal: string;
  timezone: string;
  recent: Message[];
  memory: { summary: MemorySummary; exchanges: MemoryExchange[] } | null;
  memoryRequested: boolean;
  comparisons: Comparison[];
  /** Current plans the earlier answer did not discuss (completeness). */
  offering?: OfferingNote[];
  /** Plans the vendor lists as legacy (verified). */
  planStatus?: PlanStatusNote[];
  evidence: Evidence[];
  sources: Source[];
  notes: string[];
  searchAttempted: boolean;
  maxChars: number;
}

export function buildSynthesisContext(i: SynthesisInput): string {
  const budget = i.maxChars;
  const parts: string[] = [];
  parts.push(`<now>${i.nowLocal} (${i.timezone})</now>`);
  const recent = formatRecent(i.recent, Math.floor(budget * 0.12));
  if (recent) parts.push(`<recent_conversation>\n${recent}\n</recent_conversation>`);

  if (i.memoryRequested) {
    const m = i.memory;
    if (!m || m.summary.status !== "found") {
      parts.push(`<memory status="not_found">No matching earlier conversation was found.</memory>`);
    } else {
      parts.push(
        `<memory status="found" interpretation="${m.summary.interpretation ?? ""}" seeded="${m.summary.seeded ? "true" : "false"}">\n${formatMemory(m.exchanges, i.timezone, Math.floor(budget * 0.3), false)}\n</memory>`,
      );
    }
  }

  if (i.comparisons.length > 0) {
    const rows = i.comparisons.map(
      (c) =>
        `- ${c.subject} | ${c.category} | ${c.attribute} | then: ${c.previousValue ?? "n/a"} | now: ${c.currentValue ?? "n/a"} | status: ${c.status} | dimension: ${c.dimension}${c.historicalAccuracy === "already_outdated" ? " | earlier answer already out of date" : ""}${c.changeTiming ? ` | timing: ${c.changeTiming}` : ""} | ${c.explanation}${c.sourceIds.length ? ` | sources: ${c.sourceIds.map((s) => `[${s}]`).join("")}` : ""}`,
    );
    parts.push(`<comparisons>\n${truncate(rows.join("\n"), Math.floor(budget * 0.2))}\n</comparisons>`);
  }

  if (i.offering?.length) {
    const lines = i.offering.map((o) => `- ${o.subject}: ${o.plansNotDiscussed.map((p) => `${p.plan} (${p.value}) [${p.sourceId}]`).join("; ")}`);
    parts.push(`<offering>\n${truncate(lines.join("\n"), Math.floor(budget * 0.08))}\n</offering>`);
  }

  if (i.planStatus?.length) {
    const lines = i.planStatus.map(
      (n) => `- ${planLabel(n.subject, n.plan)} (${n.value}) is LEGACY [${n.sourceId}]: "${truncate(n.statusQuote, 160)}"${n.successor ? ` | closest current tier: ${n.successor.plan} (${n.successor.value}) [${n.successor.sourceId}]` : ""}`,
    );
    parts.push(`<plan_status>\n${lines.join("\n")}\n</plan_status>`);
  }

  if (i.evidence.length > 0) {
    const lines = i.evidence.map(
      (e) =>
        `- [${e.sourceId}] ${e.subject} | ${e.attribute}: ${e.value} | quote: "${truncate(e.quote, 220)}" | ${e.sourceKind}${e.publishedAt ? ` | published ${e.publishedAt.slice(0, 10)}` : ""}`,
    );
    parts.push(`<evidence>\n${truncate(lines.join("\n"), Math.floor(budget * 0.25))}\n</evidence>`);
  } else if (i.searchAttempted) {
    parts.push(`<evidence>No verifiable evidence was extracted from the search results.</evidence>`);
  }

  if (i.sources.length > 0) {
    const lines = i.sources.map((s) => `[${s.id}] ${truncate(s.title, 100)} | ${s.sourceDomain} | ${s.kind}${s.publishedAt ? ` | published ${s.publishedAt.slice(0, 10)}` : ""}`);
    parts.push(`<sources>\n${lines.join("\n")}\n</sources>`);
  }
  if (i.notes.length > 0) parts.push(`<notes>\n${i.notes.map((n) => `- ${n}`).join("\n")}\n</notes>`);
  parts.push(`<question>${i.question}</question>`);
  return parts.join("\n\n");
}
