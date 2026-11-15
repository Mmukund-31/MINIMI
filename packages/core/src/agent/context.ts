import { formatLocal } from "../temporal/resolver";
import { truncate } from "../shared/text";
import type { Comparison, Evidence, HistoricalClaim, MemoryExchange, MemorySummary, Message, Source } from "../shared/types";

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

/** Sources wrapped as clearly delimited, untrusted data blocks. */
export function formatSourcesForExtraction(sources: Source[], maxChars: number): string {
  if (sources.length === 0) return "(no results)";
  const per = Math.max(400, Math.floor(maxChars / sources.length) - 120);
  return sources
    .map((s) => {
      const body = truncate(`${s.snippet}\n${s.content ?? ""}`.trim(), per).replace(/<\/?source[^>]*>/gi, "");
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
        `- ${c.subject} | ${c.category} | ${c.attribute} | then: ${c.previousValue ?? "n/a"} | now: ${c.currentValue ?? "n/a"} | status: ${c.status} | ${c.explanation}${c.sourceIds.length ? ` | sources: ${c.sourceIds.map((s) => `[${s}]`).join("")}` : ""}`,
    );
    parts.push(`<comparisons>\n${truncate(rows.join("\n"), Math.floor(budget * 0.2))}\n</comparisons>`);
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
