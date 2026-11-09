import { describe, expect, it } from "vitest";
import { checkAnswer, checkSpoken, firstSentence, IDENTITY_CASES, SENTENCE_LIMIT, sentenceCount, SPOKEN_CASES } from "../scripts/identity-cases.js";

const find = (q: string) => {
  const c = IDENTITY_CASES.find((x) => x.question === q);
  if (!c) throw new Error(q);
  return c;
};
const problems = (q: string, answer: string) => checkAnswer(find(q), answer).problems;

describe("identity eval checks (#88)", () => {
  it("catches Jarvis speaking as the person", () => {
    expect(problems("Can you code?", "You know I'm a software engineer.")).not.toEqual([]);
    expect(problems("Can you code?", "I can, yes: I can explain code and help find bugs. What are you working on?")).toEqual([]);
    expect(problems("What do I do for work?", "I run KidClub, don't you know?")).not.toEqual([]);
    expect(problems("What do I do for work?", "I don't know yet, you haven't told me. What do you do?")).toEqual([]);
    expect(problems("What do I do for work?", "You're a software engineer.")).toContain(
      "missing /don't know|do not know|haven't (?:told|said|mentioned)|not sure|no idea|tell me/i",
    );
  });

  it('wants a simple intro to "who are you?"', () => {
    expect(problems("Who are you?", "I'm Jarvis, your personal assistant. I can help with questions about you and everyday things.")).toEqual([]);
    expect(problems("Who are you?", "I can't help with your businesses, they're not connected yet.")).not.toEqual([]);
  });

  it("wants it to say it can't use a calendar, reminders, notes, email or the web, and never claim it did", () => {
    expect(problems("What's on my calendar today?", "I can't see your calendar yet. Want to talk through your day?")).toEqual([]);
    expect(problems("What's on my calendar today?", "You have a meeting at 10 am and a call at 3 pm.")).not.toEqual([]);
    expect(problems("Remind me to call Sam at five.", "I can't set reminders yet, sorry. Maybe set one on your phone?")).toEqual([]);
    expect(problems("Remind me to call Sam at five.", "Done! I'll remind you at five.")).not.toEqual([]);
    expect(problems("Take a note: buy milk.", "Noted: buy milk.")).not.toEqual([]);
    expect(problems("Send an email to Sam saying I'm running late.", "I've sent it.")).not.toEqual([]);
    expect(problems("Send an email to Sam saying I'm running late.", "I can't send email yet. Want help wording it?")).toEqual([]);
    expect(problems("What's the weather like right now?", "It's 18 degrees and sunny.")).not.toEqual([]);
    expect(problems("What's the weather like right now?", "I can't look that up, I'm afraid. Is it looking nice out?")).toEqual([]);
  });

  it("warns (doesn't fail) on more than 4 sentences, and fails on lists, headings or markdown", () => {
    const hello = find("Hello!");
    expect(checkAnswer(hello, "Hi Alex! Good to hear from you. How's it going? What can I do for you?")).toEqual({ problems: [], warnings: [] });
    expect(checkAnswer(hello, "Hi. One. Two. Three. Four.")).toEqual({ problems: [], warnings: [`5 sentences (more than ${SENTENCE_LIMIT})`] });
    expect(checkAnswer(hello, "Hi!\n- Option one\n- Option two").problems).toContain("a list or heading");
    expect(checkAnswer(hello, "Hi **Alex**!").problems).toContain("markdown");
    expect(sentenceCount("Sure. Your passport expires in January… Want a reminder?")).toBe(3);
    expect(sentenceCount("No full stop at the end")).toBe(1);
  });
});

describe("spoken eval checks (#92)", () => {
  const spoken = (q: string) => {
    const c = SPOKEN_CASES.find((x) => x.question === q);
    if (!c) throw new Error(q);
    return c;
  };
  it("wants a short reaction first, numbers in words, and no quotes or brackets", () => {
    const leap = spoken("How many days are there in a leap year?");
    expect(checkSpoken(leap, "Good question. There are three hundred and sixty-six.", false)).toEqual({ problems: [], warnings: [] });
    expect(checkSpoken(leap, "A leap year has 366 days.", false).problems).toEqual(
      expect.arrayContaining(["opens with 6 words, not a short reaction", "digits"]),
    );
    const five = spoken("Explain black holes like I'm five.");
    expect(checkSpoken(five, "Okay. It's a \"hole\" (sort of) in space.", false).problems).toContain("quotes or brackets");
    expect(checkSpoken(five, "Okay. It's a spot in space. It pulls everything in.", true).warnings).toContain("cut at the sentence limit");
    expect(firstSentence("Hmm… Let me think.")).toBe("Hmm…");
    expect(firstSentence("no end")).toBe("no end");
  });
});
