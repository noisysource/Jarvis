// The single entry point for a question.
//
//   precheck(question)  ← always, even when a context is supplied (no model)
//     EC/HRT cue            → handoff, whatever context was picked
//     EC cue + invoicing    → noisysource, whatever context was picked
//     no match ↓
//   context given? ─yes─────────────┐
//         no → classify(question, history)
//                                    ▼
//   unclear  → clarify: which context? (answerable contexts only)
//   handoff  → fixed handoff message; nothing else runs
//   answer   → loadMemories → answer → answer response, then wrapUp after the
//              reply has gone out (unless remember: false)
//              (a context with no answerer: "not connected yet", with no
//              memory load and no wrapUp)
//
// Logs carry the context id and outcome only, never the question or answer.

import { clarifyOptions, handoffMessage } from "./contexts.js";
import type { AskRequest, AskResponse, Context, ContextOption, Deps, Turn } from "./types.js";

export const clarifyMessage = (options: readonly ContextOption[]): string => {
  const names = options.map((o) => o.name);
  const list =
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1] ?? ""}`;
  return `I'm not sure which this is about. Is it ${list}?`;
};

const GENERIC_ERROR = "Sorry, something went wrong. Please try again.";

const resolveContext = async (
  deps: Deps,
  request: AskRequest,
  history: readonly Turn[],
): Promise<{ kind: "context"; context: Context } | { kind: "unclear" } | { kind: "unknown" }> => {
  // The local precheck wins over a picked context, so EC/HRT requests always reach Kiro.
  const local = deps.precheck(request.question);
  if (local.kind === "handoff") return { kind: "context", context: local.context };
  if (local.kind === "route") {
    const routed = deps.contexts.find((c) => c.id === local.contextId);
    return routed ? { kind: "context", context: routed } : { kind: "unclear" };
  }

  if (request.context !== undefined) {
    const chosen = deps.contexts.find((c) => c.id === request.context);
    return chosen ? { kind: "context", context: chosen } : { kind: "unknown" };
  }
  const classification = await deps.classify({ question: request.question, history });
  if (classification.kind === "unclear") return { kind: "unclear" };
  const context = deps.contexts.find((c) => c.id === classification.contextId);
  return context ? { kind: "context", context } : { kind: "unclear" };
};

/** A streamed (spoken) turn's wrap-up, handed to the caller to run once playback is known (see turns.ts). */
export type DeferredWrapUp = {
  readonly question: string;
  readonly completed: boolean;
  readonly answer: string;
  readonly run: (answerText: string) => void;
};

export type AskMeta = {
  readonly requestId?: string;
  /** Streaming (#72): each piece of the answer's text as it arrives. */
  readonly onText?: (delta: string) => void;
  /** Cancels the answer (the client went away, e.g. on barge-in). */
  readonly signal?: AbortSignal;
  /**
   * Streaming only: instead of wrapping up straight after the answer, hand
   * the wrap-up over, to run once it's known what was actually spoken.
   */
  readonly deferWrapUp?: (turn: DeferredWrapUp) => void;
};

/**
 * Bare conversation mode (#88, BARE_MODE=on): the local EC precheck (EC/HRT
 * still goes to Kiro, with no model), then the selected brain with only the
 * history and a short persona. No classifier, no contexts, no profile, no
 * memory reads or writes: with the Local brain, nothing reaches Claude.
 */
const handleBare = async (deps: Deps, bare: Deps["answer"], request: AskRequest, meta: AskMeta): Promise<AskResponse> => {
  const local = deps.precheck(request.question);
  if (local.kind === "handoff") {
    deps.log.info("ask", { context: local.context.id, outcome: "handoff", bare: true });
    return {
      type: "handoff",
      context: local.context.id,
      to: local.context.handling.kind === "handoff" ? local.context.handling.to : "",
      message: handoffMessage(local.context),
    };
  }
  const personal = deps.contexts.find((c) => c.id === "personal");
  if (!personal) return { type: "error", message: GENERIC_ERROR };
  const answer = await bare({
    context: personal,
    question: request.question,
    history: request.history ?? [],
    memories: [],
    now: deps.now(),
    ...(meta.onText ? { onText: meta.onText } : {}),
    ...(meta.signal ? { signal: meta.signal } : {}),
    ...(request.brain ? { brain: request.brain } : {}),
  });
  if (!answer.ok) {
    deps.log.info("ask", { outcome: answer.error.code === "cancelled" ? "cancelled" : "error", bare: true, brain: request.brain ?? "claude" });
    return { type: "error", message: answer.error.message };
  }
  if (answer.value.kind !== "answer") return { type: "unavailable", context: personal.id, message: answer.value.message };
  deps.log.info("ask", { outcome: "answer", bare: true, brain: request.brain ?? "claude" });
  return { type: "answer", context: personal.id, answer: answer.value.text, ...(request.brain ? { brain: request.brain } : {}) };
};

