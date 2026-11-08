import { describe, expect, it } from "vitest";
import { checkAnswer, IDENTITY_CASES, sentenceCount } from "../scripts/identity-cases.js";

const find = (q: string) => {
  const c = IDENTITY_CASES.find((x) => x.question === q);
  if (!c) throw new Error(q);
  return c;
};

describe("identity eval checks (#88)", () => {
  it("catches Jarvis speaking as the person", () => {
    const code = find("Can you code?");
    expect(checkAnswer(code, "You know I'm a software engineer.")).not.toEqual([]);
    expect(checkAnswer(code, "I can, yes: I can explain code and help find bugs. What are you working on?")).toEqual([]);
    const work = find("What do I do for work?");
    expect(checkAnswer(work, "I run KidClub, don't you know?")).not.toEqual([]);
    expect(checkAnswer(work, "I don't know yet, you haven't told me. What do you do?")).toEqual([]);
    expect(checkAnswer(work, "You're a software engineer.")).toContain("missing /don't know|do not know|haven't (?:told|said|mentioned)|not sure|no idea|tell me/i");
  });

  it("wants a simple intro to \"who are you?\"", () => {
    const who = find("Who are you?");
    expect(checkAnswer(who, "I'm Jarvis, your personal assistant. I can help with questions about you and everyday things.")).toEqual([]);
    expect(checkAnswer(who, "I can't help with your businesses, they're not connected yet.")).not.toEqual([]);
  });

  it("checks the style on every answer: at most 3 sentences, no lists, headings or markdown", () => {
    const hello = find("Hello!");
    expect(checkAnswer(hello, "Hi Alex! Good to hear from you. What can I do for you?")).toEqual([]);
    expect(checkAnswer(hello, "Hi. One. Two. Three.")).toEqual(["4 sentences (at most 3)"]);
    expect(checkAnswer(hello, "Hi!\n- Option one\n- Option two")).toContain("a list or heading");
    expect(checkAnswer(hello, "Hi **Alex**!")).toContain("markdown");
    expect(sentenceCount("Sure. Your passport expires in January… Want a reminder?")).toBe(3);
    expect(sentenceCount("No full stop at the end")).toBe(1);
  });
});
