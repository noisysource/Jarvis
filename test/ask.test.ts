import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { clarifyMessage, type DeferredWrapUp, handleAsk } from "../src/ask.js";
import { parseContexts } from "../src/contexts.js";
import { makeSafeMemoryHooks } from "../src/memory.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import type {
  AnswerInput,
  AnswerOutcome,
  AppError,
  Classification,
  Context,
  ContextId,
  Deps,
  Memory,
  MemoryHooks,
  Turn,
} from "../src/types.js";
import type { Result } from "../src/result.js";

const QUESTION = "When is my daughter's birthday?";
const NOW = new Date("2026-11-06T17:20:00Z");
const id = (s: string) => s as ContextId;

let contexts: readonly Context[];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

const memory: Memory = {
  id: "m1",
  contextId: id("personal"),
  kind: "fact",
  text: "Daughter: Inês",
  origin: "auto",
  createdAt: NOW,
  updatedAt: NOW,
  source: "q0",
  seen: false,
};

/** Stub deps that record every call, in order. */
const makeDeps = (
  options: {
    classification?: Classification;
    answer?: Result<AnswerOutcome, AppError>;
    memory?: MemoryHooks;
    throwInClassify?: boolean;
    /** Contexts with an answerer; all of them by default. */
    answered?: readonly string[];
  } = {},
) => {
  const calls: string[] = [];
  const answerInputs: AnswerInput[] = [];
  const wrapUps: unknown[] = [];
  const logs: unknown[] = [];
  const deferred: (() => Promise<void>)[] = [];
  /** Runs the work handed to afterReply, as the server does once the reply is out. */
  const flush = async () => {
    for (const task of deferred.splice(0)) await task();
  };
  const record = (level: string) => (message: string, fields?: unknown) => logs.push({ level, message, fields });

  const hooks: MemoryHooks = options.memory ?? {
    loadMemories: async () => {
      calls.push("loadMemories");
      return [memory];
    },
    wrapUp: async (input) => {
      calls.push("wrapUp");
      wrapUps.push(input);
    },
  };

  const deps: Deps = {
    contexts,
    precheck: makePrecheck(contexts),
    classify: async () => {
      calls.push("classify");
      if (options.throwInClassify) throw new TypeError(`boom ${QUESTION}`);
      return options.classification ?? { kind: "context", contextId: id("personal") };
    },
    answer: async (input) => {
      calls.push("answer");
      answerInputs.push(input);
      return options.answer ?? ok({ kind: "answer", text: "2 September." });
    },
    memory: hooks,
    isAnswered: (contextId) => options.answered?.includes(contextId) ?? true,
    afterReply: (name, task) => {
      calls.push(`after reply: ${name}`);
      deferred.push(task);
    },
    now: () => NOW,
    log: { info: record("info"), warn: record("warn"), error: record("error") },
  };
  return { deps, calls, answerInputs, wrapUps, logs, flush };
};

