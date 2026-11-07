import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, migrate, openSqliteMemoryStore, startMemoryPurge, type SqliteMemoryStore } from "../src/memory-sqlite.js";
import type { MemoryStore } from "../src/memory-store.js";
import type { ContextId } from "../src/types.js";
import { describeMemoryStoreContract, testClock } from "./memory-store-contract.js";

const personal = "personal" as ContextId;
const kidclub = "kidclub" as ContextId;
const opened: SqliteMemoryStore[] = [];
const dirs: string[] = [];

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-memory-"));
  dirs.push(dir);
  return dir;
};

const openAt = async (path: string, clock = testClock()) => {
  let n = 0;
  const result = await openSqliteMemoryStore({ path, now: clock.now, newId: () => `m${(n += 1)}-${path.length}` });
  if (!result.ok) throw new Error(result.error);
  opened.push(result.value);
  return result.value;
};

afterEach(async () => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describeMemoryStoreContract("SQLite store", async (clock) => (await openAt(join(await tempDir(), "memory.sqlite"), clock)).store);

const add = (store: MemoryStore, text: string, contextId = personal) =>
  store.add({ contextId, kind: "fact", text, origin: "auto", source: "req-1" });

describe("openSqliteMemoryStore", () => {
  it("keeps memories after a restart", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const first = await openAt(path);
    const m = await first.store.add({
      contextId: personal,
      kind: "history",
      text: "Planning Inês's party",
      origin: "auto",
      source: "req-1",
      conversationId: "conv-1",
      expiresAt: new Date("2026-12-07T10:00:00Z"),
    });
    await first.store.touch([m.id]);
    await first.store.markSeen([m.id]);
    first.close();

    const second = await openAt(path);
    expect(await second.store.get(m.id)).toEqual({ ...m, seen: true, lastUsedAt: new Date("2026-11-07T10:00:00Z") });
  });

  it("creates the file and its folder with mode 600, and tightens a looser file", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "memory.sqlite");
    await openAt(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const loose = join(dir, "loose.sqlite");
    await writeFile(loose, "", { mode: 0o644 });
    await openAt(loose);
    expect((await stat(loose)).mode & 0o777).toBe(0o600);
  });

  it("removes deleted text from the file itself, for a delete and for a wipe", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const { store } = await openAt(path);
    const deleted = await add(store, "MARKER-DELETED-1234 Inês's teacher is Ms Rita");
    await add(store, "MARKER-WIPED-5678 KidClub opens at 08:00", kidclub);
    await add(store, "MARKER-KEPT-9012 Takes espresso");

    await store.delete(deleted.id);
    expect(await store.wipe({ contextId: kidclub })).toBe(1);

    const raw = (await readFile(path)).toString("latin1");
    expect(raw).not.toContain("MARKER-DELETED-1234");
    expect(raw).not.toContain("MARKER-WIPED-5678");
    expect(raw).toContain("MARKER-KEPT-9012");
  });

  it("refuses with a clear error when the file isn't a database, naming only the path", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    await writeFile(path, "this is not a database, it's a note about Inês", { mode: 0o600 });
    const result = await openSqliteMemoryStore({ path });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`can't open the memory database at ${path}`);
  });

  it("refuses a database from a newer Jarvis", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    (await openAt(path)).close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    db.prepare("UPDATE schema_version SET version = 99").run();
    db.close();
    const result = await openSqliteMemoryStore({ path });
    expect(!result.ok && result.error).toContain("schema version 99, newer than this Jarvis");
  });

  it("doesn't print Node's 'SQLite is experimental' warning, and leaves other warnings alone", async () => {
    const original = process.emitWarning;
    await openAt(join(await tempDir(), "memory.sqlite"));
    expect(process.emitWarning).toBe(original);
  });
});

describe("migrate", () => {
  it("runs every step once from an empty database, then nothing", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(["memories", "schema_version"]);
    db.close();
  });

  it("applies only the new steps, and rolls back a failing one", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(migrate(db, [...MIGRATIONS, "ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"])).toBe(
      MIGRATIONS.length + 1,
    );
    expect(() => migrate(db, [...MIGRATIONS, "ALTER TABLE memories ADD COLUMN pinned INTEGER", "NOT VALID SQL"])).toThrow();
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(MIGRATIONS.length + 1);
    db.close();
  });

  it("rejects bad kinds and origins at the database level", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(() =>
      db
        .prepare("INSERT INTO memories (id, context_id, kind, text, origin, created_at, updated_at, source) VALUES ('x', 'p', 'secret', 't', 'auto', 0, 0, 's')")
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("startMemoryPurge", () => {
  it("purges at once and then on a timer, reporting counts and errors", async () => {
    vi.useFakeTimers();
    try {
      const purgeExpired = vi.fn<() => Promise<number>>().mockResolvedValueOnce(2).mockRejectedValueOnce(new TypeError("x"));
      const onPurged = vi.fn();
      const onError = vi.fn();
      const stop = startMemoryPurge({ purgeExpired } as unknown as MemoryStore, { everyMs: 1000, onPurged, onError });
      await vi.advanceTimersByTimeAsync(0);
      expect(onPurged).toHaveBeenCalledWith(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(purgeExpired).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
