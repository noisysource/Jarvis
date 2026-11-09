import { describe, expect, it } from "vitest";
import { asksForDetail, barePrompt, isReaction, makeBareAnswerer, makeSentenceCap } from "../src/answer/bare.js";
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
    expect(requests[0]?.thinking).toBe("off"); // a conversation: no thinking first (#76)
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

describe("spoken style in bare mode (#92)", () => {
  it("asks for a tiny reaction first, a short reply, and words that read well aloud", () => {
    const p = barePrompt("Alex", { spoken: true });
    expect(p).toContain("Start with a very short reaction of one to three words, as its own sentence");
    expect(p).toContain("Then at most two or three short sentences, unless they ask for detail");
    expect(p).toContain("Even for 'explain like I'm five', keep it that short");
    expect(p).toContain("contractions");
    expect(p).toContain("Write numbers and times in words");
    expect(p).toContain("No quotes, brackets, lists");
    expect(p).toContain("What you can do right now: only talk."); // the abilities stay
    expect(barePrompt("Alex", { spoken: true, maxSentences: 1 })).toContain("Then at most one sentence");
    expect(barePrompt("Alex")).not.toContain("spoken aloud"); // typed keeps its own style
  });

  it("knows a reaction and a request for detail", () => {
    for (const r of ["Okay.", "Good question.", "Oh, nice!", "Hmm…"]) expect(isReaction(r), r).toBe(true);
    for (const r of ["Okay", "A black hole is a place in space.", ""]) expect(isReaction(r), r).toBe(false);
    expect(asksForDetail("Explain black holes in detail")).toBe(true);
    expect(asksForDetail("Tell me more about that")).toBe(true);
    expect(asksForDetail("Walk me through it step by step")).toBe(true);
    expect(asksForDetail("Explain black holes like I'm five")).toBe(false);
  });

  it("cuts after the limit; the reaction doesn't count, and nothing past the limit is passed on", () => {
    const cap = makeSentenceCap(2);
    const out: string[] = [];
    let done = false;
    for (const d of ["Okay. ", "A black hole is", " very heavy. Nothing", " gets out. Not even", " light. So it's dark."]) {
      const step = cap.feed(d);
      out.push(step.text);
      done = step.done;
      if (done) break;
    }
    expect(done).toBe(true);
    expect(out.join("")).toBe("Okay. A black hole is very heavy. Nothing gets out.");
    expect(cap.text()).toBe("Okay. A black hole is very heavy. Nothing gets out.");
    expect(cap.feed("More.")).toEqual({ text: "", done: true });
    // Without a reaction, the first sentence counts.
    const plain = makeSentenceCap(1);
    expect(plain.feed("Black holes are dark. Really dark.")).toEqual({ text: "Black holes are dark.", done: true });
  });

  const speaking = (deltas: string[]) => {
    const requests: LlmRequest[] = [];
    let aborted = false;
    const llm: LlmCall = Object.assign(async () => reply("unused"), {
      stream: (r: LlmRequest, signal?: AbortSignal) => {
        requests.push(r);
        signal?.addEventListener("abort", () => (aborted = true));
        return streamedFrom(deltas, reply(deltas.join("")));
      },
    });
    return { llm, requests, aborted: () => aborted };
  };
  const seven = ["Okay. ", "One. ", "Two. ", "Three. ", "Four. ", "Five. ", "Six. ", "Seven."];

  it("speaks at most the limit, stops the model there, and keeps only what was said", async () => {
    const { llm, requests, aborted } = speaking(seven);
    const deltas: string[] = [];
    const answer = makeBareAnswerer({ llm, userName: "Alex", spokenSentences: 3 });
    const result = await answer({ context: personal, question: "Explain black holes like I'm five", history: [], memories: [], now: new Date(), spoken: true, onText: (d) => deltas.push(d) });
    expect(requests[0]?.system).toBe(barePrompt("Alex", { spoken: true, maxSentences: 3 }));
    expect(deltas.join("")).toBe("Okay. One. Two. Three.");
    expect(result).toEqual(ok({ kind: "answer", text: "Okay. One. Two. Three." }));
    expect(aborted()).toBe(true);
  });

  it("doesn't cut when they ask for detail, or when it's typed", async () => {
    const detail = speaking(seven);
    const r1 = await makeBareAnswerer({ llm: detail.llm })({ context: personal, question: "Tell me more, in detail", history: [], memories: [], now: new Date(), spoken: true, onText: () => undefined });
    expect(r1).toEqual(ok({ kind: "answer", text: seven.join("") }));
    const typed = speaking(seven);
    const r2 = await makeBareAnswerer({ llm: typed.llm })({ context: personal, question: "Hi", history: [], memories: [], now: new Date(), onText: () => undefined });
    expect(r2).toEqual(ok({ kind: "answer", text: seven.join("") }));
    expect(typed.requests[0]?.system).toBe(barePrompt(undefined));
  });
});
