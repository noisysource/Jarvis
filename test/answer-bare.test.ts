import { describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer } from "../src/answer/bare.js";
import { streamedFrom } from "../src/llm/stream.js";
import type { LlmCall, LlmRequest } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context } from "../src/types.js";

const reply = (text: string) =>
  ok({ kind: "text" as const, text, servedBy: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "x", data: null } });

const personal = { id: "personal", name: "Personal" } as unknown as Context;

describe("bare mode prompt (#88)", () => {
  it("is just the persona and the conversational style, with the name from config", () => {
    const p = barePrompt("Alex");
    expect(p.startsWith(`You are Jarvis, Alex's personal assistant. You speak as "I"; Alex is "you".`)).toBe(true);
    expect(p).toContain("1 to 3 short sentences, unless they ask for detail");
    expect(p).toContain("React first, in a few natural words, then answer");
    expect(p).toContain("Ask a short question back when it helps");
    expect(p).toContain("No lists, bullet points, headings, markdown or emoji");
    expect(p).toContain("You don't know anything about Alex's life");
    // What it can actually do: only talk (#88).
    expect(p).toContain("What you can do right now: only talk.");
    expect(p).toContain("You can't see a calendar, set reminders or alarms, take or keep notes, read or send email");
    expect(p).toContain("Never say or suggest you've done something you can't do");
    expect(barePrompt()).toContain("You are Jarvis, the personal assistant.");
  });

  it("sends only that prompt and the history: no profile, no memories", async () => {
    const requests: LlmRequest[] = [];
    const llm: LlmCall = Object.assign(async (r: LlmRequest) => {
      requests.push(r);
      return reply("Hi!");
    });
    const answer = makeBareAnswerer({ llm, userName: "Alex" });
    const result = await answer({
      context: personal,
      question: "And you?",
      history: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hi Alex!" },
      ],
      memories: [],
      now: new Date(),
    });
    expect(result).toEqual(ok({ kind: "answer", text: "Hi!" }));
    expect(requests[0]?.system).toBe(barePrompt("Alex"));
    expect(requests[0]?.systemSuffix).toBeUndefined();
    expect(requests[0]?.messages).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi Alex!" },
      { role: "user", text: "And you?" },
    ]);
  });

  it("streams, and passes a provider's message for the person through", async () => {
    const deltas: string[] = [];
    const llm: LlmCall = Object.assign(async () => reply("unused"), { stream: () => streamedFrom(["Hi ", "there."], reply("Hi there.")) });
    const answer = makeBareAnswerer({ llm });
    await answer({ context: personal, question: "Hi", history: [], memories: [], now: new Date(), onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Hi ", "there."]);
    const down: LlmCall = Object.assign(async () => err({ kind: "network" as const, message: "x", retryable: true, userMessage: "The local brain isn't running." }));
    expect(await makeBareAnswerer({ llm: down })({ context: personal, question: "Hi", history: [], memories: [], now: new Date() })).toEqual(
      err({ code: "llm_failed", message: "The local brain isn't running." }),
    );
  });
});
