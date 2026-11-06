// Memory hooks: load memories before answering, and a wrap-up step after.
//
// In M0 both are stubs. #24 fills them in with Firestore. Whatever the
// implementation, `makeSafeMemoryHooks` makes sure a failing or slow hook
// never fails a question: load falls back to no memories, wrap-up is
// skipped, and each has a timeout.

import type { Logger, Memory, MemoryHooks } from "./types.js";

export const DEFAULT_MEMORY_TIMEOUT_MS = 2_000;

/** M0: no memories yet, nothing to learn. */
export const stubMemoryHooks: MemoryHooks = {
  loadMemories: async () => [],
  wrapUp: async () => undefined,
};

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "timeout" | "error"; readonly errorName?: string };

/** Runs `task` with a deadline. Never throws or rejects. The task itself keeps running in the background if it overruns. */
export const withTimeout = async <T>(task: () => Promise<T>, timeoutMs: number): Promise<Outcome<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
  });
  const run = (async (): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await task() };
    } catch (e) {
      return { ok: false, reason: "error", errorName: e instanceof Error ? e.name : typeof e };
    }
  })();
  try {
    return await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Wraps memory hooks so they can't break a request. Failures are logged with
 * the hook name and reason only: never the question, answer or memory text.
 */
export const makeSafeMemoryHooks = (
  hooks: MemoryHooks,
  options: { readonly timeoutMs?: number; readonly log?: Logger } = {},
): MemoryHooks => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEMORY_TIMEOUT_MS;
  const report = (hook: string, outcome: Outcome<unknown>): void => {
    if (!outcome.ok) {
      options.log?.warn("memory hook failed, continuing without it", {
        hook,
        reason: outcome.reason,
        ...(outcome.errorName ? { errorName: outcome.errorName } : {}),
      });
    }
  };

  return {
    loadMemories: async (input) => {
      const outcome = await withTimeout(() => hooks.loadMemories(input), timeoutMs);
      report("loadMemories", outcome);
      return outcome.ok ? outcome.value : ([] as readonly Memory[]);
    },
    wrapUp: async (input) => {
      report("wrapUp", await withTimeout(() => hooks.wrapUp(input), timeoutMs));
    },
  };
};
