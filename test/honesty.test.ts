import { describe, expect, it } from "vitest";
import { CANT_YET, honestyCategory, makeHonestyGuard } from "../src/answer/honesty.js";
import type { Logger } from "../src/types.js";
import { DROPPED, KEPT, NOT_THE_GUARDS_JOB } from "./fixtures/honesty-cases.js";

const spyLog = () => {
  const lines: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const log: Logger = {
    info: (message, fields) => void lines.push({ message, fields }),
    warn: (message, fields) => void lines.push({ message, fields }),
    error: (message, fields) => void lines.push({ message, fields }),
  };
  return { log, lines };
};

/** Streams `text` in small pieces; returns the sentences sent on and the result. */
const stream = (text: string, opts: { tool?: "before" | "after" } = {}) => {
  const sent: string[] = [];
  const { log, lines } = spyLog();
  const guard = makeHonestyGuard({ onSentence: (s) => sent.push(s), log });
  if (opts.tool === "before") guard.toolSucceeded();
  for (let i = 0; i < text.length; i += 4) guard.onText(text.slice(i, i + 4));
  const result = guard.finish(text);
  return { sent, result, lines };
};

describe("honesty guard: the test set (#96)", () => {
  it.each(DROPPED)("drops %j (%s)", (sentence, category) => expect(honestyCategory(sentence)).toBe(category));
  it.each(KEPT)("keeps %j", (sentence) => expect(honestyCategory(sentence)).toBeUndefined());
  it.each(NOT_THE_GUARDS_JOB)("leaves %j to the eval", (sentence) => expect(honestyCategory(sentence)).toBeUndefined());
});

describe("honesty guard: a turn (#96)", () => {
  it("drops a false claim before it's sent, and keeps the honest rest", () => {
    const { sent, result } = stream("I can't set reminders yet. But I'll remember to tell you at five. Want to set one on your phone?");
    expect(sent).toEqual(["I can't set reminders yet.", "Want to set one on your phone?"]);
    expect(result).toEqual({
      text: "I can't set reminders yet. Want to set one on your phone?",
      dropped: { claimed_action: 0, promise: 1, perception: 0 },
      replaced: false,
    });
  });

  it('says "I can\'t do that yet." when nothing useful is left', () => {
    expect(stream("Done! I'll remind you at five.")).toMatchObject({ sent: [CANT_YET], result: { text: CANT_YET, replaced: true } });
    // A reaction already spoken stays; the honest line follows it.
    expect(stream("Sure. I've added it to your calendar.")).toMatchObject({
      sent: ["Sure.", CANT_YET],
      result: { text: `Sure. ${CANT_YET}`, replaced: true },
    });
  });

  it("lets claims through when a tool ran and succeeded this turn", () => {
    const { sent, result } = stream("Done. I've added Dentist on Tuesday at ten.", { tool: "before" });
    expect(sent).toEqual(["Done.", "I've added Dentist on Tuesday at ten."]);
    expect(result).toMatchObject({ text: "Done. I've added Dentist on Tuesday at ten.", replaced: false });
  });

  it("changes nothing, and logs nothing, when nothing is wrong", () => {
    const text = "Okay.\n\nA black hole is very heavy. Nothing gets out, not even light.";
    const { sent, result, lines } = stream(text);
    expect(sent).toEqual(["Okay.", "A black hole is very heavy.", "Nothing gets out, not even light."]);
    expect(result.text).toBe(text); // the original text, line breaks and all
    expect(lines).toEqual([]);
  });

  it("checks a whole answer when nothing was streamed (typed, no stream)", () => {
    const { log } = spyLog();
    const guard = makeHonestyGuard({ log });
    expect(guard.finish("You look tired.\n\nWant to take a break? I'll remind you in an hour.")).toEqual({
      text: "Want to take a break?",
      dropped: { claimed_action: 0, promise: 1, perception: 1 },
      replaced: false,
    });
  });

  it("logs the categories and counts only, never the text", () => {
    const { lines } = stream("Sure. I've sent the email to Sam about the dentist. You look tired.");
    expect(lines).toEqual([{ message: "honesty guard", fields: { claimedAction: 1, promise: 0, perception: 1, replaced: true } }]);
    expect(JSON.stringify(lines)).not.toMatch(/Sam|dentist|email|tired/);
  });
});
