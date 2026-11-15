import type { ConversationRepository, MessageRepository } from "../db/repositories";
import { keywords } from "../shared/text";
import type { MemoryExchange, MemorySummary, Message } from "../shared/types";
import type { TemporalCandidate, TemporalReference } from "../temporal/resolver";

/**
 * Hybrid conversational memory retrieval.
 *
 *   temporal candidates ─► date filter ─┐
 *   entities/keywords ──► FTS5 (bm25) ──┼─► rank ─► expand to Q/A exchanges ─► bound
 *   recency ────────────────────────────┘
 *
 * The retriever never fabricates: if nothing matches it returns
 * status "not_found" and the answer must say so.
 */

export interface MemoryQuery {
  /** Free-text query (the user's message, or a rewritten standalone question). */
  text: string;
  /** Extra terms from entity extraction (product names, topics). */
  terms?: string[];
  temporal?: TemporalReference[];
  /** Current conversation (its recent turns are supplied separately). */
  currentConversationId?: string;
  /** Messages to ignore (e.g. the message being answered). */
  excludeMessageIds?: string[];
  /** Upper bound on exchanges returned. */
  maxExchanges?: number;
  now: string;
}

export interface MemoryResult {
  summary: MemorySummary;
  exchanges: MemoryExchange[];
  /** Human-readable notes for the answer (ambiguity, fallbacks). */
  notes: string[];
}

