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
 * How Jarvis handles a context:
 * - answer: Jarvis answers it (possibly with tools and memory).
 * - handoff: Jarvis recognises it, says which agent handles it, and stops:
 *   no answer-model call, no tools, no memory.
 */
export type ContextHandling =
  | { readonly kind: "answer" }
  | { readonly kind: "handoff"; readonly to: string };

export type Context = {
  readonly id: ContextId;
  readonly name: string;
  readonly description: string;
  /** Where this context's data lives, in plain words (for people and prompts). */
  readonly data: string;
  readonly tools: readonly ToolName[];
  readonly handling: ContextHandling;
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
};

export type Classification =
  | { readonly kind: "context"; readonly contextId: ContextId }
  | { readonly kind: "unclear" };

export type ContextOption = {
  readonly id: ContextId;
  readonly name: string;
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
  | { readonly type: "error"; readonly message: string };

export type Memory = {
  readonly id: string;
  readonly contextId: ContextId;
  readonly text: string;
  readonly createdAt: Date;
  /** Where the memory came from, e.g. the id of the question that produced it. */
  readonly source: string;
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
  }) => Promise<void>;
};

export type AppErrorCode =
  | "invalid_input"
  | "llm_failed"
  | "llm_refused"
  | "timeout"
  | "not_connected"
  | "config";

/** An expected failure. `message` must be safe to show the user: no secrets, no profile text. */
export type AppError = {
  readonly code: AppErrorCode;
  readonly message: string;
};

export type AnswerInput = {
  readonly context: Context;
  readonly question: string;
  readonly history: readonly Turn[];
  readonly memories: readonly Memory[];
  readonly now: Date;
};

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
export type Deps = {
  readonly contexts: readonly Context[];
  /** Never throws: failures and unparseable output become `unclear`. */
  readonly classify: (input: {
    readonly question: string;
    readonly history: readonly Turn[];
  }) => Promise<Classification>;
  readonly answer: (input: AnswerInput) => Promise<Result<string, AppError>>;
  readonly memory: MemoryHooks;
  readonly now: () => Date;
  readonly log: Logger;
};
