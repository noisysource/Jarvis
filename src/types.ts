// Core types for the ask flow. Types only: no runtime code lives here.
//
// Contexts are not hard-coded: they're read from contexts.md (#22), so a
// context id is a branded string that only the contexts parser should create.

import type { Result } from "./result.js";

declare const contextIdBrand: unique symbol;

/** Id of a context from contexts.md, e.g. "personal". Created by the parser. */
export type ContextId = string & { readonly [contextIdBrand]: true };

/** Tools a context may use. Adding a tool needs code, so this is a closed set. */
export type ToolName = "vendus";

/**
 * An exception to a handoff: when one of these words appears together with a
 * handoff cue, the question goes to `routeTo` instead. Example: "Invoice the
 * Commission" goes to noisysource, not to Kiro.
 */
export type UnlessRule = {
  readonly words: readonly string[];
  readonly routeTo: ContextId;
};

/**
 * How Jarvis handles a context:
 * - answer: Jarvis answers it (possibly with tools and memory).
 * - handoff: Jarvis recognises it, says which agent handles it, and stops:
 *   no answer-model call, no tools, no memory. `cues` are matched locally,
 *   before any model runs.
 */
export type ContextHandling =
  | { readonly kind: "answer" }
  | {
      readonly kind: "handoff";
      readonly to: string;
      readonly cues: readonly string[];
      readonly unless: readonly UnlessRule[];
    };

export type Context = {
  readonly id: ContextId;
  readonly name: string;
  readonly description: string;
  /** Where this context's data lives, in plain words (for people and prompts). */
  readonly data: string;
  readonly tools: readonly ToolName[];
  readonly handling: ContextHandling;
  /** Other names people use for it (e.g. "pessoal"), for picking it after a clarify. */
  readonly aliases?: readonly string[];
};

/** One earlier message in the conversation. The page keeps these; the server stores nothing. */
export type Turn = {
  readonly role: "user" | "assistant";
  readonly text: string;
};

export type AskRequest = {
  readonly question: string;
  /** Set when the user picked a context after a clarify response. Skips classification. */
  readonly context?: ContextId;
  readonly history?: readonly Turn[];
  /** The page's id for this conversation (a new one after "New conversation"). Groups the history memory. */
  readonly conversationId?: string;
  /** false: "don't remember this". The answer still uses memories, but nothing is learned. */
  readonly remember?: boolean;
};

export type Classification =
  | { readonly kind: "context"; readonly contextId: ContextId }
  | { readonly kind: "unclear" };

/**
 * Result of the local precheck (no model): a handoff cue was found, a cue plus
 * an `Unless` word routes elsewhere, or nothing matched.
 */
export type Precheck =
  | { readonly kind: "handoff"; readonly context: Context }
  | { readonly kind: "route"; readonly contextId: ContextId }
  | { readonly kind: "none" };

export type ContextOption = {
  readonly id: ContextId;
  readonly name: string;
  /** Sent so the page can match a typed or spoken pick ("pessoal") without a model call. */
  readonly aliases?: readonly string[];
};

export type AskResponse =
  | { readonly type: "answer"; readonly context: ContextId; readonly answer: string }
  | {
      readonly type: "clarify";
      readonly message: string;
      readonly options: readonly ContextOption[];
    }
  | {
      readonly type: "handoff";
      readonly context: ContextId;
      /** The agent that handles this context, e.g. "Kiro (the EC's agent)". */
      readonly to: string;
      readonly message: string;
    }
  /** The context exists but its data isn't connected yet (e.g. KidClub in M0). A normal reply, not a failure. */
  | { readonly type: "unavailable"; readonly context: ContextId; readonly message: string }
  | { readonly type: "error"; readonly message: string };

/**
 * What a memory is:
 * - fact: something lasting the user said or corrected, preferences included
 *   ("Inês's teacher is Ms Rita").
 * - playbook: how they want a recurring thing done ("unpaid invoices oldest
 *   first"). Shapes answers; never permission to act.
 * - history: a one-line summary of a conversation. Expires after 30 days.
 */
