/**
 * Versioned, append-only SQL migrations. Embedded as strings so they ship with
 * the bundled server. Each migration runs once inside a transaction and is
 * recorded in `schema_migrations`.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: /* sql */ `
      CREATE TABLE conversations (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        timezone    TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

      CREATE TABLE messages (
        rowid            INTEGER PRIMARY KEY AUTOINCREMENT,
        id               TEXT NOT NULL UNIQUE,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content          TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        metadata         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_messages_conversation_time ON messages(conversation_id, created_at);
      CREATE INDEX idx_messages_time ON messages(created_at);

      -- Full-text index over message content (external content table, kept in sync by triggers).
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE research_sessions (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id   TEXT,
        query             TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        completed_at      TEXT,
        execution_status  TEXT NOT NULL CHECK (execution_status IN ('running','completed','failed','cancelled')),
        error_code        TEXT,
        stats             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_research_conversation ON research_sessions(conversation_id, started_at);

      CREATE TABLE search_records (
        id                   TEXT PRIMARY KEY,
        research_session_id  TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
        query                TEXT NOT NULL,
        provider             TEXT NOT NULL,
        retrieved_at         TEXT NOT NULL,
        status               TEXT NOT NULL,
        result_count         INTEGER NOT NULL DEFAULT 0,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_search_session ON search_records(research_session_id);

      CREATE TABLE evidence_records (
        id                   TEXT PRIMARY KEY,
        research_session_id  TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
        claim                TEXT NOT NULL,
        source_url           TEXT NOT NULL,
        source_title         TEXT NOT NULL,
        evidence_type        TEXT NOT NULL,
        published_at         TEXT,
        retrieved_at         TEXT NOT NULL,
        confidence           TEXT NOT NULL,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_evidence_session ON evidence_records(research_session_id);

      CREATE TABLE message_evidence (
        message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        evidence_id  TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
        source_ref   TEXT NOT NULL,
        PRIMARY KEY (message_id, evidence_id)
      );

      CREATE TABLE search_cache (
        cache_key   TEXT PRIMARY KEY,
        provider    TEXT NOT NULL,
        query       TEXT NOT NULL,
        response    TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `,
  },
];
