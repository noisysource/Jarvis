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

import { makeHonestyGuard } from "./answer/honesty.js";
import { calendarIntent, cameFromRead } from "./calendar/intent.js";
import { resolveDatePhrase } from "./calendar/dates.js";
import { clarifyOptions, handoffMessage } from "./contexts.js";
import type { AskRequest, AskResponse, Context, ContextOption, Deps, PathStep, Turn } from "./types.js";

export const clarifyMessage = (options: readonly ContextOption[]): string => {
  const names = options.map((o) => o.name);
  const list =
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1] ?? ""}`;
  return `I'm not sure which this is about. Is it ${list}?`;
};

const GENERIC_ERROR = "Sorry, something went wrong. Please try again.";

/** How the context was decided, for latency timings (#76). */
export type RouteHow = "precheck" | "picked" | "sticky" | "classifier";

const resolveContext = async (
  deps: Deps,
  request: AskRequest,
  history: readonly Turn[],
): Promise<{ how: RouteHow } & ({ kind: "context"; context: Context } | { kind: "unclear" } | { kind: "unknown" })> => {
  // The local precheck wins over a picked context, so EC/HRT requests always reach Kiro.
  const local = deps.precheck(request.question);
  if (local.kind === "handoff") return { how: "precheck", kind: "context", context: local.context };
  if (local.kind === "route") {
    const routed = deps.contexts.find((c) => c.id === local.contextId);
    return routed ? { how: "precheck", kind: "context", context: routed } : { how: "precheck", kind: "unclear" };
  }

  if (request.context !== undefined) {
    const chosen = deps.contexts.find((c) => c.id === request.context);
    return chosen ? { how: "picked", kind: "context", context: chosen } : { how: "picked", kind: "unknown" };
  }
  // Sticky context (#76, opt-in): a spoken follow-up stays in the context
  // the conversation was answered in, so the classifier is skipped. Only an
  // answered context sticks, and the precheck above has already run.
  if (deps.stickyContext === true && request.stickyContext !== undefined && deps.isAnswered(request.stickyContext)) {
    const sticky = deps.contexts.find((c) => c.id === request.stickyContext);
    if (sticky && sticky.handling.kind !== "handoff") return { how: "sticky", kind: "context", context: sticky };
  }
  const classification = await deps.classify({ question: request.question, history });
  if (classification.kind === "unclear") return { how: "classifier", kind: "unclear" };
  const context = deps.contexts.find((c) => c.id === classification.contextId);
  return context ? { how: "classifier", kind: "context", context } : { how: "classifier", kind: "unclear" };
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
  /** Streaming (#72): each raw piece of the answer's text as it arrives (for timing; not checked yet). */
  readonly onText?: (delta: string) => void;
  /** Streaming: each sentence (or first clause) of the answer once the honesty guard has passed it (#96). */
  readonly onSentence?: (sentence: string) => void;
  /** Streaming: a long first sentence is cut at a clause once it's this long (VOICE_FIRST_CHUNK_CHARS). */
  readonly firstClauseAfter?: number;
  /** Cancels the answer (the client went away, e.g. on barge-in). */
  readonly signal?: AbortSignal;
  /**
   * Streaming only: instead of wrapping up straight after the answer, hand
   * the wrap-up over, to run once it's known what was actually spoken.
   */
  readonly deferWrapUp?: (turn: DeferredWrapUp) => void;
  /** Latency timings (#76): how the context was decided and how long that and the memories took. Numbers only. */
  readonly onStage?: (
    stage: "route" | "memories",
    fields: { readonly ms: number; readonly how?: RouteHow; readonly speculative?: "used" | "discarded" },
  ) => void;
};

/** The context answered speculatively while the classifier runs (#76, SPECULATIVE_ANSWER=on). */
const SPECULATIVE_CONTEXT = "personal";

/**
 * Speculative answer (#76, opt-in): when the classifier will run (no picked
 * or sticky context, and the local precheck found nothing), the personal
 * answer starts at the same time. Its text is held back until the classifier
 * agrees, then sent on; if it picks anything else, the speculative answer is
 * cancelled and thrown away (no wrap-up, nothing sent).
 */