describe("answered contexts", () => {
  it("loads memories and answers; the wrap-up only runs after the reply", async () => {
    const { deps, calls, answerInputs, wrapUps, flush } = makeDeps();
    const history: Turn[] = [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello!" }];

    const response = await handleAsk(deps, { question: QUESTION, history });

    expect(response).toMatchObject({ type: "answer", context: "personal", answer: "2 September." });
    // The reply is ready and the wrap-up hasn't run: it was handed to afterReply.
    expect(calls).toEqual(["classify", "loadMemories", "answer", "after reply: memory wrap-up"]);
    expect(wrapUps).toEqual([]);
    await flush();
    expect(calls.at(-1)).toBe("wrapUp");
    expect(answerInputs[0]).toMatchObject({ question: QUESTION, history, memories: [memory], now: NOW });
    expect(answerInputs[0]?.context.id).toBe("personal");
    expect(wrapUps[0]).toEqual({
      question: QUESTION,
      contextId: "personal",
      answer: "2 September.",
      memoriesUsed: [memory],
    });
  });

  it("passes the conversation id and request id to the wrap-up", async () => {
    const { deps, wrapUps, flush } = makeDeps();
    await handleAsk(deps, { question: QUESTION, conversationId: "conv-12345678" }, { requestId: "req-1" });
    await flush();
    expect(wrapUps[0]).toMatchObject({ conversationId: "conv-12345678", requestId: "req-1" });
  });

  it("uses memories but learns nothing when remember is false", async () => {
    const { deps, calls, answerInputs, wrapUps } = makeDeps();
    const response = await handleAsk(deps, { question: QUESTION, remember: false });
    expect(response.type).toBe("answer");
    expect(calls).toEqual(["classify", "loadMemories", "answer"]);
    expect(answerInputs[0]?.memories).toEqual([memory]);
    expect(wrapUps).toEqual([]);
  });

  it("streaming: passes text on, and hands the wrap-up over instead of scheduling it", async () => {
    const { deps, calls, answerInputs } = makeDeps();
    const deferred: DeferredWrapUp[] = [];
    const raw: string[] = [];
    const onText = (d: string) => void raw.push(d);
    const signal = new AbortController().signal;
    const response = await handleAsk(deps, { question: QUESTION }, { onText, signal, deferWrapUp: (t) => deferred.push(t) });
    expect(response.type).toBe("answer");
    // The answerer's text goes through the honesty guard (#96), and still reaches the caller.
    answerInputs[0]?.onText?.("Hi");
    expect(raw).toEqual(["Hi"]);
    expect(answerInputs[0]?.signal).toBe(signal);
    expect(calls).not.toContain("after reply: memory wrap-up");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ question: QUESTION, completed: true, answer: "2 September." });
    deferred[0]?.run("2 Sept—");
    expect(calls.at(-1)).toBe("after reply: memory wrap-up");
  });

  it("streaming: a cancelled answer is handed over as not completed, and replies with an error", async () => {
    const { deps } = makeDeps({ answer: err({ code: "cancelled", message: "Cancelled." }) });
    const deferred: DeferredWrapUp[] = [];
    const response = await handleAsk(deps, { question: "Remember Diniz has football tomorrow" }, { deferWrapUp: (t) => deferred.push(t) });
    expect(response).toEqual({ type: "error", message: "Cancelled." });
    expect(deferred[0]).toMatchObject({ completed: false, answer: "" });
  });

  it("streaming: remember: false hands nothing over", async () => {
    const { deps } = makeDeps();
    const deferred: DeferredWrapUp[] = [];
    await handleAsk(deps, { question: QUESTION, remember: false }, { deferWrapUp: (t) => deferred.push(t) });
    expect(deferred).toEqual([]);
  });

  it("skips classification when the context is given", async () => {
    const { deps, calls } = makeDeps({ classification: { kind: "unclear" } });
    const response = await handleAsk(deps, { question: QUESTION, context: id("personal") });
    expect(response.type).toBe("answer");
    expect(calls).not.toContain("classify");
  });

  it("defaults history to empty", async () => {
    const { deps, answerInputs } = makeDeps();
    await handleAsk(deps, { question: QUESTION });
    expect(answerInputs[0]?.history).toEqual([]);
  });

  it("returns the answerer's safe message on error, without wrapping up", async () => {
    const { deps, calls } = makeDeps({ answer: err({ code: "llm_refused", message: "Sorry, I can't help with that one." }) });
    expect(await handleAsk(deps, { question: QUESTION })).toEqual({
      type: "error",
      message: "Sorry, I can't help with that one.",
    });
    expect(calls).toEqual(["classify", "loadMemories", "answer"]);
  });
});

describe("unavailable contexts", () => {
  it("reply with an unavailable message, not an error, without loading memories or wrapping up", async () => {
    const { deps, calls, logs, answerInputs } = makeDeps({
      classification: { kind: "context", contextId: id("kidclub") },
      answer: ok({ kind: "unavailable", message: "KidClub isn't connected yet, so I can't answer that one." }),
      answered: ["personal"],
    });

    expect(await handleAsk(deps, { question: "Which invoices are unpaid?" })).toEqual({
      type: "unavailable",
      context: "kidclub",
      message: "KidClub isn't connected yet, so I can't answer that one.",
    });
    expect(calls).toEqual(["classify", "answer"]); // no loadMemories, no after-reply work
    expect(answerInputs[0]?.memories).toEqual([]);
    expect(logs).toContainEqual({ level: "info", message: "ask", fields: { context: "kidclub", outcome: "unavailable" } });
  });
});

