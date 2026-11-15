import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations, type Migration } from "./migrations";

export type Db = DatabaseSync;

/**
 * Opens (and migrates) the SQLite database.
 *
 * Uses Node's built-in `node:sqlite` (SQLite 3.4x+ with FTS5) instead of a
 * native addon: nothing to compile or download, so `npm install` works on
 * locked-down machines where unsigned native binaries are blocked.
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  runMigrations(db);
  return db;
}

export function runMigrations(db: Db, list: Migration[] = migrations): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((r) => Number(r.id)),
  );
  const ran: number[] = [];
  for (const m of [...list].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
    });
    ran.push(m.id);
  }
  return ran;
}

/** Runs `fn` in a transaction; rolls back on error. Not re-entrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function checkDatabase(db: Db): boolean {
  try {
    db.prepare("SELECT 1 AS ok").get();
    return true;
  } catch {
    return false;
  }
}
