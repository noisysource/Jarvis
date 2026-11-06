// End-to-end through buildDeps + handleAsk: the real contexts.md, precheck,
// classifier, router, personal answerer and memory wrapper. Only the model
// calls and the profile file are stubbed.

import { describe, expect, it } from "vitest";
import { buildDeps, capabilitiesText, type AppInputs } from "../src/app.js";
import { parseContexts } from "../src/contexts.js";
import { readFile } from "node:fs/promises";
import { handleAsk } from "../src/ask.js";
import { loadConfig } from "../src/config.js";
import { formatModelRef, type ModelRef } from "../src/llm/model-ref.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import type { ProfileFileSystem } from "../src/profile.js";
import { ok } from "../src/result.js";
import type { AskRequest, Deps, Logger } from "../src/types.js";

const PROFILE = "## Family\n- Daughter: Inês, born 2 September 2017";
const NOW = new Date("2026-11-06T17:20:00Z");

const config = (() => {
  const result = loadConfig({});
  if (!result.ok) throw new Error(result.error);
  return result.value;
})();

const profileFs = (text: string | undefined): ProfileFileSystem => ({
  stat: async () => {
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { mtimeMs: 1, size: Buffer.byteLength(text) };
  },
  readFile: async () => text ?? "",
});

const response = (r: { kind: "json"; value: unknown } | { kind: "text"; text: string }): LlmResponse =>
  ({
    ...r,
    servedBy: "stub",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    payload: { provider: "anthropic", data: [] },
  }) as LlmResponse;

/** Stub models: the classifier answers with `classifyAs`, the answer model with a fixed text. Records every request by model. */
const stubModels = (classifyAs: string) => {
  const requests: { model: string; request: LlmRequest }[] = [];
  const makeLlm = (ref: ModelRef) =>
    ok<LlmCall>(async (request) => {
      requests.push({ model: formatModelRef(ref), request });
      return ok(
        request.outputSchema
          ? response({ kind: "json", value: { context: classifyAs } })
          : response({ kind: "text", text: "Her birthday is 2 September." }),
      );
    });
  return { makeLlm, requests };
};

const silentLog: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const build = async (overrides: Partial<AppInputs> & { classifyAs?: string } = {}) => {
  const models = stubModels(overrides.classifyAs ?? "personal");
  const result = await buildDeps({
    config,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    log: silentLog,
    profileFs: profileFs(PROFILE),
    makeLlm: models.makeLlm,
    now: () => NOW,
    ...overrides,
  });
  return { result, requests: models.requests };
};

const ask = async (deps: Deps, request: AskRequest) => handleAsk(deps, request);

const depsOf = (result: Awaited<ReturnType<typeof buildDeps>>): Deps => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const CLASSIFIER = "anthropic:claude-haiku-5-5";
const ANSWER = "anthropic:claude-sonnet-5-5";

describe("buildDeps refuses to start", () => {
  it("without a profile", async () => {
    const { result } = await build({ profileFs: profileFs(undefined) });
    expect(result).toEqual({
      ok: false,
      error: "No profile at data/profile.md. Copy data/profile.example.md to data/profile.md and fill it in.",
    });
  });

  it("without an API key", async () => {
    const { result } = await build({ env: {} });
    expect(!result.ok && result.error).toContain("No Anthropic API key");
  });

  it("with an invalid contexts.md", async () => {
    const { result } = await build({ readTextFile: async () => "## broken\n" });
    expect(!result.ok && result.error).toContain("contexts.md is invalid");
  });
});

