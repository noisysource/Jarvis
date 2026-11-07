// A MemoryStore on Node's built-in SQLite (`node:sqlite`, #60): no extra
// dependency and nothing native to compile, so it runs the same on a Mac and
// on the Raspberry Pi.
//
// - The file (default data/memory.sqlite) is gitignored and kept at mode 600.
// - Deletion is real: `secure_delete` overwrites deleted rows with zeros, and
//   a wipe also compacts the file (VACUUM), so deleted text doesn't linger.
// - The schema has numbered steps that only move forward (schema_version).
// - Ranking uses the same word matching as the in-memory store
//   (`rankMemories`), so every store orders memories the same way. A context
//   holds at most a few thousand short memories, so ranking them in code is
//   cheap; a full-text index can come later if that ever changes.

import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type * as Sqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { rankMemories, type MemoryFilter, type MemoryStore } from "./memory-store.js";
import { err, ok, type Result } from "./result.js";
import type { ContextId, Memory, MemoryKind, MemoryOrigin } from "./types.js";

/** Each step runs once, in order, inside a transaction. Never edit a step that has shipped: add a new one. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     context_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('fact', 'playbook', 'history')),
     text TEXT NOT NULL,
     origin TEXT NOT NULL CHECK (origin IN ('auto', 'explicit')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_used_at INTEGER,
     expires_at INTEGER,
     conversation_id TEXT,
     source TEXT NOT NULL,
     seen INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX memories_by_context ON memories (context_id, kind);
   CREATE INDEX memories_by_conversation ON memories (conversation_id);`,
];

type Row = {
  id: string;
  context_id: string;
  kind: string;
  text: string;
  origin: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  conversation_id: string | null;
  source: string;
  seen: number;
};

const toMemory = (row: Row): Memory => ({
  id: row.id,
  contextId: row.context_id as ContextId,
  kind: row.kind as MemoryKind,
  text: row.text,
  origin: row.origin as MemoryOrigin,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  source: row.source,
  seen: row.seen === 1,
  ...(row.last_used_at !== null ? { lastUsedAt: new Date(row.last_used_at) } : {}),
  ...(row.expires_at !== null ? { expiresAt: new Date(row.expires_at) } : {}),
  ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
});

/**
 * Loads node:sqlite without its one-off "SQLite is an experimental feature"
 * warning. Only that warning is dropped, only while loading; every other
 * warning still goes through.
 */