export const handleAsk = async (deps: Deps, request: AskRequest, meta: AskMeta = {}): Promise<AskResponse> => {
  const history = request.history ?? [];
  if (deps.bare) {
    try {
      return await handleBare(deps, deps.bare, request, meta);
    } catch (e) {
      deps.log.error("ask failed", { errorName: e instanceof Error ? e.name : typeof e });
      return { type: "error", message: GENERIC_ERROR };
    }
  }
  try {
    const resolved = await resolveContext(deps, request, history);

    if (resolved.kind === "unknown") {
      deps.log.warn("ask", { outcome: "unknown_context" });
      return { type: "error", message: "That isn't one of my contexts. Please pick one of the options." };
    }

    if (resolved.kind === "unclear") {
      const options = clarifyOptions(deps.contexts);
      deps.log.info("ask", { outcome: "clarify" });
      return { type: "clarify", message: clarifyMessage(options), options };
    }

    const { context } = resolved;

    if (context.handling.kind === "handoff") {
      // Nothing else runs: no answerer, no memory, and the question isn't logged.
      deps.log.info("ask", { context: context.id, outcome: "handoff" });
      return { type: "handoff", context: context.id, to: context.handling.to, message: handoffMessage(context) };
    }

    // No answerer, no memory: "not connected yet" needs nothing loaded.
    const memories =
      deps.isAnswered(context.id) ? await deps.memory.loadMemories({ question: request.question, contextId: context.id }) : [];
    const answer = await deps.answer({
      context,
      question: request.question,
      history,
      memories,
      now: deps.now(),
      ...(meta.onText ? { onText: meta.onText } : {}),
      ...(meta.signal ? { signal: meta.signal } : {}),
      ...(request.brain ? { brain: request.brain } : {}),
    });

    /** The wrap-up, with the given text as the answer. Runs after the reply, in the background. */
    const runWrapUp = (answerText: string): void =>
      deps.afterReply("memory wrap-up", () =>
        deps.memory.wrapUp({
          question: request.question,
          contextId: context.id,
          answer: answerText,
          memoriesUsed: memories,
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          ...(meta.requestId ? { requestId: meta.requestId } : {}),
        }),
      );

    if (!answer.ok && answer.error.code === "cancelled") {
      // Interrupted while streaming: whether anything is learned depends on
      // what was spoken, which only the page knows (turns.ts).
      deps.log.info("ask", { context: context.id, outcome: "cancelled" });
      if (request.remember !== false) {
        meta.deferWrapUp?.({ question: request.question, completed: false, answer: "", run: runWrapUp });
      }
      return { type: "error", message: answer.error.message };
    }

    if (!answer.ok) {
      deps.log.warn("ask", { context: context.id, outcome: "error", code: answer.error.code });
      return { type: "error", message: answer.error.message };
    }

    if (answer.value.kind === "unavailable") {
      // A normal reply, but nothing was answered, so there's nothing to wrap up.
      deps.log.info("ask", { context: context.id, outcome: "unavailable" });
      return { type: "unavailable", context: context.id, message: answer.value.message };
    }

    // The wrap-up runs after the reply has gone out, so memory never slows
    // an answer. "Don't remember this": the answer used memories, but
    // nothing is learned. A streamed answer's wrap-up waits for the page to
    // say how playback ended.
    if (request.remember !== false) {
      if (meta.deferWrapUp) {
        meta.deferWrapUp({ question: request.question, completed: true, answer: answer.value.text, run: runWrapUp });
      } else {
        runWrapUp(answer.value.text);
      }
    }

    deps.log.info("ask", { context: context.id, outcome: "answer", brain: request.brain ?? "claude" });
    return { type: "answer", context: context.id, answer: answer.value.text, ...(request.brain ? { brain: request.brain } : {}) };
  } catch (e) {
    // Only the error class is logged; messages could quote the question.
    deps.log.error("ask failed", { errorName: e instanceof Error ? e.name : typeof e });
    return { type: "error", message: GENERIC_ERROR };
  }
};