describe("unclear", () => {
  it("asks which context, offering only answerable ones", async () => {
    const { deps, calls } = makeDeps({ classification: { kind: "unclear" } });
    const response = await handleAsk(deps, { question: "Did it get paid?" });

    expect(response).toEqual({
      type: "clarify",
      message: "I'm not sure which this is about. Is it Personal, KidClub or Noisy Source?",
      options: [
        { id: "personal", name: "Personal", aliases: ["pessoal", "me", "myself"] },
        { id: "kidclub", name: "KidClub" },
        { id: "noisysource", name: "Noisy Source" },
      ],
    });
    expect(calls).toEqual(["classify"]);
  });

  it("treats a classification for an unknown context as unclear", async () => {
    const { deps } = makeDeps({ classification: { kind: "context", contextId: id("gmail") } });
    expect((await handleAsk(deps, { question: QUESTION })).type).toBe("clarify");
  });
});

describe("handoff", () => {
  it("hands off to Kiro when the classifier picks ec-hrt, and runs nothing else", async () => {
    const { deps, calls, logs } = makeDeps({ classification: { kind: "context", contextId: id("ec-hrt") } });
    const question = "What did the team decide about the new recruitment workflow?";

    expect(await handleAsk(deps, { question })).toEqual({
      type: "handoff",
      context: "ec-hrt",
      to: "Kiro (the EC's agent)",
      message: "This is for Kiro (the EC's agent). I don't handle European Commission / HRT requests.",
    });
    expect(calls).toEqual(["classify"]);
    expect(JSON.stringify(logs)).not.toContain(question);
  });

  it("also hands off when the handoff context is given explicitly", async () => {
    const { deps, calls } = makeDeps();
    expect((await handleAsk(deps, { question: "x", context: id("ec-hrt") })).type).toBe("handoff");
    expect(calls).toEqual([]);
  });
});

describe("local precheck always runs first", () => {
  it("hands 'Summarise the UTP standup' to Kiro even with context personal, without any model call", async () => {
    const { deps, calls } = makeDeps();

    expect(await handleAsk(deps, { question: "Summarise the UTP standup", context: id("personal") })).toMatchObject({
      type: "handoff",
      context: "ec-hrt",
      to: "Kiro (the EC's agent)",
      message: "This is for Kiro (the EC's agent). I don't handle European Commission / HRT requests.",
    });
    // No classifier, no answerer (the only model calls), no memory hooks.
    expect(calls).toEqual([]);
  });

  it("routes EC + invoicing to noisysource even when another context was picked", async () => {
    const { deps, calls, answerInputs } = makeDeps();

    const response = await handleAsk(deps, {
      question: "Invoice the European Commission for October",
      context: id("personal"),
    });

    expect(response).toMatchObject({ type: "answer", context: "noisysource" });
    expect(answerInputs[0]?.context.id).toBe("noisysource");
    expect(calls).toEqual(["loadMemories", "answer", "after reply: memory wrap-up"]);
  });

  it("hands off without classifying when no context is given", async () => {
    const { deps, calls } = makeDeps({ classification: { kind: "context", contextId: id("personal") } });
    expect((await handleAsk(deps, { question: "Is CASP down again?" })).type).toBe("handoff");
    expect(calls).toEqual([]);
  });

  it("uses the picked context when the precheck finds nothing", async () => {
    const { deps, answerInputs } = makeDeps();
    await handleAsk(deps, { question: QUESTION, context: id("kidclub") });
    expect(answerInputs[0]?.context.id).toBe("kidclub");
  });
});

