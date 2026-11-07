// The behaviour every MemoryStore must have. Each store's test file runs this
// suite: the in-memory store here, SQLite (#60) and Firestore (#24) later.

import { describe, expect, it } from "vitest";
import type { MemoryStore, NewMemory } from "../src/memory-store.js";
import type { ContextId } from "../src/types.js";

const personal = "personal" as ContextId;
const kidclub = "kidclub" as ContextId;

/** A clock the test moves by hand. */
export const testClock = (start = "2026-11-07T10:00:00Z") => {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const fact = (text: string, extra: Partial<NewMemory> = {}): NewMemory => ({
  contextId: personal,
  kind: "fact",
  text,
  origin: "auto",
  source: "req-1",
  ...extra,
});

export const describeMemoryStoreContract = (
  name: string,
  makeStore: (clock: ReturnType<typeof testClock>) => MemoryStore | Promise<MemoryStore>,
): void => {
  describe(`${name}: MemoryStore contract`, () => {
    const setup = async () => {
      const clock = testClock();
      return { clock, store: await makeStore(clock) };
    };

    it("adds a memory, unseen, with timestamps, and gets it back", async () => {
      const { store, clock } = await setup();
      const m = await store.add(fact("Inês's teacher is Ms Rita", { conversationId: "conv-1" }));
      expect(m).toMatchObject({
        contextId: personal,
        kind: "fact",
        text: "Inês's teacher is Ms Rita",
        origin: "auto",
        source: "req-1",
        conversationId: "conv-1",
        seen: false,
      });
      expect(m.createdAt).toEqual(clock.now());
      expect(m.updatedAt).toEqual(clock.now());
      expect(typeof m.id).toBe("string");
      expect(await store.get(m.id)).toEqual(m);
      expect(await store.get("missing")).toBeUndefined();
    });

    it("updates text and origin, bumps updatedAt and marks it new again", async () => {
      const { store, clock } = await setup();
      const m = await store.add(fact("Inês swims on Tuesdays"));
      await store.markSeen([m.id]);
      clock.advance(60_000);
      const updated = await store.update(m.id, { text: "Inês swims on Thursdays", origin: "explicit" });
      expect(updated).toMatchObject({ id: m.id, text: "Inês swims on Thursdays", origin: "explicit", seen: false });
      expect(updated?.createdAt).toEqual(m.createdAt);
      expect(updated?.updatedAt).toEqual(clock.now());
      expect(await store.update("missing", { text: "x" })).toBeUndefined();
    });

    it("searches one context, best word match first, then most recently used", async () => {
      const { store, clock } = await setup();
      const swim = await store.add(fact("Inês swims on Tuesdays"));
      clock.advance(1000);
      const teacher = await store.add(fact("Inês's teacher is Ms Rita"));
      clock.advance(1000);
      const coffee = await store.add(fact("Takes espresso with no sugar"));
      await store.add(fact("KidClub opens at 08:00", { contextId: kidclub }));
      const playbook = await store.add(fact("Answer in Portuguese", { kind: "playbook" }));

      const found = await store.search({ contextId: personal, text: "Who is Inês's teacher?", kinds: ["fact"], limit: 10 });
      expect(found.map((m) => m.id)).toEqual([teacher.id, swim.id, coffee.id]);

      const both = await store.search({ contextId: personal, text: "anything", kinds: ["fact", "playbook"], limit: 2 });
      expect(both).toHaveLength(2);
      expect(both.map((m) => m.id)).toContain(playbook.id);
      expect(both.every((m) => m.contextId === personal)).toBe(true);
    });

    it("matches words regardless of accents, case and plurals", async () => {
      const { store } = await setup();
      const m = await store.add(fact("Inês swims on Tuesdays"));
      await store.add(fact("Takes espresso with no sugar"));
      const found = await store.search({ contextId: personal, text: "INES SWIM", kinds: ["fact"], limit: 1 });
      expect(found[0]?.id).toBe(m.id);
    });

    it("ranks equally matching memories by last use", async () => {
      const { store, clock } = await setup();
      const older = await store.add(fact("Gym on Monday"));
      clock.advance(1000);
      await store.add(fact("Gym on Friday"));
      clock.advance(1000);
      await store.touch([older.id]);
      const found = await store.search({ contextId: personal, text: "gym", kinds: ["fact"], limit: 2 });
      expect(found[0]?.id).toBe(older.id);
      expect(found[0]?.lastUsedAt).toEqual(clock.now());
    });

    it("returns recent history newest first, leaving expired lines out", async () => {
      const { store, clock } = await setup();
      const hour = 3_600_000;
      const old = await store.add(fact("Talked about the gym", { kind: "history", expiresAt: new Date(clock.now().getTime() + hour) }));
      clock.advance(1000);
      const recent = await store.add(fact("Planning the party", { kind: "history", expiresAt: new Date(clock.now().getTime() + 30 * 24 * hour) }));
      expect((await store.recentHistory({ contextId: personal, limit: 3 })).map((m) => m.id)).toEqual([recent.id, old.id]);
      clock.advance(2 * hour);
      expect((await store.recentHistory({ contextId: personal, limit: 3 })).map((m) => m.id)).toEqual([recent.id]);
      expect(await store.search({ contextId: personal, text: "gym", kinds: ["history"], limit: 5 })).not.toContainEqual(
        expect.objectContaining({ id: old.id }),
      );
      expect(await store.purgeExpired()).toBe(1);
      expect(await store.get(old.id)).toBeUndefined();
    });

    it("lists by context, kind and conversation, newest first", async () => {
      const { store, clock } = await setup();
      const a = await store.add(fact("A", { conversationId: "conv-1" }));
      clock.advance(1000);
      const b = await store.add(fact("B", { kind: "playbook" }));
      clock.advance(1000);
      const c = await store.add(fact("C", { contextId: kidclub }));
      expect((await store.list()).map((m) => m.id)).toEqual([c.id, b.id, a.id]);
      expect((await store.list({ contextId: personal })).map((m) => m.id)).toEqual([b.id, a.id]);
      expect((await store.list({ kind: "playbook" })).map((m) => m.id)).toEqual([b.id]);
      expect((await store.list({ conversationId: "conv-1" })).map((m) => m.id)).toEqual([a.id]);
    });

    it("marks memories seen", async () => {
      const { store } = await setup();
      const m = await store.add(fact("A"));
      await store.markSeen([m.id, "missing"]);
      expect((await store.get(m.id))?.seen).toBe(true);
    });

    it("deletes for real, and wipes one context only", async () => {
      const { store } = await setup();
      const a = await store.add(fact("A"));
      await store.add(fact("B"));
      const k = await store.add(fact("K", { contextId: kidclub }));
      expect(await store.delete(a.id)).toBe(true);
      expect(await store.delete(a.id)).toBe(false);
      expect(await store.get(a.id)).toBeUndefined();
      expect(await store.search({ contextId: personal, text: "A", kinds: ["fact"], limit: 5 })).toHaveLength(1);
      expect(await store.wipe({ contextId: personal })).toBe(1);
      expect(await store.list({ contextId: personal })).toEqual([]);
      expect(await store.get(k.id)).toBeDefined();
    });
  });
};