/** Builds a safe FTS5 query: quoted tokens, prefix match for longer tokens, OR-combined. */
export function buildFtsQuery(terms: string[]): string {
  const toks = new Set<string>();
  for (const t of terms) for (const k of keywords(t)) toks.add(k.replace(/[^a-z0-9]/g, ""));
  return [...toks]
    .filter((t) => t.length >= 2)
    .slice(0, 16)
    .map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`))
    .join(" OR ");
}

/** Words too generic to identify a topic on their own. */
const GENERIC_TERMS = new Set([
  "price", "prices", "pricing", "cost", "costs", "plan", "plans", "tool", "tools", "product", "products",
  "update", "updates", "feature", "features", "team", "compare", "comparison", "options", "option", "best", "cheapest",
]);

/** Counts distinct query terms present in the messages; generic terms count a quarter. */
export function topicalScore(msgs: Message[], terms: string[]): number {
  const text = msgs.map((m) => m.content.toLowerCase()).join("\n");
  let score = 0;
  for (const t of terms) {
    const stem = t.length >= 6 ? t.slice(0, t.length - 2) : t;
    if (text.includes(stem)) score += GENERIC_TERMS.has(t) ? 0.25 : 1;
  }
  return score;
}

export class MemoryRetriever {
  constructor(
    private readonly messages: MessageRepository,
    private readonly conversations: ConversationRepository,
  ) {}

  retrieve(q: MemoryQuery): MemoryResult {
    const maxExchanges = q.maxExchanges ?? 6;
    const terms = [q.text, ...(q.terms ?? [])];
    const fts = buildFtsQuery(terms);
    const termList = [...new Set(terms.flatMap((t) => keywords(t)))];
    const exclude = q.excludeMessageIds ?? [];
    const notes: string[] = [];

    const sinceLast = q.temporal?.find((r) => r.kind === "since_last_discussion");
    const dated = (q.temporal ?? []).filter((r) => r.kind !== "since_last_discussion" && r.candidates.length > 0);

    // 1) "since our last discussion" → the previous conversation.
    if (sinceLast && q.currentConversationId) {
      const prev = this.conversations.previousConversation(q.currentConversationId, q.now);
      if (prev) {
        const msgs = this.messages.listByConversation(prev.id).filter((m) => !exclude.includes(m.id));
        const ex = this.toExchanges(msgs).slice(-maxExchanges);
        return this.result(ex, `your previous conversation ("${prev.title}")`, notes);
      }
      notes.push("No earlier conversation was found to compare against.");
    }

    // 2) Dated reference(s): try candidates in order; prefer ones with keyword matches.
    if (dated.length > 0) {
      for (const ref of dated) {
        const outcomes = ref.candidates.map((c) => ({ c, hits: this.searchWindow(c, fts, termList, exclude) }));
        const withAny = outcomes.filter((o) => o.hits.messages.length > 0);
        // Highest topical overlap wins; ties keep candidate order (most natural reading first).
        const ranked = [...withAny].sort((a, b) => b.hits.termScore - a.hits.termScore);
        const chosen = ranked[0];
        if (!chosen) continue;
        if (ref.ambiguous) {
          const others = ranked.filter((o) => o !== chosen && o.hits.termScore === chosen.hits.termScore);
          if (others.length > 0) {
            notes.push(
              `"${ref.expression}" is ambiguous: there are matching conversations on ${chosen.c.label} and ${others.map((o) => o.c.label).join(", ")}. Using ${chosen.c.label}.`,
            );
          } else if (ref.candidates.length > 1) {
            notes.push(`Interpreted "${ref.expression}" as ${chosen.c.label} (${chosen.c.interpretation}).`);
          }
        }
        if (!chosen.hits.termMatched && fts) {
          notes.push(`Nothing on ${chosen.c.label} mentioned the topic directly, so this uses everything discussed that day.`);
        }
        const ex = this.toExchanges(chosen.hits.messages);
        return this.result(this.bound(ex, maxExchanges), `${ref.expression} → ${chosen.c.label}`, notes);
      }
      // Dated reference with no messages in any candidate window: be explicit, then try topic-only as a fallback.
      const labels = dated.flatMap((r) => r.candidates.map((c) => c.label)).join(" or ");
      notes.push(`I have no saved conversation from ${labels}.`);
      if (fts) {
        const ex = this.topicSearch(fts, exclude, q.currentConversationId, maxExchanges);
        if (ex.length > 0) {
          notes.push("Showing the closest matching conversation on the same topic from a different date instead.");
          return this.result(ex, "topic match on a different date", notes);
        }
      }
      return { summary: { status: "not_found", conversationIds: [], messageIds: [] }, exchanges: [], notes };
    }

    // 3) Topic-only retrieval.
    if (fts) {
      const ex = this.topicSearch(fts, exclude, q.currentConversationId, maxExchanges);
      if (ex.length > 0) return this.result(ex, "topic match", notes);
    }
    return { summary: { status: "not_found", conversationIds: [], messageIds: [] }, exchanges: [], notes };
  }

  private searchWindow(
    c: TemporalCandidate,
    fts: string,
    termList: string[],
    exclude: string[],
  ): { messages: Message[]; termMatched: boolean; termScore: number } {
    if (fts) {
      const hits = this.messages.search(fts, { startUtc: c.startUtc, endUtc: c.endUtc, limit: 30, excludeIds: exclude });
      if (hits.length > 0) {
        // Keep every message from conversations that matched, so Q/A pairs stay intact.
        const convIds = new Set(hits.map((h) => h.message.conversationId));
        const all = this.messages.inRange(c.startUtc, c.endUtc, { excludeIds: exclude }).filter((m) => convIds.has(m.conversationId));
        return { messages: all, termMatched: true, termScore: topicalScore(all, termList) };
      }
    }
    return { messages: this.messages.inRange(c.startUtc, c.endUtc, { excludeIds: exclude, limit: 60 }), termMatched: false, termScore: 0 };
  }

  private topicSearch(fts: string, exclude: string[], currentConversationId: string | undefined, max: number): MemoryExchange[] {
    const hits = this.messages.search(fts, { limit: 40, excludeIds: exclude });
    if (hits.length === 0) return [];
    // Score per conversation: best bm25 (more negative = better) + small recency prior.
    const best = new Map<string, { score: number; msgs: Message[] }>();
    const newest = Math.max(...hits.map((h) => Date.parse(h.message.createdAt)));
    for (const h of hits) {
      if (h.message.conversationId === currentConversationId) continue;
      const ageDays = (newest - Date.parse(h.message.createdAt)) / 86_400_000;
      const score = -h.bm25 - Math.min(ageDays, 365) * 0.002;
      const cur = best.get(h.message.conversationId);
      if (!cur) best.set(h.message.conversationId, { score, msgs: [h.message] });
      else {
        cur.score = Math.max(cur.score, score) + 0.05 * Math.min(cur.msgs.length, 5);
        cur.msgs.push(h.message);
      }
    }
    const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 2);
    const out: MemoryExchange[] = [];
    for (const [, v] of ranked) {
      const expanded = new Map<string, Message>();
      for (const m of v.msgs) {
        expanded.set(m.id, m);
        const pair = m.role === "user" ? this.messages.neighbor(m, "next") : this.messages.neighbor(m, "prev");
        if (pair && !exclude.includes(pair.id)) expanded.set(pair.id, pair);
      }
      out.push(...this.toExchanges([...expanded.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))));
    }
    return this.bound(out, max);
  }

  /** Groups messages into user→assistant exchanges, preserving order. */
  private toExchanges(msgs: Message[]): MemoryExchange[] {
    const titles = new Map<string, { title: string; seeded: boolean }>();
    const conv = (id: string) => {
      if (!titles.has(id)) {
        const c = this.conversations.get(id);
        titles.set(id, { title: c?.title ?? "Untitled", seeded: Boolean(c?.metadata.seeded) });
      }
      return titles.get(id)!;
    };
    const sorted = [...msgs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const out: MemoryExchange[] = [];
    for (const m of sorted) {
      const c = conv(m.conversationId);
      const last = out[out.length - 1];
      if (m.role === "assistant" && last && last.conversationId === m.conversationId && last.user && !last.assistant) {
        last.assistant = m;
        continue;
      }
      out.push({
        conversationId: m.conversationId,
        conversationTitle: c.title,
        seeded: c.seeded || Boolean(m.metadata.seeded),
        ...(m.role === "user" ? { user: m } : { assistant: m }),
        at: m.createdAt,
      });
    }
    return out;
  }

  private bound(ex: MemoryExchange[], max: number): MemoryExchange[] {
    return ex.length <= max ? ex : ex.slice(0, max);
  }

  private result(exchanges: MemoryExchange[], interpretation: string, notes: string[]): MemoryResult {
    if (exchanges.length === 0) return { summary: { status: "not_found", conversationIds: [], messageIds: [] }, exchanges, notes };
    const messageIds = exchanges.flatMap((e) => [e.user?.id, e.assistant?.id].filter((x): x is string => Boolean(x)));
    return {
      summary: {
        status: "found",
        interpretation,
        conversationIds: [...new Set(exchanges.map((e) => e.conversationId))],
        messageIds,
        baselineDate: exchanges[0]!.at,
        seeded: exchanges.some((e) => e.seeded),
      },
      exchanges,
      notes,
    };
  }
}
