// Where memories live. Everything else (the memory hooks, the wrap-up, the
// Memories panel) only uses `MemoryStore`, so the in-memory store here, SQLite
// (#60) and Firestore (#24) are interchangeable.
//
// A store is a plain object of async functions. Deletion is real: a deleted
// memory is gone, not hidden.

import { randomUUID } from "node:crypto";
import type { ContextId, Memory, MemoryKind, MemoryOrigin } from "./types.js";

export type NewMemory = {
  readonly contextId: ContextId;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly origin: MemoryOrigin;
  readonly source: string;
  readonly conversationId?: string;
  readonly expiresAt?: Date;
};

export type MemoryChanges = {
  readonly text?: string;
  readonly origin?: MemoryOrigin;
  readonly expiresAt?: Date;
  /** Makes it long-term: no expiry (#107). */
  readonly clearExpiry?: boolean;
};

export type MemoryFilter = {
  readonly contextId?: ContextId;
  readonly kind?: MemoryKind;
  readonly conversationId?: string;
};

export type MemoryStore = {
  /** Stores a new memory, unseen. */
  readonly add: (memory: NewMemory) => Promise<Memory>;
  /** Changes text, origin or expiry. An update counts as new again (unseen). Undefined if there's no such memory. */
  readonly update: (id: string, changes: MemoryChanges) => Promise<Memory | undefined>;
  readonly get: (id: string) => Promise<Memory | undefined>;
  /**
   * The context's memories of these kinds, best first: most question words
   * matched, then most recently used (or updated). Expired ones are left out.
   */
  readonly search: (query: {
    readonly contextId: ContextId;
    readonly text: string;
    readonly kinds: readonly MemoryKind[];
    readonly limit: number;
  }) => Promise<readonly Memory[]>;
  /** The context's latest history lines that haven't expired, newest first. */
  readonly recentHistory: (query: { readonly contextId: ContextId; readonly limit: number }) => Promise<readonly Memory[]>;
  /** Records that these memories were just used in an answer. */
  readonly touch: (ids: readonly string[]) => Promise<void>;
  /** Everything matching the filter (expired included, until purged), newest first. */
  readonly list: (filter?: MemoryFilter) => Promise<readonly Memory[]>;
  readonly markSeen: (ids: readonly string[]) => Promise<void>;
  /** True if something was deleted. */
  readonly delete: (id: string) => Promise<boolean>;
  /** Deletes all of a context's memories. Returns how many. */
  readonly wipe: (scope: { readonly contextId: ContextId }) => Promise<number>;
  /** Deletes expired memories. Returns how many. */
  readonly purgeExpired: () => Promise<number>;
};

// ---- word matching, shared by stores that don't have their own search ----

/** Short words that say nothing about what a memory is about, in English and Portuguese. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "what", "when", "where", "who", "how", "does", "did", "you", "your", "my", "me",
  "is", "it", "its", "of", "to", "in", "on", "at", "a", "an", "do", "i", "that", "this", "with", "about",
  "o", "a", "os", "as", "de", "do", "da", "dos", "das", "e", "que", "em", "no", "na", "um", "uma", "para",
  "por", "com", "meu", "minha", "qual", "quando", "onde", "como", "se", "eu",
]);

/** Lowercase words without accents, minus stop words. "Inês's teacher?" → ["ines", "teacher"]. */
export const memoryWords = (text: string): string[] =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    // "Inês's" splits into "ines" and "s"; plural "-s" is dropped so "swims" matches "swim".
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

/** How many distinct question words a memory contains. */
export const matchScore = (queryWords: readonly string[], text: string): number => {
  const words = new Set(memoryWords(text));
  return new Set(queryWords.filter((w) => words.has(w))).size;
};

const recency = (m: Memory): number => (m.lastUsedAt ?? m.updatedAt).getTime();

const isExpired = (m: Memory, now: Date): boolean => m.expiresAt !== undefined && m.expiresAt.getTime() <= now.getTime();

const newestFirst = (a: Memory, b: Memory): number => b.updatedAt.getTime() - a.updatedAt.getTime();

/** Ranks memories for a question: word matches first, then recency. Pure. */
export const rankMemories = (memories: readonly Memory[], question: string): Memory[] => {
  const query = memoryWords(question);
  return memories
    .map((m) => ({ m, score: matchScore(query, m.text) }))
    .sort((a, b) => b.score - a.score || recency(b.m) - recency(a.m))
    .map((x) => x.m);
};

const matches = (m: Memory, filter: MemoryFilter): boolean =>
  (filter.contextId === undefined || m.contextId === filter.contextId) &&
  (filter.kind === undefined || m.kind === filter.kind) &&
  (filter.conversationId === undefined || m.conversationId === filter.conversationId);

/**
 * A store kept in RAM: for tests, and the default until the SQLite store
 * (#60) lands. Everything is lost on restart.
 */
export const makeMemoryStoreInMemory = (
  options: { readonly now?: () => Date; readonly newId?: () => string } = {},
): MemoryStore => {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const memories = new Map<string, Memory>();

  const put = (m: Memory): Memory => {
    memories.set(m.id, m);
    return m;
  };
  const all = (): Memory[] => [...memories.values()];

  return {
    add: async (input) => {
      const at = now();
      return put({
        id: newId(),
        contextId: input.contextId,
        kind: input.kind,
        text: input.text,
        origin: input.origin,
        createdAt: at,
        updatedAt: at,
        source: input.source,
        seen: false,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      });
    },
    update: async (id, changes) => {
      const existing = memories.get(id);
      if (!existing) return undefined;
      const { clearExpiry, ...rest } = changes;
      const updated: Memory = { ...existing, ...rest, updatedAt: now(), seen: false };
      return put(clearExpiry === true ? (Object.fromEntries(Object.entries(updated).filter(([k]) => k !== "expiresAt")) as Memory) : updated);
    },
    get: async (id) => memories.get(id),
    search: async ({ contextId, text, kinds, limit }) => {
      const at = now();
      const candidates = all().filter((m) => m.contextId === contextId && kinds.includes(m.kind) && !isExpired(m, at));
      return rankMemories(candidates, text).slice(0, Math.max(0, limit));
    },
    recentHistory: async ({ contextId, limit }) => {
      const at = now();
      return all()
        .filter((m) => m.contextId === contextId && m.kind === "history" && !isExpired(m, at))
        .sort(newestFirst)
        .slice(0, Math.max(0, limit));
    },
    touch: async (ids) => {
      const at = now();
      for (const id of ids) {
        const m = memories.get(id);
        if (m) put({ ...m, lastUsedAt: at });
      }
    },
    list: async (filter = {}) => all().filter((m) => matches(m, filter)).sort(newestFirst),
    markSeen: async (ids) => {
      for (const id of ids) {
        const m = memories.get(id);
        if (m) put({ ...m, seen: true });
      }
    },
    delete: async (id) => memories.delete(id),
    wipe: async ({ contextId }) => {
      const doomed = all().filter((m) => m.contextId === contextId);
      for (const m of doomed) memories.delete(m.id);
      return doomed.length;
    },
    purgeExpired: async () => {
      const at = now();
      const doomed = all().filter((m) => isExpired(m, at));
      for (const m of doomed) memories.delete(m.id);
      return doomed.length;
    },
  };
};