describe("sticky context (#76, opt-in)", () => {
  it("keeps a spoken follow-up in the last answered context, skipping the classifier, only when on", async () => {
    const on = makeDeps();
    const stages: unknown[] = [];
    await handleAsk({ ...on.deps, stickyContext: true }, { question: "And when is it?", spoken: true, stickyContext: id("personal") }, { onStage: (s, f) => stages.push({ s, ...f }) });
    expect(on.calls).not.toContain("classify");
    expect(on.answerInputs[0]?.context.id).toBe("personal");
    expect(on.answerInputs[0]?.spoken).toBe(true);
    expect(stages[0]).toMatchObject({ s: "route", how: "sticky" });

    const off = makeDeps();
    await handleAsk(off.deps, { question: "And when is it?", spoken: true, stickyContext: id("personal") });
    expect(off.calls).toContain("classify");
  });

  it("never overrides the precheck: an EC question is still handed to Kiro, with no model", async () => {
    const { deps, calls } = makeDeps();
    const response = await handleAsk({ ...deps, stickyContext: true }, { question: "Summarise the UTP standup", spoken: true, stickyContext: id("personal") });
    expect(response).toMatchObject({ type: "handoff", context: "ec-hrt" });
    expect(calls).toEqual([]);
  });

  it("sticks only to an answered, non-handoff context", async () => {
    const notAnswered = makeDeps({ answered: ["personal"] });
    await handleAsk({ ...notAnswered.deps, stickyContext: true }, { question: "And when is it?", stickyContext: id("kidclub") });
    expect(notAnswered.calls).toContain("classify");
    const ec = makeDeps();
    await handleAsk({ ...ec.deps, stickyContext: true }, { question: "And when is it?", stickyContext: id("ec-hrt") });
    expect(ec.calls).toContain("classify");
  });

  it("reports how the context was decided, and how long that took", async () => {
    const { deps } = makeDeps();
    const stages: { s: string; how?: string; ms: number }[] = [];
    await handleAsk(deps, { question: "When is my daughter's birthday?" }, { onStage: (s, f) => stages.push({ s, ...f }) });
    expect(stages.map((x) => [x.s, x.how])).toEqual([["route", "classifier"], ["memories", undefined]]);
    await handleAsk(deps, { question: "When is it?", context: id("personal") }, { onStage: (s, f) => stages.push({ s, ...f }) });
    expect(stages.at(-2)).toMatchObject({ s: "route", how: "picked" });
  });
});

