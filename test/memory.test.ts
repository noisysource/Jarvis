import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMORY_TIMEOUT_MS,
  DEFAULT_WRAP_UP_TIMEOUT_MS,
  type Extract,
  type ExtractInput,
  type ExtractResult,
  extractNothing,
  MEMORY_LIMITS,
  makeMemoryHooks,
  makeSafeMemoryHooks,
  stubMemoryHooks,
  withTimeout,
} from "../src/memory.js";
import { makeMemoryStoreInMemory, type MemoryStore, type NewMemory } from "../src/memory-store.js";
import type { ContextId, Logger, Memory, MemoryHooks } from "../src/types.js";

const personal = "personal" as ContextId;
const QUESTION = "When is my daughter's birthday?";
const ANSWER = "2 September.";
const memory: Memory = {
  id: "m1",
  contextId: personal,
  kind: "fact",
  text: "Daughter is called Inês",
  origin: "auto",
  createdAt: new Date("2026-11-06T12:00:00Z"),
  updatedAt: new Date("2026-11-06T12:00:00Z"),
  source: "q0",
  seen: false,
};

const recordingLog = () => {
  const warn = vi.fn<Logger["warn"]>();
  const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
  return { log, warn };
};

const loadInput = { question: QUESTION, contextId: personal };
const wrapInput = { question: QUESTION, contextId: personal, answer: ANSWER, memoriesUsed: [memory] };

afterEach(() => {
  vi.useRealTimers();
});

describe("stubMemoryHooks", () => {
  it("loads no memories and does nothing on wrap-up", async () => {
    expect(await stubMemoryHooks.loadMemories(loadInput)).toEqual([]);
    expect(await stubMemoryHooks.wrapUp(wrapInput)).toBeUndefined();
  });
});