describe("personal questions", () => {
  it("are classified, then answered from the profile with the Lisbon time", async () => {
    const { result, requests } = await build();
    const deps = depsOf(result);

    expect(await ask(deps, { question: "When is my daughter's birthday?" })).toEqual({
      type: "answer",
      context: "personal",
      answer: "Her birthday is 2 September.",
    });

    expect(requests.map((r) => r.model)).toEqual([CLASSIFIER, ANSWER]);
    const answerRequest = requests[1]?.request;
    expect(answerRequest?.system).toContain(PROFILE);
    expect(answerRequest?.cacheSystem).toBe(true);
    expect(answerRequest?.systemSuffix).toBe("Now: Friday, 6 November 2026, 17:20 (Europe/Lisbon, GMT+0)");
    expect(answerRequest?.tools).toBeUndefined();
  });

  it("tell the answerer truthfully what Jarvis can do", async () => {
    const { result, requests } = await build();
    await ask(depsOf(result), { question: "What can you do?" });
    const system = requests[1]?.request.system ?? "";
    expect(system).toContain("<what_jarvis_can_do>");
    expect(system).toContain("- KidClub: not connected yet, so Jarvis can't answer these questions yet.");
    expect(system).toContain("- Noisy Source: not connected yet, so Jarvis can't answer these questions yet.");
    expect(system).toContain("- European Commission / HRT: not handled by Jarvis; those requests go to Kiro (the EC's agent).");
    expect(system).toContain("- Personal: My own life");
  });

  it("send the history to both the classifier and the answerer", async () => {
    const { result, requests } = await build();
    await ask(depsOf(result), {
      question: "And when is her birthday?",
      history: [
        { role: "user", text: "What's my daughter's name?" },
        { role: "assistant", text: "Inês." },
      ],
    });

    const classifierText = requests[0]?.request.messages.map((m) => ("text" in m ? m.text : "")).join("\n");
    expect(classifierText).toContain("User: What's my daughter's name?");
    expect(classifierText).toContain("Jarvis: Inês.");
    expect(requests[1]?.request.messages).toEqual([
      { role: "user", text: "What's my daughter's name?" },
      { role: "assistant", text: "Inês." },
      { role: "user", text: "And when is her birthday?" },
    ]);
  });
});

describe("contexts that aren't connected in M0", () => {
  it.each([
    ["kidclub", "Which KidClub invoices are unpaid?", "KidClub isn't connected yet, so I can't answer that one."],
    ["noisysource", "How much did Noisy Source bill last quarter?", "Noisy Source isn't connected yet, so I can't answer that one."],
  ])("%s replies that it isn't connected (unavailable, not an error), with no answer-model call", async (context, question, message) => {
    const { result, requests } = await build({ classifyAs: context });
    expect(await ask(depsOf(result), { question })).toEqual({ type: "unavailable", context, message });
    expect(requests.map((r) => r.model)).toEqual([CLASSIFIER]);
  });

  it("EC invoicing goes to noisysource without any model call", async () => {
    const { result, requests } = await build();
    expect(await ask(depsOf(result), { question: "Invoice the European Commission for October" })).toEqual({
      type: "unavailable",
      context: "noisysource",
      message: "Noisy Source isn't connected yet, so I can't answer that one.",
    });
    expect(requests).toEqual([]);
  });
});

describe("EC / HRT", () => {
  it("hands off to Kiro with no model call, even with a picked context", async () => {
    const { result, requests } = await build();
    expect(await ask(depsOf(result), { question: "Summarise the UTP standup", context: "personal" as never })).toMatchObject({
      type: "handoff",
      context: "ec-hrt",
      to: "Kiro (the EC's agent)",
    });
    expect(requests).toEqual([]);
  });

  it("hands off when only the classifier recognises it", async () => {
    const { result, requests } = await build({ classifyAs: "ec-hrt" });
    expect((await ask(depsOf(result), { question: "What did the team decide about the new recruitment workflow?" })).type).toBe(
      "handoff",
    );
    expect(requests.map((r) => r.model)).toEqual([CLASSIFIER]);
  });
});

describe("unclear questions", () => {
  it("ask which context, offering only answerable ones", async () => {
    const { result } = await build({ classifyAs: "unclear" });
    expect(await ask(depsOf(result), { question: "Did it get paid?" })).toEqual({
      type: "clarify",
      message: "I'm not sure which this is about. Is it Personal, KidClub or Noisy Source?",
      options: [
        { id: "personal", name: "Personal" },
        { id: "kidclub", name: "KidClub" },
        { id: "noisysource", name: "Noisy Source" },
      ],
    });
  });

  it("are answered once the user picks a context", async () => {
    const { result, requests } = await build({ classifyAs: "unclear" });
    expect((await ask(depsOf(result), { question: "Did it get paid?", context: "personal" as never })).type).toBe("answer");
    expect(requests.map((r) => r.model)).toEqual([ANSWER]);
  });
});

describe("capabilitiesText", () => {
  it("describes each context by how Jarvis handles it", async () => {
    const parsed = parseContexts(await readFile("contexts.md", "utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    const text = capabilitiesText(parsed.value, new Set(["personal"]));
    expect(text.split("\n")[0]).toBe("Jarvis can help with:");
    expect(text).toContain("(answered from: My profile (data/profile.md))");
    expect(text).toContain("- General questions and conversation.");
    expect(text).toContain("answers are read aloud in English or Portuguese");
  });
});
