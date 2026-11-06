import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { clarifyMessage, handleAsk } from "../src/ask.js";
import { parseContexts } from "../src/contexts.js";
import { makeSafeMemoryHooks } from "../src/memory.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import type {
  AnswerInput,
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

const memory: Memory = { id: "m1", contextId: id("personal"), text: "Daughter: Inês", createdAt: NOW, source: "q0" };

/** Stub deps that record every call, in order. */
const makeDeps = (
  options: {
    classification?: Classification;
    answer?: Result<string, AppError>;
    memory?: MemoryHooks;
    throwInClassify?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const answerInputs: AnswerInput[] = [];
  const wrapUps: unknown[] = [];
  const logs: unknown[] = [];
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
      return options.answer ?? ok("2 September.");
    },
    memory: hooks,
    now: () => NOW,
    log: { info: record("info"), warn: record("warn"), error: record("error") },
  };
  return { deps, calls, answerInputs, wrapUps, logs };
};

describe("answered contexts", () => {
  it("loads memories, answers, then wraps up, in that order", async () => {
    const { deps, calls, answerInputs, wrapUps } = makeDeps();
    const history: Turn[] = [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello!" }];

    const response = await handleAsk(deps, { question: QUESTION, history });

    expect(response).toEqual({ type: "answer", context: "personal", answer: "2 September." });
    expect(calls).toEqual(["classify", "loadMemories", "answer", "wrapUp"]);
    expect(answerInputs[0]).toMatchObject({ question: QUESTION, history, memories: [memory], now: NOW });
    expect(answerInputs[0]?.context.id).toBe("personal");
    expect(wrapUps[0]).toEqual({
      question: QUESTION,
      contextId: "personal",
      answer: "2 September.",
      memoriesUsed: [memory],
    });
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

describe("unclear", () => {
  it("asks which context, offering only answerable ones", async () => {
    const { deps, calls } = makeDeps({ classification: { kind: "unclear" } });
    const response = await handleAsk(deps, { question: "Did it get paid?" });

    expect(response).toEqual({
      type: "clarify",
      message: "I'm not sure which this is about. Is it Personal, KidClub or Noisy Source?",
      options: [
        { id: "personal", name: "Personal" },
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

    expect(await handleAsk(deps, { question: "Summarise the UTP standup", context: id("personal") })).toEqual({
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
    expect(calls).toEqual(["loadMemories", "answer", "wrapUp"]);
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
    const { deps, answerInputs } = makeDeps({ memory: makeSafeMemoryHooks(failing) });

    expect(await handleAsk(deps, { question: QUESTION })).toEqual({
      type: "answer",
      context: "personal",
      answer: "2 September.",
    });
    expect(answerInputs[0]?.memories).toEqual([]);
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
