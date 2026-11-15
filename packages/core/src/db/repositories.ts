import type { Db } from "./connection";
import { transaction } from "./connection";
import { newId, nowIso } from "../shared/ids";
import type {
  Conversation,
  ConversationMetadata,
  Evidence,
  ExecutionStats,
  Message,
  MessageMetadata,
  Role,
} from "../shared/types";

type Row = Record<string, unknown>;

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

const toConversation = (r: Row): Conversation => ({
  id: String(r.id),
  title: String(r.title),
  timezone: String(r.timezone),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  metadata: parseJson<ConversationMetadata>(r.metadata, {}),
});

const toMessage = (r: Row): Message => ({
  id: String(r.id),
  conversationId: String(r.conversation_id),
  role: r.role as Role,
  content: String(r.content),
  createdAt: String(r.created_at),
  metadata: parseJson<MessageMetadata>(r.metadata, {}),
});

export interface ConversationListItem extends Conversation {
  messageCount: number;
  lastMessageAt: string | null;
}

// ── Conversations ────────────────────────────────────────────────────────

export class ConversationRepository {
  constructor(private readonly db: Db) {}

  create(input: { title?: string; timezone: string; metadata?: ConversationMetadata; createdAt?: string; id?: string }): Conversation {
    const ts = input.createdAt ?? nowIso();
    const conv: Conversation = {
      id: input.id ?? newId("conv"),
      title: input.title?.trim() || "New conversation",
      timezone: input.timezone,
      createdAt: ts,
      updatedAt: ts,
      metadata: input.metadata ?? {},
    };
    this.db
      .prepare("INSERT INTO conversations (id, title, timezone, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conv.id, conv.title, conv.timezone, conv.createdAt, conv.updatedAt, JSON.stringify(conv.metadata));
    return conv;
  }

  get(id: string): Conversation | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  list(limit = 100): ConversationListItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COUNT(m.id) AS message_count, MAX(m.created_at) AS last_message_at
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY COALESCE(MAX(m.created_at), c.updated_at) DESC
         LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({
      ...toConversation(r),
      messageCount: Number(r.message_count ?? 0),
      lastMessageAt: (r.last_message_at as string | null) ?? null,
    }));
  }

  rename(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, nowIso(), id);
  }

  touch(id: string, at = nowIso()): void {
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, id);
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  count(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as Row;
    return Number(r.n);
  }

  /** Most recent conversation (by last message) other than `excludeId` that has messages before `before`. */
  previousConversation(excludeId: string, before: string): Conversation | null {
    const r = this.db
      .prepare(
        `SELECT c.* FROM conversations c JOIN messages m ON m.conversation_id = c.id
         WHERE c.id != ? AND m.created_at < ?
         GROUP BY c.id ORDER BY MAX(m.created_at) DESC LIMIT 1`,
      )
      .get(excludeId, before) as Row | undefined;
    return r ? toConversation(r) : null;
  }
}

// ── Messages ─────────────────────────────────────────────────────────────

