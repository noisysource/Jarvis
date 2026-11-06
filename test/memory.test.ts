import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_TIMEOUT_MS, makeSafeMemoryHooks, stubMemoryHooks, withTimeout } from "../src/memory.js";
import type { ContextId, Logger, Memory, MemoryHooks } from "../src/types.js";

const personal = "personal" as ContextId;
const QUESTION = "When is my daughter's birthday?";
const ANSWER = "2 September.";
const memory: Memory = {
  id: "m1",
  contextId: personal,
  text: "Daughter is called Inês",
  createdAt: new Date("2026-11-06T12:00:00Z"),
  source: "q0",
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

  it("times out slow hooks after 2 seconds by default", async () => {
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
