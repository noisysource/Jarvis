import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLASSIFIER_HISTORY_TURNS,
  classifierSchema,
  classifierSystemPrompt,
  classifierUserMessage,
  makeClassifier,
} from "../src/classify.js";
import { parseContexts } from "../src/contexts.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, Logger, Turn } from "../src/types.js";

type Fixture = { question: string; expected: string; precheck?: boolean };

let contexts: readonly Context[];
let fixtures: Fixture[];

beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
  fixtures = (JSON.parse(await readFile("test/fixtures/classifier-questions.json", "utf8")) as { cases: Fixture[] })
    .cases;
});

const respond = (value: unknown): LlmResponse => ({
  kind: "json",
  value,
  servedBy: "claude-haiku-5-5",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  payload: { provider: "anthropic", data: [] },
});

/** A stub model that records requests and answers with `value`. */
const stubLlm = (value: unknown) => {
  const requests: LlmRequest[] = [];
  const llm: LlmCall = async (request) => {
    requests.push(request);
    return ok(respond(value));
  };
  return { llm, requests };
};

const silentLog = () => {
  const warn = vi.fn<Logger["warn"]>();
  const log: Logger = { info: vi.fn<Logger["info"]>(), warn, error: vi.fn<Logger["error"]>() };
  return Object.assign(log, { warn });
};

describe("local precheck runs first", () => {
  it("never calls the model for questions the precheck decides", async () => {
    const { llm, requests } = stubLlm({ context: "personal" });
    const classify = makeClassifier({ contexts, llm });

    for (const f of fixtures.filter((f) => f.precheck)) {
      expect(await classify({ question: f.question, history: [] }), f.question).toEqual({
        kind: "context",
        contextId: f.expected,
      });
    }
    expect(requests).toHaveLength(0);
  });

  it("calls the model for everything else", async () => {
    const { llm, requests } = stubLlm({ context: "personal" });
    await makeClassifier({ contexts, llm })({ question: "When is my daughter's birthday?", history: [] });
    expect(requests).toHaveLength(1);
  });
});

describe("classifier model", () => {
  it("returns the context the model picks", async () => {
    const { llm } = stubLlm({ context: "kidclub" });
    expect(await makeClassifier({ contexts, llm })({ question: "Unpaid invoices?", history: [] })).toEqual({
      kind: "context",
      contextId: "kidclub",
    });
  });

  it("returns ec-hrt from the model as a backstop", async () => {
    const { llm } = stubLlm({ context: "ec-hrt" });
    const result = await makeClassifier({ contexts, llm })({
      question: "What did the team decide about the new recruitment workflow?",
      history: [],
    });
    expect(result).toEqual({ kind: "context", contextId: "ec-hrt" });
  });

  it("passes unclear through", async () => {
    const { llm } = stubLlm({ context: "unclear" });
    expect(await makeClassifier({ contexts, llm })({ question: "How are things?", history: [] })).toEqual({
      kind: "unclear",
    });
  });

  it.each([
    ["an id that isn't a context", { context: "gmail" }],
    ["a missing field", { answer: "personal" }],
    ["a bare string", "personal"],
    ["null", null],
  ])("treats %s as unclear", async (_label, value) => {
    const log = silentLog();
    const { llm } = stubLlm(value);
    expect(await makeClassifier({ contexts, llm, log })({ question: "q", history: [] })).toEqual({ kind: "unclear" });
    expect(log.warn).toHaveBeenCalled();
  });

  it("treats a text reply as unclear", async () => {
    const llm: LlmCall = async () => ok({ ...respond(null), kind: "text", text: "personal" });
    expect(await makeClassifier({ contexts, llm })({ question: "q", history: [] })).toEqual({ kind: "unclear" });
  });

  it.each(["refused", "max_tokens", "rate_limited", "network"] as const)(
    "treats a %s error as unclear and logs only the kind",
    async (kind) => {
      const log = silentLog();
      const llm: LlmCall = async () => err({ kind, message: "x", retryable: false });
      const question = "When is my daughter's birthday?";

      expect(await makeClassifier({ contexts, llm, log })({ question, history: [] })).toEqual({ kind: "unclear" });
      expect(log.warn).toHaveBeenCalledWith("classifier failed, treating as unclear", { kind });
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(question);
    },
  );
});

describe("classifier request", () => {
  it("asks for JSON with every context id plus unclear, at low effort", async () => {
    const { llm, requests } = stubLlm({ context: "personal" });
    await makeClassifier({ contexts, llm })({ question: "Where do I live?", history: [] });

    const request = requests[0];
    expect(request?.effort).toBe("low");
    expect(request?.outputSchema).toEqual(classifierSchema(contexts));
    expect(classifierSchema(contexts).properties).toEqual({
      context: { type: "string", enum: ["personal", "kidclub", "noisysource", "ec-hrt", "unclear"] },
    });
    expect(request?.system).toBe(classifierSystemPrompt(contexts));
  });

  it("describes every context, including that invoicing the EC is Noisy Source", () => {
    const system = classifierSystemPrompt(contexts);
    for (const c of contexts) expect(system).toContain(`- ${c.id} (${c.name}): ${c.description}`);
    expect(system).toContain("including invoicing and billing the European Commission");
  });

  it("sends anything needing no context's data to personal, and clarifies only on ambiguous data requests", () => {
    const system = classifierSystemPrompt(contexts);
    expect(system).toContain(
      `If it needs no context's data, reply "personal". That covers greetings, small talk, thanks, general-knowledge questions and questions about Jarvis itself`,
    );
    expect(system).toContain(
      `Reply "unclear" only when the question needs some context's data and it's ambiguous which`,
    );
    expect(system).not.toContain("Pick a context only when the question clearly belongs to it");
  });

  it("leaves the default rule out when there's no personal context", () => {
    const others = contexts.filter((c) => c.id !== "personal");
    expect(classifierSystemPrompt(others)).not.toContain("If it needs no context's data");
  });

  it("includes only the last few turns of history", () => {
    const history: Turn[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `turn ${i}`,
    }));
    const message = classifierUserMessage("and her birthday?", history);

    expect(message).not.toContain("turn 3");
    expect(message).toContain(`turn ${10 - CLASSIFIER_HISTORY_TURNS}`);
    expect(message).toContain("User: turn 8");
    expect(message).toContain("Jarvis: turn 9");
    expect(message.endsWith("<question>\nand her birthday?\n</question>")).toBe(true);
  });

  it("leaves out the conversation block when there's no history", () => {
    expect(classifierUserMessage("Hi", [])).toBe("<question>\nHi\n</question>");
  });
});

describe("fixtures", () => {
  it("only use real contexts", () => {
    const ids = new Set([...contexts.map((c) => c.id as string), "unclear"]);
    for (const f of fixtures) expect(ids.has(f.expected), f.question).toBe(true);
  });

  it("mark exactly the cases the precheck decides", async () => {
    const { llm, requests } = stubLlm({ context: "unclear" });
    const classify = makeClassifier({ contexts, llm });
    for (const f of fixtures) {
      const before = requests.length;
      await classify({ question: f.question, history: [] });
      expect(requests.length === before, f.question).toBe(f.precheck === true);
    }
  });
});