describe("speculative answer (#76, opt-in)", () => {
  const streamed = (deps: Deps, question: string) => {
    const text: string[] = [];
    const stages: unknown[] = [];
    return {
      text,
      stages,
      run: () => handleAsk(deps, { question }, { onText: (d) => text.push(d), onStage: (s, f) => stages.push({ s, ...f }) }),
    };
  };

  it("starts the personal answer with the classifier, and sends it once the classifier agrees", async () => {
    const order: string[] = [];
    const { deps } = makeDeps();
    const spec: Deps = {
      ...deps,
      speculativeAnswer: true,
      classify: async () => {
        order.push("classify start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("classify end");
        return { kind: "context", contextId: id("personal") };
      },
      answer: async (input) => {
        order.push("answer start");
        input.onText?.("2 September.");
        order.push("answer text");
        return ok({ kind: "answer", text: "2 September." });
      },
    };
    const s = streamed(spec, "When is my daughter's birthday?");
    expect(await s.run()).toMatchObject({ type: "answer", answer: "2 September." });
    expect(order.indexOf("answer start")).toBeLessThan(order.indexOf("classify end")); // in parallel
    expect(s.text).toEqual(["2 September."]); // held, then sent once
    expect(s.stages[0]).toMatchObject({ s: "route", how: "classifier", speculative: "used" });
  });

  it("throws the speculative answer away when the classifier picks another context: nothing is sent", async () => {
    let cancelled = false;
    const { deps, wrapUps, flush } = makeDeps({ classification: { kind: "context", contextId: id("kidclub") }, answered: ["personal"] });
    const spec: Deps = {
      ...deps,
      speculativeAnswer: true,
      answer: async (input) => {
        if (input.context.id !== "personal") return ok({ kind: "unavailable", message: "KidClub isn't connected yet." });
        input.onText?.("Something personal.");
        await new Promise((r) => setTimeout(r, 30));
        cancelled = input.signal?.aborted ?? false;
        return ok({ kind: "answer", text: "Something personal." });
      },
    };
    const s = streamed(spec, "Which invoices are unpaid?");
    const response = await s.run();
    await flush();
    await new Promise((r) => setTimeout(r, 50)); // the discarded answer notices it was cancelled
    expect(response.type).toBe("unavailable"); // kidclub isn't connected yet
    expect(s.text).toEqual([]);
    expect(cancelled).toBe(true);
    expect(wrapUps).toEqual([]);
    expect(s.stages[0]).toMatchObject({ speculative: "discarded" });
  });

  it("never runs before the precheck: an EC question is handed off with no model at all", async () => {
    const { deps, calls } = makeDeps();
    const response = await handleAsk({ ...deps, speculativeAnswer: true }, { question: "Summarise the UTP standup" });
    expect(response).toMatchObject({ type: "handoff" });
    expect(calls).toEqual([]);
  });

  it("is off by default, and never for a picked context", async () => {
    const off = makeDeps();
    await handleAsk(off.deps, { question: "When is my daughter's birthday?" });
    expect(off.calls).toEqual(["classify", "loadMemories", "answer", "after reply: memory wrap-up"]);
    const picked = makeDeps();
    await handleAsk({ ...picked.deps, speculativeAnswer: true }, { question: "When is it?", context: id("personal") });
    expect(picked.calls.filter((c) => c === "answer")).toHaveLength(1);
  });
});

describe("brains (#88)", () => {
  it("passes the chosen brain to the answerer and says which answered", async () => {
    const { deps, answerInputs } = makeDeps();
    expect(await handleAsk(deps, { question: QUESTION, brain: "local" })).toMatchObject({ type: "answer", brain: "local" });
    expect(answerInputs[0]?.brain).toBe("local");
    const plain = await handleAsk(deps, { question: QUESTION });
    expect(plain).not.toHaveProperty("brain"); // older clients see no change
  });
});

describe("bare mode (#88)", () => {
  const bareDeps = () => {
    const made = makeDeps();
    const bareInputs: AnswerInput[] = [];
    const deps: Deps = {
      ...made.deps,
      bare: async (input) => {
        made.calls.push("bare answer");
        bareInputs.push(input);
        return ok({ kind: "answer", text: "Hi! What can I do for you?" });
      },
    };
    return { ...made, deps, bareInputs };
  };

  it("sends every question, typed or spoken, straight to the brain with only the history", async () => {
    for (const question of ["what are we doing?", "When is my daughter's birthday?", "Which invoices are unpaid?"]) {
      const { deps, calls, bareInputs, flush } = bareDeps();
      const history = [
        { role: "user" as const, text: "Hello" },
        { role: "assistant" as const, text: "Hi!" },
      ];
      const response = await handleAsk(deps, { question, history, brain: "local" });
      await flush();
      expect(response, question).toMatchObject({ type: "answer", context: "personal", answer: "Hi! What can I do for you?", brain: "local" });
      // No classifier (so no context picker), no other context, no memory reads or writes.
      expect(calls, question).toEqual(["bare answer"]);
      expect(bareInputs[0]?.history).toEqual(history);
      expect(bareInputs[0]?.memories).toEqual([]);
      expect(bareInputs[0]?.brain).toBe("local");
    }
  });

  it("tells the brain when the reply will be spoken, for the spoken style (#92)", async () => {
    const { deps, bareInputs } = bareDeps();
    await handleAsk(deps, { question: "Hi", brain: "local", spoken: true });
    await handleAsk(deps, { question: "Hi", brain: "local" });
    expect(bareInputs.map((i) => i.spoken)).toEqual([true, undefined]);
  });

  it("still runs the local EC precheck first: handed to Kiro, with no model at all", async () => {
    const { deps, calls } = bareDeps();
    const response = await handleAsk(deps, { question: "Summarise the UTP standup", brain: "local" });
    expect(response).toMatchObject({ type: "handoff", context: "ec-hrt" });
    expect(calls).toEqual([]);
  });

  it("passes an Ollama-down message through, and is off by default", async () => {
    const { deps } = bareDeps();
    const down: Deps = { ...deps, bare: async () => err({ code: "llm_failed", message: "The local brain (Ollama) isn't running." }) };
    expect(await handleAsk(down, { question: "Hi" })).toEqual({ type: "error", message: "The local brain (Ollama) isn't running." });
    const off = makeDeps();
    await handleAsk(off.deps, { question: QUESTION });
    expect(off.calls).toContain("classify");
  });
});

describe("failures", () => {
  it("rejects an unknown explicit context", async () => {
    const { deps, calls } = makeDeps();
    expect(await handleAsk(deps, { question: QUESTION, context: id("gmail") })).toEqual({
      type: "error",
      message: "That isn't one of my contexts. Please pick one of the options.",
    });
    expect(calls).toEqual([]);
  });

  it("still answers when memory hooks fail (safe wrapper)", async () => {
    const failing: MemoryHooks = {
      loadMemories: async () => {
        throw new Error("db down");
      },
      wrapUp: async () => {
        throw new Error("write failed");
      },
    };
    const { deps, answerInputs, flush } = makeDeps({ memory: makeSafeMemoryHooks(failing) });

    expect(await handleAsk(deps, { question: QUESTION })).toMatchObject({
      type: "answer",
      context: "personal",
      answer: "2 September.",
    });
    expect(answerInputs[0]?.memories).toEqual([]);
    await expect(flush()).resolves.toBeUndefined(); // the failing wrap-up, after the reply, doesn't throw
  });

  it("turns an unexpected exception into a generic error, logging only its class", async () => {
    const { deps, logs } = makeDeps({ throwInClassify: true });
    expect(await handleAsk(deps, { question: QUESTION })).toEqual({
      type: "error",
      message: "Sorry, something went wrong. Please try again.",
    });
    expect(logs).toContainEqual({ level: "error", message: "ask failed", fields: { errorName: "TypeError" } });
    expect(JSON.stringify(logs)).not.toContain(QUESTION);
  });

  it("never logs the question or the answer", async () => {
    const { deps, logs } = makeDeps();
    await handleAsk(deps, { question: QUESTION });
    const logged = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    expect(logged).not.toContain(QUESTION);
    expect(logged).not.toContain("2 September");
  });
});

describe("clarifyMessage", () => {
  it.each([
    [["Personal"], "Is it Personal?"],
    [["Personal", "KidClub"], "Is it Personal or KidClub?"],
    [["A", "B", "C"], "Is it A, B or C?"],
  ])("lists %j", (names, ending) => {
    const options = names.map((name) => ({ id: id(name.toLowerCase()), name }));
    expect(clarifyMessage(options)).toBe(`I'm not sure which this is about. ${ending}`);
  });
});

describe("honesty guard on every answer (#96)", () => {
  /** An answerer that streams `text` in pieces, then returns it; with `tool`, a tool ran and succeeded first. */
  const streamingAnswer =
    (text: string, tool = false) =>
    async (input: AnswerInput): Promise<Result<AnswerOutcome, AppError>> => {
      if (tool) input.onToolSucceeded?.();
      for (let i = 0; i < text.length; i += 5) input.onText?.(text.slice(i, i + 5));
      return ok({ kind: "answer", text });
    };

  it("bare, streamed: only honest sentences are sent, and the reply says what's left", async () => {
    const made = makeDeps();
    const deps: Deps = { ...made.deps, bare: streamingAnswer("Sure. Done! I'll remind you at five.") };
    const sentences: string[] = [];
    const response = await handleAsk(deps, { question: "Remind me at five", brain: "local", spoken: true }, { onSentence: (s) => sentences.push(s) });
    // Asked to do something: the "Sure." is held, and never said before the refusal (#98).
    expect(sentences).toEqual(["Actually, I can't do that yet."]);
    expect(response).toMatchObject({ type: "answer", answer: "Actually, I can't do that yet." });
    expect(made.logs).toContainEqual({ level: "info", message: "honesty guard", fields: { claimedAction: 1, promise: 1, perception: 0, toolResult: 0, replaced: true } });
  });

  it("typed, not streamed: the whole answer is checked, and memory only gets the checked text", async () => {
    const { deps, wrapUps, flush } = makeDeps({ answer: ok({ kind: "answer", text: "Your passport expires in January. I'll remind you in December." }) });
    const response = await handleAsk(deps, { question: QUESTION });
    expect(response).toMatchObject({ type: "answer", answer: "Your passport expires in January." });
    await flush();
    expect(wrapUps[0]).toMatchObject({ answer: "Your passport expires in January." });
  });

  it("streamed: the held wrap-up gets the checked text too", async () => {
    const made = makeDeps();
    const deps: Deps = { ...made.deps, answer: streamingAnswer("You look tired. Your passport expires in January.") };
    const deferred: DeferredWrapUp[] = [];
    const sentences: string[] = [];
    await handleAsk(deps, { question: QUESTION }, { onSentence: (s) => sentences.push(s), deferWrapUp: (t) => deferred.push(t) });
    expect(sentences).toEqual(["Your passport expires in January."]);
    expect(deferred[0]?.answer).toBe("Your passport expires in January.");
  });

  it("lets claims through when a tool ran and succeeded this turn", async () => {
    const made = makeDeps();
    const deps: Deps = { ...made.deps, bare: streamingAnswer("Done. I've added it for Tuesday at ten.", true) };
    const sentences: string[] = [];
    const response = await handleAsk(deps, { question: "Add it", brain: "local" }, { onSentence: (s) => sentences.push(s) });
    expect(sentences).toEqual(["Done.", "I've added it for Tuesday at ten."]);
    expect(response).toMatchObject({ answer: "Done. I've added it for Tuesday at ten." });
  });
});

describe("the answer's path, for the page only (#102)", () => {
  it("bare: the precheck, the brain, each tool step in order, then the guard", async () => {
    const made = makeDeps();
    const deps: Deps = {
      ...made.deps,
      bare: async (input) => {
        input.onStep?.({ kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "code", ok: true, result: "2 events" });
        return ok({ kind: "answer", text: "Looking at Wednesday 11 November. You've got the dentist. I'll remind you." });
      },
    };
    const response = await handleAsk(deps, { question: "What's on tomorrow?", brain: "local" });
    expect(response).toMatchObject({
      answer: "Looking at Wednesday 11 November. You've got the dentist.",
      path: [
        { kind: "precheck", result: "none" },
        { kind: "brain", brain: "local" },
        { kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "code", ok: true, result: "2 events" },
        { kind: "guard", claimedAction: 0, promise: 1, perception: 0, replaced: false },
      ],
    });
    // The server log keeps its numbers-only lines: the path isn't logged.
    expect(JSON.stringify(made.logs)).not.toContain("calendar_read");
    expect(JSON.stringify(made.logs)).not.toContain("Wed 11 Nov");
  });

  it("an EC question shows only the precheck: no brain ran", async () => {
    const made = makeDeps();
    const deps: Deps = { ...made.deps, bare: async () => ok({ kind: "answer", text: "x" }) };
    expect(await handleAsk(deps, { question: "Summarise the UTP standup", brain: "local" })).toMatchObject({
      type: "handoff",
      path: [{ kind: "precheck", result: "handoff" }],
    });
  });

  it("the normal path has it too", async () => {
    const { deps } = makeDeps();
    expect(await handleAsk(deps, { question: QUESTION })).toMatchObject({
      path: [
        { kind: "precheck", result: "none" },
        { kind: "brain", brain: "claude" },
        { kind: "guard", claimedAction: 0, promise: 0, perception: 0, replaced: false },
      ],
    });
  });

  it("with Claude's native tools, true calendar talk isn't dropped; fake actions still are", async () => {
    const made = makeDeps();
    const history: Turn[] = [
      { role: "user", text: "add a test meeting for tomorrow 09h30" },
      { role: "assistant", text: "Added “Test meeting” on Thursday 12 November, 09:30–10:30.", tools: ["calendar_create Thu 12 Nov 09:30–10:30 → added"] },
    ];
    const claude: Deps = {
      ...made.deps,
      calendarEnabled: true,
      nativeTools: true,
      bare: async () => ok({ kind: "answer", text: "Quick heads-up: you have a test meeting tomorrow from 09:30 to 10:30, so 9:45 overlaps it. What should I call the new one?" }),
    };
    expect(await handleAsk(claude, { question: "can you add a meeting for tomorrow at 9:45", history, brain: "claude" })).toMatchObject({
      answer: "Quick heads-up: you have a test meeting tomorrow from 09:30 to 10:30, so 9:45 overlaps it. What should I call the new one?",
    });
    const faking: Deps = { ...claude, bare: async () => ok({ kind: "answer", text: "I've added it to your calendar. Anything else?" }) };
    const r = await handleAsk(faking, { question: "add lunch tomorrow at one", history, brain: "claude" });
    expect(r.type === "answer" ? r.answer : "").not.toContain("I've added it");
    // The local brain keeps the check.
    const l = await handleAsk(claude, { question: "can you add a meeting for tomorrow at 9:45", history, brain: "local" });
    expect(l.type === "answer" ? l.answer : "").not.toContain("you have a test meeting");
  });

  it("what an earlier real read found may be said again, when no new day is asked about (#104)", async () => {
    const made = makeDeps();
    const history: Turn[] = [
      { role: "user", text: "What's on tomorrow?" },
      { role: "assistant", text: "One meeting, 08:00 to 09:00.", tools: ["calendar_read Wed 11 Nov → 1 event"] },
    ];
    const claude: Deps = { ...made.deps, calendarEnabled: true, bare: async () => ok({ kind: "answer", text: "Yes, I really did. Tomorrow you have one meeting, from eight to nine." }) };
    // A typo, so no code path: the brain answers from the record, and the guard lets it.
    expect(await handleAsk(claude, { question: "did you actully check??", history })).toMatchObject({
      answer: "Yes, I really did. Tomorrow you have one meeting, from eight to nine.",
      path: [{ kind: "precheck" }, { kind: "brain" }, { kind: "guard", toolResult: 0, replaced: false }],
    });
    // A new day still needs a read of its own.
    const friday: Deps = { ...made.deps, calendarEnabled: true, bare: async () => ok({ kind: "answer", text: "On Friday your calendar is clear." }) };
    expect(await handleAsk(friday, { question: "and Friday?", history })).toMatchObject({ path: [{ kind: "precheck" }, { kind: "brain" }, { kind: "guard", toolResult: 1 }] });
    // No record of a read: as before.
    const noRecord: Turn[] = [history[0] ?? { role: "user", text: "" }, { role: "assistant", text: "One meeting, 08:00 to 09:00." }];
    expect(await handleAsk(claude, { question: "did you actully check??", history: noRecord })).toMatchObject({ path: [{ kind: "precheck" }, { kind: "brain" }, { kind: "guard", toolResult: 1 }] });
  });

  it("a claim about the calendar is dropped unless calendar_read worked this turn (#102)", async () => {
    const made = makeDeps();
    const history: Turn[] = [{ role: "user", text: "What's on today?" }, { role: "assistant", text: "Looking at Tuesday 10 November. Nothing on." }];
    // No read: what qwen said.
    const noRead: Deps = { ...made.deps, calendarEnabled: true, bare: async () => ok({ kind: "answer", text: "On Wednesday your calendar is clear." }) };
    expect(await handleAsk(noRead, { question: "what about tomorrow?", history, brain: "local" })).toMatchObject({
      answer: "I haven't checked your calendar for that. Which day shall I look at?",
      path: [{ kind: "precheck" }, { kind: "brain" }, { kind: "guard", toolResult: 1, replaced: true }],
    });
    // A read that worked: the same kind of sentence is kept.
    const read: Deps = {
      ...made.deps,
      calendarEnabled: true,
      bare: async (input) => {
        input.onStep?.({ kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "code", ok: true, result: "1 event" });
        return ok({ kind: "answer", text: "Looking at Wednesday 11 November. You have one event, from eight to nine." });
      },
    };
    expect(await handleAsk(read, { question: "what about tomorrow?", history, brain: "local" })).toMatchObject({
      answer: "Looking at Wednesday 11 November. You have one event, from eight to nine.",
      path: [{ kind: "precheck" }, { kind: "brain" }, { kind: "tool", ok: true }, { kind: "guard", toolResult: 0 }],
    });
    // A read that failed: no claim, and it says so.
    const failed: Deps = {
      ...made.deps,
      calendarEnabled: true,
      bare: async (input) => {
        input.onStep?.({ kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "code", ok: false, error: "network" });
        return ok({ kind: "answer", text: "You have nothing on tomorrow." });
      },
    };
    expect(await handleAsk(failed, { question: "what about tomorrow?", history, brain: "local" })).toMatchObject({ answer: "I couldn't check your calendar just now." });
  });
});