const startSpeculation = (deps: Deps, request: AskRequest, history: readonly Turn[], meta: AskMeta, onToolSucceeded: () => void) => {
  if (deps.speculativeAnswer !== true || request.context !== undefined || !deps.isAnswered(SPECULATIVE_CONTEXT as Context["id"])) return undefined;
  if (deps.precheck(request.question).kind !== "none") return undefined;
  const stickyWouldApply = deps.stickyContext === true && request.stickyContext !== undefined && deps.isAnswered(request.stickyContext);
  if (stickyWouldApply) return undefined;
  const context = deps.contexts.find((c) => c.id === SPECULATIVE_CONTEXT && c.handling.kind === "answer");
  if (!context) return undefined;

  const controller = new AbortController();
  meta.signal?.addEventListener("abort", () => controller.abort());
  const held: string[] = [];
  let live = false;
  const onText = (delta: string): void => {
    if (live) meta.onText?.(delta);
    else held.push(delta);
  };
  const run = (async () => {
    const memories = await deps.memory.loadMemories({ question: request.question, contextId: context.id });
    const answer = await deps.answer({
      context,
      question: request.question,
      history,
      memories,
      now: deps.now(),
      onText,
      signal: controller.signal,
      ...(request.spoken === true ? { spoken: true } : {}),
      ...(request.brain ? { brain: request.brain } : {}),
      onToolSucceeded,
    });
    return { memories, answer };
  })();
  return {
    context,
    /** The classifier agreed: send what's held, then the rest as it comes. */
    use: () => {
      live = true;
      for (const d of held.splice(0)) meta.onText?.(d);
      return run;
    },
    discard: () => {
      controller.abort();
      void run.catch(() => undefined);
    },
  };
};

/**
 * Bare conversation mode (#88, BARE_MODE=on): the local EC precheck (EC/HRT
 * still goes to Kiro, with no model), then the selected brain with only the
 * history and a short persona. No classifier, no contexts, no profile, no
 * memory reads or writes: with the Local brain, nothing reaches Claude.
 */
const handleBare = async (deps: Deps, bare: Deps["answer"], request: AskRequest, meta: AskMeta, guard: HonestyGuard): Promise<AskResponse> => {
  const local = deps.precheck(request.question);
  // The answer's path (#102), for the page only: never logged.
  const path: PathStep[] = [{ kind: "precheck", result: local.kind }];
  if (local.kind === "handoff") {
    deps.log.info("ask", { context: local.context.id, outcome: "handoff", bare: true });
    return {
      type: "handoff",
      context: local.context.id,
      to: local.context.handling.kind === "handoff" ? local.context.handling.to : "",
      message: handoffMessage(local.context),
      path,
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
    ...(request.spoken === true ? { spoken: true } : {}),
    ...(request.remember === false ? { remember: false } : {}),
    onToolSucceeded: guard.toolSucceeded,
    onStep: (step) => {
      path.push(step);
      // Only a read that worked lets the reply say what's on the calendar (#102).
      if (step.kind === "tool" && step.name === "calendar_read") (step.ok ? guard.resultsKnown : guard.readFailed)();
    },
  });
  path.splice(1, 0, { kind: "brain", brain: request.brain ?? "claude" });
  if (!answer.ok) {
    deps.log.info("ask", { outcome: answer.error.code === "cancelled" ? "cancelled" : "error", bare: true, brain: request.brain ?? "claude" });
    return { type: "error", message: answer.error.message };
  }
  if (answer.value.kind !== "answer") return { type: "unavailable", context: personal.id, message: answer.value.message };
  const checked = guard.finish(answer.value.text);
  path.push(guardStep(checked));
  deps.log.info("ask", { outcome: "answer", bare: true, brain: request.brain ?? "claude" });
  return { type: "answer", context: personal.id, answer: checked.text, ...(request.brain ? { brain: request.brain } : {}), path };
};

type HonestyGuard = ReturnType<typeof makeHonestyGuard>;

const guardStep = (checked: ReturnType<HonestyGuard["finish"]>): PathStep => ({
  kind: "guard",
  claimedAction: checked.dropped.claimed_action,
  promise: checked.dropped.promise,
  perception: checked.dropped.perception,
  toolResult: checked.dropped.tool_result,
  replaced: checked.replaced,
});

/**
 * Every answer goes through the honesty guard (#96), whatever brain wrote it:
 * streamed text is checked sentence by sentence before it's sent on, and the
 * full text before it's returned, remembered or wrapped up.
 */