describe("withTimeout", () => {
  it("returns the value when the task finishes in time", async () => {
    expect(await withTimeout(async () => 42, 100)).toEqual({ ok: true, value: 42 });
  });

  it("reports errors, including ones thrown synchronously, without rejecting", async () => {
    expect(await withTimeout(() => Promise.reject(new TypeError("x")), 100)).toEqual({
      ok: false,
      reason: "error",
      errorName: "TypeError",
    });
    expect(
      await withTimeout(() => {
        throw new RangeError("sync");
      }, 100),
    ).toEqual({ ok: false, reason: "error", errorName: "RangeError" });
  });

  it("gives up at the deadline", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(() => new Promise<number>(() => undefined), 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("makeSafeMemoryHooks", () => {
  it("passes results through when hooks work", async () => {
    const hooks: MemoryHooks = { loadMemories: async () => [memory], wrapUp: vi.fn(async () => undefined) };
    const safe = makeSafeMemoryHooks(hooks);

    expect(await safe.loadMemories(loadInput)).toEqual([memory]);
    await safe.wrapUp(wrapInput);
    expect(hooks.wrapUp).toHaveBeenCalledWith(wrapInput);
  });

  it("falls back to no memories when loading fails", async () => {
    const { log, warn } = recordingLog();
    const safe = makeSafeMemoryHooks(
      { ...stubMemoryHooks, loadMemories: async () => Promise.reject(new Error(`db down for ${QUESTION}`)) },
      { log },
    );

    expect(await safe.loadMemories(loadInput)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("memory hook failed, continuing without it", {
      hook: "loadMemories",
      reason: "error",
      errorName: "Error",
    });
  });

  it("swallows a failing wrap-up", async () => {
    const { log, warn } = recordingLog();
    const safe = makeSafeMemoryHooks(
      { ...stubMemoryHooks, wrapUp: async () => Promise.reject(new Error("write failed")) },
      { log },
    );

    await expect(safe.wrapUp(wrapInput)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("memory hook failed, continuing without it", {
      hook: "wrapUp",
      reason: "error",
      errorName: "Error",
    });
  });

  it("times out a slow load after 2 seconds, and a stuck wrap-up (which runs after the reply) after 30", async () => {
    expect(DEFAULT_MEMORY_TIMEOUT_MS).toBe(2_000);
    expect(DEFAULT_WRAP_UP_TIMEOUT_MS).toBe(30_000);
    vi.useFakeTimers();
    const { log, warn } = recordingLog();
    const never = () => new Promise<never>(() => undefined);
    const safe = makeSafeMemoryHooks({ loadMemories: never, wrapUp: never }, { log });

    const loading = safe.loadMemories(loadInput);
    const wrapping = safe.wrapUp(wrapInput);
    await vi.advanceTimersByTimeAsync(DEFAULT_MEMORY_TIMEOUT_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await loading).toEqual([]);
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([{ hook: "loadMemories", reason: "timeout" }]);

    await vi.advanceTimersByTimeAsync(DEFAULT_WRAP_UP_TIMEOUT_MS - DEFAULT_MEMORY_TIMEOUT_MS);
    await expect(wrapping).resolves.toBeUndefined();
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([
      { hook: "loadMemories", reason: "timeout" },
      { hook: "wrapUp", reason: "timeout" },
    ]);
  });

  it("uses a custom timeout", async () => {
    vi.useFakeTimers();
    const safe = makeSafeMemoryHooks(
      { ...stubMemoryHooks, loadMemories: () => new Promise<never>(() => undefined) },
      { timeoutMs: 50 },
    );
    const loading = safe.loadMemories(loadInput);
    await vi.advanceTimersByTimeAsync(50);
    expect(await loading).toEqual([]);
  });

  it("never logs the question, answer or memory text", async () => {
    const { log, warn } = recordingLog();
    const fail = async (): Promise<never> => {
      throw new Error(`${QUESTION} ${ANSWER} ${memory.text}`);
    };
    const safe = makeSafeMemoryHooks({ loadMemories: fail, wrapUp: fail }, { log });
    await safe.loadMemories(loadInput);
    await safe.wrapUp(wrapInput);

    const logged = JSON.stringify(warn.mock.calls);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const secret of [QUESTION, ANSWER, memory.text]) expect(logged).not.toContain(secret);
  });
});

describe("makeMemoryHooks", () => {
  const kidclub = "kidclub" as ContextId;
  const DAY = 24 * 60 * 60 * 1000;

  const setup = (extract: Extract = extractNothing, limits?: Parameters<typeof makeMemoryHooks>[0]["limits"]) => {
    let t = new Date("2026-11-07T10:00:00Z").getTime();
    const clock = { now: () => new Date(t), advance: (ms: number) => (t += ms) };
    let n = 0;
    const store = makeMemoryStoreInMemory({ now: clock.now, newId: () => `m${(n += 1)}` });
    const { log, info } = (() => {
      const info = vi.fn<Logger["info"]>();
      return { log: { info, warn: vi.fn(), error: vi.fn() } satisfies Logger, info };
    })();
    const hooks = makeMemoryHooks({ store, extract, now: clock.now, log, ...(limits ? { limits } : {}) });
    return { store, hooks, clock, info };
  };
  const add = (store: MemoryStore, text: string, extra: Partial<NewMemory> = {}) =>
    store.add({ contextId: personal, kind: "fact", text, origin: "auto", source: "req-0", ...extra });

  it("loads only the question's context: best facts and playbooks, then recent history", async () => {
    const { store, hooks, clock } = setup(extractNothing, { factsAndPlaybooks: 2, history: 1 });
    const teacher = await add(store, "Inês's teacher is Ms Rita");
    const playbook = await add(store, "Answer in Portuguese", { kind: "playbook" });
    await add(store, "Takes espresso");
    await add(store, "KidClub opens at 08:00", { contextId: kidclub });
    await add(store, "Talked about the gym", { kind: "history", expiresAt: new Date(clock.now().getTime() + DAY) });
    clock.advance(1000);
    const party = await add(store, "Planning the party", { kind: "history", expiresAt: new Date(clock.now().getTime() + DAY) });

    const loaded = await hooks.loadMemories({ question: "Who is Inês's teacher?", contextId: personal });
    expect(loaded.map((m) => m.id)).toEqual([teacher.id, playbook.id, party.id]);
    expect((await store.get(teacher.id))?.lastUsedAt).toEqual(clock.now());
  });

  it("uses the default limits: about 20 facts and playbooks plus 3 history lines", async () => {
    expect(MEMORY_LIMITS).toEqual({ factsAndPlaybooks: 20, history: 3, historyDays: 30 });
    const { store, hooks, clock } = setup();
    for (let i = 0; i < 25; i += 1) await add(store, `fact ${i}`);
    for (let i = 0; i < 5; i += 1) await add(store, `talk ${i}`, { kind: "history", expiresAt: new Date(clock.now().getTime() + DAY) });
    const loaded = await hooks.loadMemories({ question: "anything", contextId: personal });
    expect(loaded.filter((m) => m.kind === "fact")).toHaveLength(20);
    expect(loaded.filter((m) => m.kind === "history")).toHaveLength(3);
  });

  it("passes the exchange and related memories to extract, and applies its decisions", async () => {
    const seen: ExtractInput[] = [];
    const extract: Extract = async (input) => {
      seen.push(input);
      return {
        decisions: [
          { action: "add", kind: "fact", text: "Sam's birthday is 3 May", origin: "explicit" },
          { action: "update", id: "m1", text: "Inês swims on Thursdays" },
          { action: "delete", id: "m2" },
        ],
      };
    };
    const ctx = setup(extract);
    const store = ctx.store;
    const swim = await add(store, "Inês swims on Tuesdays");
    const coffee = await add(store, "Takes espresso");
    const history = await add(store, "Old talk", { kind: "history" });

    await ctx.hooks.wrapUp({
      question: "Remember that Sam's birthday is 3 May. Also she swims on Thursdays now, and forget the coffee.",
      contextId: personal,
      answer: "Got it.",
      memoriesUsed: [swim, coffee, history],
      conversationId: "conv-1",
      requestId: "req-9",
    });

    // History lines are related too, so "forget that…" can delete them (#71).
    expect(seen[0]?.related.map((m) => m.id)).toEqual([swim.id, coffee.id, history.id]);
    expect(seen[0]?.now).toEqual(ctx.clock.now());
    expect((await store.get(swim.id))?.text).toBe("Inês swims on Thursdays");
    expect(await store.get(coffee.id)).toBeUndefined();
    const added = (await store.list({ kind: "fact" })).find((m) => m.text === "Sam's birthday is 3 May");
    expect(added).toMatchObject({ origin: "explicit", source: "req-9", conversationId: "conv-1", contextId: personal });
  });

  it("never changes another context's memories, whatever extract says", async () => {
    const ctx = setup(async () => ({
      decisions: [
        { action: "update", id: "m1", text: "hacked" },
        { action: "delete", id: "m1" },
      ],
    }));
    const other = await add(ctx.store, "KidClub opens at 08:00", { contextId: kidclub });
    await ctx.hooks.wrapUp({ question: "q", contextId: personal, answer: "a", memoriesUsed: [] });
    expect(await ctx.store.get(other.id)).toEqual(other);
    expect(ctx.info).toHaveBeenCalledWith("memory wrap-up", expect.objectContaining({ ignored: 2, updated: 0, deleted: 0 }));
  });

  it("keeps one history line per conversation, updated in place, expiring after 30 days", async () => {
    let line = "Asked about Inês's teacher";
    const lines: (string | undefined)[] = [];
    const ctx = setup(async (input) => {
      lines.push(input.historyLine);
      return { decisions: [], historyLine: line };
    });
    const wrap = () =>
      ctx.hooks.wrapUp({ question: "q", contextId: personal, answer: "a", memoriesUsed: [], conversationId: "conv-1" });

    await wrap();
    ctx.clock.advance(60_000);
    line = "Asked about Inês's teacher and her swimming";
    await wrap();

    const history = await ctx.store.list({ kind: "history" });
    expect(history).toHaveLength(1);
    expect(history[0]?.text).toBe(line);
    expect(history[0]?.expiresAt).toEqual(new Date(ctx.clock.now().getTime() + 30 * DAY));
    expect(lines).toEqual([undefined, "Asked about Inês's teacher"]);
  });

  it("stores a one-off's expiry, so it stops loading after the event", async () => {
    const ctx = setup(async () => ({
      decisions: [{ action: "add", kind: "fact", text: "Diniz has football on Sunday 8 November", origin: "explicit", expiresAt: new Date("2026-11-09T00:00:00Z") }],
    }));
    await ctx.hooks.wrapUp({ question: "Remember Diniz has football tomorrow", contextId: personal, answer: "Noted.", memoriesUsed: [] });
    const [kept] = await ctx.store.list();
    expect(kept?.expiresAt).toEqual(new Date("2026-11-09T00:00:00Z"));
    expect((await ctx.hooks.loadMemories({ question: "football?", contextId: personal })).map((m) => m.text)).toEqual([kept?.text]);
    ctx.clock.advance(2 * DAY); // now past the 9th
    expect(await ctx.hooks.loadMemories({ question: "football?", contextId: personal })).toEqual([]);
  });

  it("starts a fresh history line if this conversation's line was just forgotten", async () => {
    let line: string | undefined = "Talked about football";
    let decisions: ExtractResult["decisions"] = [];
    const ctx = setup(async () => ({ decisions, ...(line ? { historyLine: line } : {}) }));
    const wrap = () => ctx.hooks.wrapUp({ question: "q", contextId: personal, answer: "a", memoriesUsed: [], conversationId: "conv-1" });
    await wrap();
    const [first] = await ctx.store.list({ kind: "history" });
    decisions = [{ action: "delete", id: first?.id ?? "" }];
    line = "Talked about the weather";
    await wrap();
    const history = await ctx.store.list({ kind: "history" });
    expect(history.map((h) => h.text)).toEqual(["Talked about the weather"]);
    expect(history[0]?.id).not.toBe(first?.id);
  });

  it("keeps no history line without a conversation id", async () => {
    const ctx = setup(async () => ({ decisions: [], historyLine: "Something" }));
    await ctx.hooks.wrapUp({ question: "q", contextId: personal, answer: "a", memoriesUsed: [] });
    expect(await ctx.store.list({ kind: "history" })).toEqual([]);
  });

  it("logs counts only, never memory text, questions or answers", async () => {
    const ctx = setup(async () => ({
      decisions: [{ action: "add", kind: "fact", text: "Sam's birthday is 3 May", origin: "explicit" }],
      historyLine: "Talked about Sam",
    }));
    await ctx.hooks.wrapUp({ question: QUESTION, contextId: personal, answer: ANSWER, memoriesUsed: [], conversationId: "conv-1" });
    const logged = JSON.stringify(ctx.info.mock.calls);
    expect(logged).not.toContain("Sam");
    expect(logged).not.toContain(QUESTION);
    expect(logged).not.toContain(ANSWER);
    expect(ctx.info).toHaveBeenCalledWith("memory wrap-up", { contextId: "personal", added: 1, updated: 0, deleted: 0, ignored: 0, history: true });
  });

  it.each(["Não guardes isto, mas estou a pensar mudar de emprego", "Off the record: I'm thinking of quitting"])(
    "skips the whole exchange on an opt-out (%j): no extract call, no history line, nothing changed",
    async (question) => {
      const extract = vi.fn<Extract>(async () => ({
        decisions: [{ action: "add", kind: "fact", text: "Thinking of changing jobs", origin: "auto" }],
        historyLine: "Talked about changing jobs",
      }));
      const ctx = setup(extract);
      const before = await add(ctx.store, "Earlier talk", { kind: "history", conversationId: "conv-1" });
      await ctx.hooks.wrapUp({ question, contextId: personal, answer: "Fica entre nós.", memoriesUsed: [], conversationId: "conv-1" });
      expect(extract).not.toHaveBeenCalled();
      expect(await ctx.store.list()).toEqual([before]);
      expect(ctx.info).toHaveBeenCalledWith("memory wrap-up skipped", { contextId: "personal", reason: "opt_out" });
    },
  );

  it("keeps nothing with the placeholder extract", async () => {
    const ctx = setup();
    await ctx.hooks.wrapUp({ question: "q", contextId: personal, answer: "a", memoriesUsed: [], conversationId: "conv-1" });
    expect(await ctx.store.list()).toEqual([]);
  });
});