export interface FtsHit {
  message: Message;
  /** bm25 score (lower = better, as returned by SQLite). */
  bm25: number;
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  add(input: { conversationId: string; role: Role; content: string; metadata?: MessageMetadata; createdAt?: string; id?: string }): Message {
    const msg: Message = {
      id: input.id ?? newId("msg"),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? nowIso(),
      metadata: input.metadata ?? {},
    };
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)")
      .run(msg.id, msg.conversationId, msg.role, msg.content, msg.createdAt, JSON.stringify(msg.metadata));
    return msg;
  }

  get(id: string): Message | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  listByConversation(conversationId: string, limit = 500): Message[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?")
        .all(conversationId, limit) as Row[]
    ).map(toMessage);
  }

  /** Last `n` messages of a conversation, oldest first, optionally before a given message. */
  recent(conversationId: string, n: number, excludeId?: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND id != ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(conversationId, excludeId ?? "", n) as Row[];
    return rows.map(toMessage).reverse();
  }

  /** Messages in [startUtc, endUtc) across all conversations. */
  inRange(startUtc: string, endUtc: string, opts: { excludeIds?: string[]; limit?: number } = {}): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE created_at >= ? AND created_at < ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(startUtc, endUtc, opts.limit ?? 200) as Row[];
    const exclude = new Set(opts.excludeIds ?? []);
    return rows.map(toMessage).filter((m) => !exclude.has(m.id));
  }

  /**
   * Full-text search using FTS5 + bm25. `ftsQuery` must be pre-sanitised
   * (see memory/retrieval.ts buildFtsQuery). Optional time range filter.
   */
  search(ftsQuery: string, opts: { startUtc?: string; endUtc?: string; limit?: number; excludeIds?: string[] } = {}): FtsHit[] {
    if (!ftsQuery.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(messages_fts) AS score
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
           AND m.created_at >= ? AND m.created_at < ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(ftsQuery, opts.startUtc ?? "0000", opts.endUtc ?? "9999", opts.limit ?? 30) as Row[];
    const exclude = new Set(opts.excludeIds ?? []);
    return rows
      .map((r) => ({ message: toMessage(r), bm25: Number(r.score) }))
      .filter((h) => !exclude.has(h.message.id));
  }

  /** The message immediately before/after `msg` in its conversation. */
  neighbor(msg: Message, direction: "prev" | "next"): Message | null {
    const sql =
      direction === "prev"
        ? `SELECT * FROM messages WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, rowid DESC LIMIT 1`
        : `SELECT * FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, rowid ASC LIMIT 1`;
    const r = this.db.prepare(sql).get(msg.conversationId, msg.createdAt, msg.createdAt, msg.id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  updateMetadata(id: string, metadata: MessageMetadata): void {
    this.db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }
}

// ── Research sessions, search records, evidence ──────────────────────────

export interface SearchRecordInput {
  query: string;
  provider: string;
  retrievedAt: string;
  status: "ok" | "cached" | "failed" | "timeout";
  resultCount: number;
  metadata?: Record<string, unknown>;
}

export class ResearchRepository {
  constructor(private readonly db: Db) {}

  startSession(input: { id: string; conversationId: string; userMessageId: string; query: string }): void {
    this.db
      .prepare(
        `INSERT INTO research_sessions (id, conversation_id, user_message_id, query, started_at, execution_status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
      )
      .run(input.id, input.conversationId, input.userMessageId, input.query, nowIso());
  }

  finishSession(id: string, status: "completed" | "failed" | "cancelled", stats: ExecutionStats | null, errorCode?: string): void {
    this.db
      .prepare(`UPDATE research_sessions SET completed_at = ?, execution_status = ?, stats = ?, error_code = ? WHERE id = ?`)
      .run(nowIso(), status, JSON.stringify(stats ?? {}), errorCode ?? null, id);
  }

  getSession(id: string): Row | null {
    return (this.db.prepare("SELECT * FROM research_sessions WHERE id = ?").get(id) as Row | undefined) ?? null;
  }

  /** Persists searches + evidence + message links atomically. */
  saveResearch(input: { sessionId: string; messageId: string; searches: SearchRecordInput[]; evidence: Evidence[] }): void {
    transaction(this.db, () => {
      const insSearch = this.db.prepare(
        `INSERT INTO search_records (id, research_session_id, query, provider, retrieved_at, status, result_count, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of input.searches) {
        insSearch.run(newId("srch"), input.sessionId, s.query, s.provider, s.retrievedAt, s.status, s.resultCount, JSON.stringify(s.metadata ?? {}));
      }
      const insEv = this.db.prepare(
        `INSERT INTO evidence_records (id, research_session_id, claim, source_url, source_title, evidence_type, published_at, retrieved_at, confidence, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const link = this.db.prepare(`INSERT OR IGNORE INTO message_evidence (message_id, evidence_id, source_ref) VALUES (?, ?, ?)`);
      for (const e of input.evidence) {
        insEv.run(
          e.id,
          input.sessionId,
          e.claim,
          e.sourceUrl,
          e.sourceTitle,
          e.evidenceType,
          e.publishedAt ?? null,
          e.retrievedAt,
          e.strength,
          JSON.stringify({ subject: e.subject, category: e.category, attribute: e.attribute, value: e.value, quote: e.quote, sourceKind: e.sourceKind, significance: e.significance, quoteRepaired: e.quoteRepaired }),
        );
        link.run(input.messageId, e.id, e.sourceId);
      }
    });
  }

  searchRecords(sessionId: string): Row[] {
    return this.db.prepare("SELECT * FROM search_records WHERE research_session_id = ?").all(sessionId) as Row[];
  }

  evidenceForMessage(messageId: string): Row[] {
    return this.db
      .prepare(
        `SELECT e.*, me.source_ref FROM message_evidence me JOIN evidence_records e ON e.id = me.evidence_id WHERE me.message_id = ?`,
      )
      .all(messageId) as Row[];
  }
}

// ── Search cache ─────────────────────────────────────────────────────────

export class SearchCacheRepository {
  constructor(private readonly db: Db) {}

  get(key: string, maxAgeMs: number): string | null {
    const r = this.db.prepare("SELECT response, created_at FROM search_cache WHERE cache_key = ?").get(key) as Row | undefined;
    if (!r) return null;
    if (Date.now() - Date.parse(String(r.created_at)) > maxAgeMs) return null;
    return String(r.response);
  }

  set(key: string, provider: string, query: string, response: string): void {
    this.db
      .prepare(
        `INSERT INTO search_cache (cache_key, provider, query, response, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at`,
      )
      .run(key, provider, query, response, nowIso());
  }
}

export interface Repositories {
  conversations: ConversationRepository;
  messages: MessageRepository;
  research: ResearchRepository;
  searchCache: SearchCacheRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    research: new ResearchRepository(db),
    searchCache: new SearchCacheRepository(db),
  };
}
