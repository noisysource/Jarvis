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
//   answer   → loadMemories → answer → wrapUp → answer response
//              (or an `unavailable` reply, e.g. "not connected yet": no wrapUp)
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

export const handleAsk = async (deps: Deps, request: AskRequest): Promise<AskResponse> => {
  const history = request.history ?? [];
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

    const memories = await deps.memory.loadMemories({ question: request.question, contextId: context.id });
    const answer = await deps.answer({ context, question: request.question, history, memories, now: deps.now() });

    if (!answer.ok) {
      deps.log.warn("ask", { context: context.id, outcome: "error", code: answer.error.code });
      return { type: "error", message: answer.error.message };
    }

    if (answer.value.kind === "unavailable") {
      // A normal reply, but nothing was answered, so there's nothing to wrap up.
      deps.log.info("ask", { context: context.id, outcome: "unavailable" });
      return { type: "unavailable", context: context.id, message: answer.value.message };
    }

    // Awaited so it finishes before the response (Cloud Run may throttle CPU afterwards).
    await deps.memory.wrapUp({
      question: request.question,
      contextId: context.id,
      answer: answer.value.text,
      memoriesUsed: memories,
    });

    deps.log.info("ask", { context: context.id, outcome: "answer" });
    return { type: "answer", context: context.id, answer: answer.value.text };
  } catch (e) {
    // Only the error class is logged; messages could quote the question.
    deps.log.error("ask failed", { errorName: e instanceof Error ? e.name : typeof e });
    return { type: "error", message: GENERIC_ERROR };
  }
};
