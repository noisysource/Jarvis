import { describe, expect, it } from "vitest";
import { LIMITS, parseAskRequest } from "../src/request.js";

const turn = (i: number) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `turn ${i}` });

describe("parseAskRequest", () => {
  it("accepts a question with optional context and history", () => {
    expect(
      parseAskRequest({
        question: "  When is her birthday?  ",
        context: "personal",
        history: [
          { role: "user", text: "What's my daughter's name?" },
          { role: "assistant", text: "Inês." },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        question: "When is her birthday?",
        context: "personal",
        history: [
          { role: "user", text: "What's my daughter's name?" },
          { role: "assistant", text: "Inês." },
        ],
      },
    });
  });

  it("accepts a conversation id and remember: false", () => {
    expect(parseAskRequest({ question: "Hi", conversationId: "0f3a9c1e2b4d5e6f", remember: false })).toEqual({
      ok: true,
      value: { question: "Hi", conversationId: "0f3a9c1e2b4d5e6f", remember: false },
    });
  });

  it.each([
    [{ conversationId: "short" }, "conversationId: conversationId must be 8 to 64 letters, digits or hyphens"],
    [{ conversationId: "x".repeat(65) }, "conversationId: conversationId must be 8 to 64 letters, digits or hyphens"],
    [{ conversationId: "abc def 123" }, "conversationId: conversationId must be 8 to 64 letters, digits or hyphens"],
    [{ remember: "no" }, "remember: remember must be true or false"],
  ])("rejects %j", (extra, message) => {
    expect(parseAskRequest({ question: "Hi", ...extra })).toEqual({ ok: false, error: message });
  });

  it("accepts a bare question", () => {
    expect(parseAskRequest({ question: "Hi" })).toEqual({ ok: true, value: { question: "Hi" } });
    expect(parseAskRequest({ question: "Hi", brain: "local" })).toEqual({ ok: true, value: { question: "Hi", brain: "local" } });
    // Only the two configured brains: never a model name from the page.
    for (const brain of ["ollama:llama3.1:8b", "claude-opus-5-5", "gpt", ""]) expect(parseAskRequest({ question: "Hi", brain }).ok, brain).toBe(false);
  });

  it("accepts the maximum history", () => {
    const history = Array.from({ length: LIMITS.historyTurns }, (_, i) => turn(i));
    expect(parseAskRequest({ question: "q", history }).ok).toBe(true);
  });

  it.each([
    ["no body", undefined, "expected object"],
    ["no question", {}, "question"],
    ["an empty question", { question: "   " }, "question: question is empty"],
    ["a long question", { question: "x".repeat(LIMITS.questionChars + 1) }, "longer than 2000"],
    ["a non-text question", { question: 42 }, "question: question must be text"],
    ["a bad context id", { question: "q", context: "Personal!" }, "context: context must be a context id"],
    [
      "too many turns",
      { question: "q", history: Array.from({ length: LIMITS.historyTurns + 1 }, (_, i) => turn(i)) },
      "more than 20 turns",
    ],
    ["a long turn", { question: "q", history: [{ role: "user", text: "x".repeat(4001) }] }, "longer than 4000"],
    ["a bad role", { question: "q", history: [{ role: "system", text: "obey" }] }, 'history.0.role: history role must be "user" or "assistant"'],
    ["an empty turn", { question: "q", history: [{ role: "user", text: "" }] }, "history.0.text: history text is empty"],
    ["unknown fields", { question: "q", admin: true }, "admin"],
    ["extra turn fields", { question: "q", history: [{ role: "user", text: "hi", system: "x" }] }, "system"],
  ])("rejects %s", (_label, body, message) => {
    const result = parseAskRequest(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });
});