export const handleAsk = async (deps: Deps, request: AskRequest, outer: AskMeta = {}): Promise<AskResponse> => {
  const guard = makeHonestyGuard({
    question: request.question,
    calendarTalk: calendarIntent(request.question, request.history ?? []) !== undefined,
    calendar: deps.calendarEnabled === true,
    ...(outer.onSentence ? { onSentence: outer.onSentence } : {}),
    ...(outer.firstClauseAfter !== undefined ? { firstClauseAfter: outer.firstClauseAfter } : {}),
    log: deps.log,
  });
  // A read earlier in this conversation (the page's record of real tool calls, #104): what it found may be
  // said again, e.g. to "did you check?". Without this, true answers about it were dropped as unchecked.
  // Not when the question names a day: that day may not have been read, so it needs a read of its own.
  const namesADay = resolveDatePhrase(request.question, "2026-01-01") !== undefined;
  if (!namesADay && (request.history ?? []).some((t) => t.role === "assistant" && cameFromRead(t))) guard.resultsKnown();
  // Claude with native tools: no calendar-claims check (it dropped true answers, e.g. about an event
  // Jarvis had just added). Fake actions, promises and perception are still dropped.
  if (deps.nativeTools === true && (request.brain ?? "claude") === "claude") guard.resultsKnown();
  const streaming = outer.onText !== undefined || outer.onSentence !== undefined;
  const { onText: rawText, ...rest } = outer;
  const meta: AskMeta = streaming
    ? {
        ...rest,
        onText: (delta: string) => {
          rawText?.(delta);
          guard.onText(delta);
        },
      }
    : rest;
  return answerChecked(deps, request, meta, guard);
};

const answerChecked = async (deps: Deps, request: AskRequest, meta: AskMeta, guard: HonestyGuard): Promise<AskResponse> => {
  const history = request.history ?? [];
  if (deps.bare) {
    try {
      return await handleBare(deps, deps.bare, request, meta, guard);
    } catch (e) {
      deps.log.error("ask failed", { errorName: e instanceof Error ? e.name : typeof e });
      return { type: "error", message: GENERIC_ERROR };
    }
  }
  try {
    const routeStarted = performance.now();
    const speculation = startSpeculation(deps, request, history, meta, guard.toolSucceeded);
    const resolved = await resolveContext(deps, request, history);
    const useSpeculation = speculation !== undefined && resolved.kind === "context" && resolved.context.id === speculation.context.id;
    if (speculation && !useSpeculation) speculation.discard();
    meta.onStage?.("route", {
      ms: Math.round(performance.now() - routeStarted),
      how: resolved.how,
      ...(speculation ? { speculative: useSpeculation ? "used" : "discarded" } : {}),
    });

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
      return {
        type: "handoff",
        context: context.id,
        to: context.handling.to,
        message: handoffMessage(context),
        ...(resolved.how === "precheck" ? { path: [{ kind: "precheck" as const, result: "handoff" as const }] } : {}),
      };
    }

    // No answerer, no memory: "not connected yet" needs nothing loaded.
    const memoriesStarted = performance.now();
    const { memories, answer } = useSpeculation
      ? await speculation.use()
      : await (async () => {
          const loaded = deps.isAnswered(context.id)
            ? await deps.memory.loadMemories({ question: request.question, contextId: context.id })
            : [];
          meta.onStage?.("memories", { ms: Math.round(performance.now() - memoriesStarted) });
          return {
            memories: loaded,
            answer: await deps.answer({
              context,
              question: request.question,
              history,
              memories: loaded,
              now: deps.now(),
              ...(meta.onText ? { onText: meta.onText } : {}),
              ...(meta.signal ? { signal: meta.signal } : {}),
              ...(request.spoken === true ? { spoken: true } : {}),
              ...(request.brain ? { brain: request.brain } : {}),
              onToolSucceeded: guard.toolSucceeded,
            }),
          };
        })();

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
    // Only what the honesty guard kept is shown, spoken and remembered (#96).
    const checked = guard.finish(answer.value.text);
    if (request.remember !== false) {
      if (meta.deferWrapUp) {
        meta.deferWrapUp({ question: request.question, completed: true, answer: checked.text, run: runWrapUp });
      } else {
        runWrapUp(checked.text);
      }
    }

    deps.log.info("ask", { context: context.id, outcome: "answer", brain: request.brain ?? "claude" });
    const path: PathStep[] = [
      { kind: "precheck", result: resolved.how === "precheck" ? "route" : "none" },
      { kind: "brain", brain: request.brain ?? "claude" },
      guardStep(checked),
    ];
    return { type: "answer", context: context.id, answer: checked.text, ...(request.brain ? { brain: request.brain } : {}), path };
  } catch (e) {
    // Only the error class is logged; messages could quote the question.
    deps.log.error("ask failed", { errorName: e instanceof Error ? e.name : typeof e });
    return { type: "error", message: GENERIC_ERROR };
  }
};
