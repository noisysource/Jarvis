// Core types for the ask flow. Types only: no runtime code lives here.
//
// Contexts are not hard-coded: they're read from contexts.md (#22), so a
// context id is a branded string that only the contexts parser should create.

import type { Studies } from "./code/study.js";
import type { ReachNode } from "./reach.js";
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
  /**
   * The tool calls that really ran for this answer (#104), from the page's
   * path line, e.g. "calendar_read Wed 11 Nov → 1 event": dates and counts,
   * never titles. The brain is told about them, so it knows what it did.
   */
  readonly tools?: readonly string[];
};

/** Which model answers (#88): only these two, from config; the page never names a model. */
export type Brain = "claude" | "local";

export type AskRequest = {
  readonly question: string;
  /** Set when the user picked a context after a clarify response. Skips classification. */
  readonly context?: ContextId;
  readonly history?: readonly Turn[];
  /** The page's id for this conversation (a new one after "New conversation"). Groups the history memory. */
  readonly conversationId?: string;
  /** false: "don't remember this". The answer still uses memories, but nothing is learned. */
  readonly remember?: boolean;
  /** A spoken turn (#76): the answer is tuned for speed (see VOICE_THINKING). */
  readonly spoken?: boolean;
  /** The context this spoken conversation was last answered in; used only with STICKY_CONTEXT=on (#76). */
  readonly stickyContext?: ContextId;
  /** Which brain answers (#88); Claude when not given. */
  readonly brain?: Brain;
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

/**
 * One step on the way to an answer (#102), in order, for the page's "path"
 * line under each reply. It carries fixed words, dates and counts as
 * checked by code: never a question, an answer or an event's title. It
 * goes to the page only; the server log keeps its own numbers-only lines.
 */
export type PathStep =
  /** The local EC precheck: "handoff" went to Kiro with no model. */
  | { readonly kind: "precheck"; readonly result: "none" | "handoff" | "route" }
  | { readonly kind: "brain"; readonly brain: Brain }
  /** The tools the brain was offered this turn (#141), so a missing tool call can be told from a missing tool. */
  | { readonly kind: "tools"; readonly offered: readonly string[] }
  /** A tool call (something done or fetched), or a skill (a way of working), when those exist. */
  | {
      readonly kind: "tool" | "skill";
      readonly name: string;
      /** The arguments as checked by code, e.g. "Wed 11 Nov". Empty when it never got that far. */
      readonly args: string;
      /** Who chose the arguments: code (a date phrase) or the model's structured request. */
      readonly by: "code" | "model";
      readonly ok: boolean;
      /** When it worked, e.g. "2 events". */
      readonly result?: string;
      /** When it failed: a fixed code, e.g. "not_connected". */
      readonly error?: string;
      /**
       * An action waiting for Renato's OK (Reach 2): the page shows `label` on a
       * card with "Add it" / "Don't add", and POSTs `id` to /calendar/confirm.
       * Page only: the path is never logged.
       */
      readonly confirm?: { readonly id: string; readonly label: string; readonly kind?: "calendar" | "skill" | "email" | "draft-delete" };
    }
  | {
      readonly kind: "guard";
      readonly claimedAction: number;
      readonly promise: number;
      readonly perception: number;
      /** Claims about a tool's results (what's on the calendar) with no successful read this turn. */
      readonly toolResult: number;
      readonly replaced: boolean;
    };

export type { IntrospectionReport } from "./introspection.js";
import type { IntrospectionReport } from "./introspection.js";
import type { SkillStore } from "./skills.js";

export type CalendarConfirmResult = {
  readonly ok: boolean;
  /** What Jarvis says, worded by code. */
  readonly text: string;
  /** For the page's history record (#104), when something was added: "calendar_create Wed 11 Nov 21:00–22:00 → added". */
  readonly tool?: string;
};

export type AskResponse =
  | { readonly type: "answer"; readonly context: ContextId; readonly answer: string; readonly brain?: Brain; readonly path?: readonly PathStep[] }
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
      readonly path?: readonly PathStep[];
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
  /** A spoken turn (#76): answered for speed. */
  readonly spoken?: boolean;
  /** Which brain answers (#88). */
  readonly brain?: Brain;
  /** false: the page's Remembering is off, so nothing new is saved this turn (#107). */
  readonly remember?: boolean;
  /** A tool ran and succeeded this turn (#96): the honesty guard then lets its claims through. Called by a tool loop. */
  readonly onToolSucceeded?: () => void;
  /** Reports a tool or skill step for the answer's path (#102). */
  readonly onStep?: (step: PathStep) => void;
  /** A tool call is starting (#130): its name, one of the tools offered this turn. For the page's brain view. */
  readonly onReach?: (tool: string) => void;
  /** The tools offered to the brain this turn (#141), once, before it answers. */
  readonly onOffered?: (tools: readonly string[]) => void;
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
  /** CALENDAR=on (#100): the calendar can be read; the honesty guard then offers to check instead of "can't". */
  readonly calendarEnabled?: boolean;
  /**
   * Claude reads the calendar itself, with native tools (#104). Its answers
   * about the calendar then rest on the record of what really ran, so the
   * honesty guard's calendar-claims check (built for the local brain, which
   * invented calendar contents) is off for Claude. The rest of the guard stays.
   */
  readonly nativeTools?: boolean;
  /**
   * Reach 2: Renato's answer to a proposed event (POST /calendar/confirm).
   * "yes" creates it through Google and returns a sentence built from
   * Google's answer; "no" drops it. Unknown or expired ids create nothing.
   */
  readonly calendarConfirm?: (id: string, decision: "yes" | "no") => Promise<CalendarConfirmResult>;
  /** #120: his answer to an email draft (POST /gmail/send). "yes" sends it; "no" keeps it as a draft. */
  readonly gmailSend?: (id: string, decision: "yes" | "no") => Promise<CalendarConfirmResult>;
  /** #156: studies under way and finished, for the page (GET /code/studies), and stopping them (POST /code/studies/stop). Names, counts and file paths only. */
  readonly codeStudies?: Pick<Studies, "active" | "finished" | "stop">;
  /** #124: his answer to deleting a draft Jarvis wrote (POST /gmail/delete). Only "yes" deletes. */
  readonly gmailDelete?: (id: string, decision: "yes" | "no") => Promise<CalendarConfirmResult>;
  /** #116: skills, with MEMORY=on: drafts and approved routines. */
  readonly skills?: SkillStore;
  /** #133: what each brain-view node can do and what's connected (GET /reach). Names and counts only. */
  readonly reach?: () => Promise<readonly ReachNode[]>;
  /** #108: reviews short-term memory (drop, promote, merge; skill and tool drafts). With MEMORY=on. */
  readonly introspect?: () => Promise<IntrospectionReport>;
  /** STICKY_CONTEXT=on (#76): spoken follow-ups skip the classifier and stay in the last answered context. */
  readonly stickyContext?: boolean;
  /** SPECULATIVE_ANSWER=on (#76): start the personal answer while the classifier runs; discard it if it disagrees. */
  readonly speculativeAnswer?: boolean;
  /**
   * BARE_MODE=on (#88): every turn gets only the local EC precheck, then this
   * answerer (history and a short persona). No classifier, contexts, profile
   * or memory.
   */
  readonly bare?: Deps["answer"];
};
