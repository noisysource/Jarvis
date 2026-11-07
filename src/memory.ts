// Memory hooks: load memories before answering, and a wrap-up step after.
//
// `makeMemoryHooks` builds both on a `MemoryStore` (#59): loading picks the
// context's most relevant facts and playbooks plus its latest history lines;
// the wrap-up hands the exchange to an `extract` step (#61) and applies what
// it decides. Whatever the implementation, `makeSafeMemoryHooks` makes sure a
// failing or slow hook never fails a question: load falls back to no
// memories, wrap-up is skipped, and each has a timeout.

import type { MemoryStore } from "./memory-store.js";
import type { ContextId, Logger, Memory, MemoryHooks, MemoryOrigin } from "./types.js";

export const DEFAULT_MEMORY_TIMEOUT_MS = 2_000;

export type MemoryLimits = {
  readonly factsAndPlaybooks: number;
  readonly history: number;
  readonly historyDays: number;
};

export const MEMORY_LIMITS: MemoryLimits = {
  /** Facts and playbooks loaded per answer. */
  factsAndPlaybooks: 20,
  /** History lines loaded per answer. */
  history: 3,
  /** How long a conversation's history line lives. */
  historyDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** One thing the extract step decided. Updates and deletes only ever touch memories of the same context. */
export type MemoryDecision =
  | { readonly action: "add"; readonly kind: "fact" | "playbook"; readonly text: string; readonly origin: MemoryOrigin }
  | { readonly action: "update"; readonly id: string; readonly text: string; readonly origin?: MemoryOrigin }
  | { readonly action: "delete"; readonly id: string };

export type ExtractInput = {
  readonly question: string;
  readonly answer: string;
  readonly contextId: ContextId;
  /** The facts and playbooks used for this answer, so the extract step can update instead of duplicating. */
  readonly related: readonly Memory[];
  /** This conversation's history line so far, if there is one. */
  readonly historyLine?: string;
  readonly now: Date;
};

export type ExtractResult = {
  readonly decisions: readonly MemoryDecision[];
  /** The conversation's one-line summary, replacing the previous one. */
  readonly historyLine?: string;
};

/** Decides what's worth keeping. The model-backed one, with the memory rules, is #61. */
export type Extract = (input: ExtractInput) => Promise<ExtractResult>;

/** Until #61: keeps nothing. */
export const extractNothing: Extract = async () => ({ decisions: [] });

/**
 * Loading and wrap-up on top of a store. Memory text is never logged: only
 * counts and actions.
 */
export const makeMemoryHooks = (deps: {
  readonly store: MemoryStore;
  readonly extract: Extract;
  readonly now: () => Date;
  readonly log?: Logger;
  readonly limits?: Partial<MemoryLimits>;
}): MemoryHooks => {
  const limits = { ...MEMORY_LIMITS, ...deps.limits };

  return {
    loadMemories: async ({ question, contextId }) => {
      const [factsAndPlaybooks, history] = await Promise.all([
        deps.store.search({ contextId, text: question, kinds: ["fact", "playbook"], limit: limits.factsAndPlaybooks }),
        deps.store.recentHistory({ contextId, limit: limits.history }),
      ]);
      const memories = [...factsAndPlaybooks, ...history];
      if (memories.length > 0) await deps.store.touch(memories.map((m) => m.id));
      return memories;
    },

    wrapUp: async ({ question, contextId, answer, memoriesUsed, conversationId, requestId }) => {
      const now = deps.now();
      const existingHistory = conversationId
        ? (await deps.store.list({ contextId, kind: "history", conversationId }))[0]
        : undefined;
      const result = await deps.extract({
        question,
        answer,
        contextId,
        related: memoriesUsed.filter((m) => m.kind !== "history"),
        ...(existingHistory ? { historyLine: existingHistory.text } : {}),
        now,
      });

      const source = requestId ?? "unknown";
      const counts = { added: 0, updated: 0, deleted: 0, ignored: 0 };
      /** Only memories of this context can be changed, whatever the extract step says. */
      const ownMemory = async (id: string): Promise<boolean> => (await deps.store.get(id))?.contextId === contextId;

      for (const decision of result.decisions) {
        if (decision.action === "add") {
          await deps.store.add({
            contextId,
            kind: decision.kind,
            text: decision.text,
            origin: decision.origin,
            source,
            ...(conversationId ? { conversationId } : {}),
          });
          counts.added += 1;
        } else if (!(await ownMemory(decision.id))) {
          counts.ignored += 1;
        } else if (decision.action === "update") {
          await deps.store.update(decision.id, {
            text: decision.text,
            ...(decision.origin ? { origin: decision.origin } : {}),
          });
          counts.updated += 1;
        } else {
          await deps.store.delete(decision.id);
          counts.deleted += 1;
        }
      }

      // One history line per conversation, updated in place. Without a
      // conversation id there's nothing to group it by, so none is kept.
      const line = result.historyLine?.trim();
      if (conversationId && line) {
        const expiresAt = new Date(now.getTime() + limits.historyDays * DAY_MS);
        if (existingHistory) {
          await deps.store.update(existingHistory.id, { text: line, expiresAt });
        } else {
          await deps.store.add({ contextId, kind: "history", text: line, origin: "auto", source, conversationId, expiresAt });
        }
      }

      deps.log?.info("memory wrap-up", { contextId, ...counts, history: Boolean(conversationId && line) });
    },
  };
};

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