export type MemoryKind = "fact" | "playbook" | "history";

/** auto: kept by the wrap-up on its own. explicit: the user said "remember that…". */
export type MemoryOrigin = "auto" | "explicit";

export type Memory = {
  readonly id: string;
  /** Memories belong to one context and are only ever loaded for it. */
  readonly contextId: ContextId;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly origin: MemoryOrigin;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Last time it was loaded into an answer. */
  readonly lastUsedAt?: Date;
  /** History only: after this it's no longer loaded, and it's purged. */
  readonly expiresAt?: Date;
  /** The page's conversation it came from, if any. */
  readonly conversationId?: string;
  /** Where the memory came from: the id of the request that produced it. */
  readonly source: string;
  /** Whether the user has seen it in the Memories panel (for the "new" badge). */
  readonly seen: boolean;
};

export type MemoryHooks = {
  readonly loadMemories: (input: {
    readonly question: string;
    readonly contextId: ContextId;
  }) => Promise<readonly Memory[]>;
  readonly wrapUp: (input: {
    readonly question: string;
    readonly contextId: ContextId;
    readonly answer: string;
    readonly memoriesUsed: readonly Memory[];
    readonly conversationId?: string;
    readonly requestId?: string;
  }) => Promise<void>;
};

export type AppErrorCode =
  | "invalid_input"
  | "llm_failed"
  | "llm_refused"
  | "timeout"
  | "config"
  /** The request was cancelled (the user interrupted a spoken answer). */
  | "cancelled";

/** An expected failure. `message` must be safe to show the user: no secrets, no profile text. */
export type AppError = {
  readonly code: AppErrorCode;
  readonly message: string;
};

/** What an answerer produces: an answer, or a reply that the context can't be answered yet. */
export type AnswerOutcome =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type AnswerInput = {
  readonly context: Context;
  readonly question: string;
  readonly history: readonly Turn[];
  readonly memories: readonly Memory[];
  readonly now: Date;
  /** Streaming (#72): called with each piece of the answer's text as it arrives. */
  readonly onText?: (delta: string) => void;
  /** Cancels the answer (e.g. the user interrupted it). */
  readonly signal?: AbortSignal;
};

/**
 * A spoken language. English only in the Voice proof of concept; pt-PT is
 * added later without changing any interface.
 */
export type Language = "en";

export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = {
  readonly info: (message: string, fields?: LogFields) => void;
  readonly warn: (message: string, fields?: LogFields) => void;
  readonly error: (message: string, fields?: LogFields) => void;
};

/**
 * Everything the ask handler (#14) needs, as plain functions, so it can be
 * tested with stubs. Lower layers (LLM provider, profile, Vendus) have their
 * own deps and are wired into these functions at startup.
 */
/** Runs a task after the reply has gone out (#56). Failures are logged, never returned. */
export type AfterReply = (name: string, task: () => Promise<void>) => void;

export type Deps = {
  readonly contexts: readonly Context[];
  /**
   * Local handoff check from contexts.md. Runs on every question, before a
   * supplied context or the classifier is considered.
   */
  readonly precheck: (question: string) => Precheck;
  /** Never throws: failures and unparseable output become `unclear`. */
  readonly classify: (input: {
    readonly question: string;
    readonly history: readonly Turn[];
  }) => Promise<Classification>;
  /** Errors are for things that actually failed; "not connected yet" is an `unavailable` outcome. */
  readonly answer: (input: AnswerInput) => Promise<Result<AnswerOutcome, AppError>>;
  readonly memory: MemoryHooks;
  /** Whether a context has an answerer. The rest reply "not connected yet", with no memory load and no wrap-up. */
  readonly isAnswered: (contextId: ContextId) => boolean;
  /** Where the wrap-up goes, so it never delays the reply. */
  readonly afterReply: AfterReply;
  readonly now: () => Date;
  readonly log: Logger;
};