const loadSqlite = async (): Promise<typeof Sqlite> => {
  const original = process.emitWarning;
  const filtered = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (rest[0] === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature")) return;
    (original as (w: string | Error, ...r: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  process.emitWarning = filtered;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
};

/** Creates the file (mode 600) if it's missing, and tightens it to 600 if it isn't. */
const prepareFile = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
};

/** Brings the schema up to date. Returns the version it ended on. */
export const migrate = (db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number => {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (row === undefined) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  if (version > migrations.length) {
    throw new Error(`memory database is at schema version ${version}, newer than this Jarvis (${migrations.length})`);
  }
  for (const step of migrations.slice(version)) {
    db.exec("BEGIN");
    try {
      db.exec(step);
      version += 1;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return version;
};

export type SqliteMemoryStore = {
  readonly store: MemoryStore;
  readonly close: () => void;
};

/**
 * Opens (or creates) the memory database. Returns an error instead of
 * throwing, so the server can refuse to start with a clear message. The
 * error names the path and the reason, never any memory text.
 */
export const openSqliteMemoryStore = async (options: {
  readonly path: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}): Promise<Result<SqliteMemoryStore, string>> => {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  let db: DatabaseSync;
  try {
    if (options.path !== ":memory:") await prepareFile(options.path);
    const { DatabaseSync } = await loadSqlite();
    db = new DatabaseSync(options.path);
    db.exec("PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
    migrate(db);
  } catch (e) {
    return err(`can't open the memory database at ${options.path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const one = (id: string): Memory | undefined => {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? toMemory(row) : undefined;
  };
  const many = (sql: string, ...params: (string | number)[]): Memory[] =>
    (db.prepare(sql).all(...params) as Row[]).map(toMemory);
  const transaction = (fn: () => void): void => {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const notExpired = "(expires_at IS NULL OR expires_at > ?)";

  const store: MemoryStore = {
    add: async (input) => {
      const id = newId();
      const at = now().getTime();
      db.prepare(
        `INSERT INTO memories (id, context_id, kind, text, origin, created_at, updated_at, expires_at, conversation_id, source, seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        id,
        input.contextId,
        input.kind,
        input.text,
        input.origin,
        at,
        at,
        input.expiresAt?.getTime() ?? null,
        input.conversationId ?? null,
        input.source,
      );
      const added = one(id);
      if (!added) throw new Error("memory insert failed");
      return added;
    },

    update: async (id, changes) => {
      const existing = one(id);
      if (!existing) return undefined;
      db.prepare("UPDATE memories SET text = ?, origin = ?, expires_at = ?, updated_at = ?, seen = 0 WHERE id = ?").run(
        changes.text ?? existing.text,
        changes.origin ?? existing.origin,
        (changes.expiresAt ?? existing.expiresAt)?.getTime() ?? null,
        now().getTime(),
        id,
      );
      return one(id);
    },

    get: async (id) => one(id),

    search: async ({ contextId, text, kinds, limit }) => {
      if (kinds.length === 0 || limit <= 0) return [];
      const placeholders = kinds.map(() => "?").join(", ");
      const candidates = many(
        `SELECT * FROM memories WHERE context_id = ? AND kind IN (${placeholders}) AND ${notExpired}`,
        contextId,
        ...kinds,
        now().getTime(),
      );
      return rankMemories(candidates, text).slice(0, limit);
    },

    recentHistory: async ({ contextId, limit }) =>
      many(
        `SELECT * FROM memories WHERE context_id = ? AND kind = 'history' AND ${notExpired}
         ORDER BY updated_at DESC LIMIT ?`,
        contextId,
        now().getTime(),
        Math.max(0, limit),
      ),

    touch: async (ids) => {
      const at = now().getTime();
      const statement = db.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
      transaction(() => {
        for (const id of ids) statement.run(at, id);
      });
    },

    list: async (filter: MemoryFilter = {}) => {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.contextId !== undefined) {
        where.push("context_id = ?");
        params.push(filter.contextId);
      }
      if (filter.kind !== undefined) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter.conversationId !== undefined) {
        where.push("conversation_id = ?");
        params.push(filter.conversationId);
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      return many(`SELECT * FROM memories ${clause} ORDER BY updated_at DESC, rowid DESC`, ...params);
    },

    markSeen: async (ids) => {
      const statement = db.prepare("UPDATE memories SET seen = 1 WHERE id = ?");
      transaction(() => {
        for (const id of ids) statement.run(id);
      });
    },

    delete: async (id) => Number(db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0,

    wipe: async ({ contextId }) => {
      const removed = Number(db.prepare("DELETE FROM memories WHERE context_id = ?").run(contextId).changes);
      db.exec("VACUUM");
      return removed;
    },

    purgeExpired: async () =>
      Number(db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now().getTime()).changes),
  };

  return ok({ store, close: () => db.close() });
};

/** Purges expired memories now and then about once a day. Returns a function that stops it. */
export const startMemoryPurge = (
  store: MemoryStore,
  options: { readonly everyMs?: number; readonly onError?: (e: unknown) => void; readonly onPurged?: (n: number) => void } = {},
): (() => void) => {
  const run = (): void => {
    store.purgeExpired().then(
      (n) => options.onPurged?.(n),
      (e: unknown) => options.onError?.(e),
    );
  };
  run();
  const timer = setInterval(run, options.everyMs ?? 24 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
};
