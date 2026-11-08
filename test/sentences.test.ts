import { describe, expect, it } from "vitest";
import { makeSentenceSplitter, splitSentences } from "../src/sentences.js";

const en = { language: "en" as const };
const split = (text: string) => splitSentences(text, en);

describe("splitSentences (English)", () => {
  it.each([
    ["Hello! How can I help today?", ["Hello!", "How can I help today?"]],
    ["It's 2 September. She'll be 9.", ["It's 2 September.", "She'll be 9."]],
    ["Wait... really? Yes!", ["Wait...", "really?", "Yes!"]],
    ["Dr. Marta Silva is your doctor. She's at the Centro de Saúde.", ["Dr. Marta Silva is your doctor.", "She's at the Centro de Saúde."]],
    ["Pack light, e.g. a jacket and shoes. Then go.", ["Pack light, e.g. a jacket and shoes.", "Then go."]],
    ["It costs 3.5 euros. Cheap.", ["It costs 3.5 euros.", "Cheap."]],
    ["The gym is at 7:30 a.m. on Mondays. Don't be late.", ["The gym is at 7:30 a.m. on Mondays.", "Don't be late."]],
    ["J. R. R. Tolkien wrote it. Great book.", ["J. R. R. Tolkien wrote it.", "Great book."]],
    ['She said "Hi." Then she left.', ['She said "Hi."', "Then she left."]],
    ["(It's cheap.) Buy it.", ["(It's cheap.)", "Buy it."]],
    ["See example.com for more. Thanks.", ["See example.com for more.", "Thanks."]],
    ["Two steps:\n1. Open it.\n2. Close it.", ["Two steps:\n1. Open it.", "2. Close it."]],
    ["First part\n\nSecond part", ["First part", "Second part"]],
    ["No full stop at the end", ["No full stop at the end"]],
    ["", []],
  ])("%j", (text, expected) => expect(split(text)).toEqual(expected));

  it("gives the same sentences however the text arrives", () => {
    const text =
      "Hello! Dr. Silva says it's 3.5 km away, e.g. a short walk. Is that OK? \"Yes,\" she said. (Probably.)\n\nNew paragraph... done";
    const whole = split(text);
    for (const size of [1, 2, 3, 5, 7, 11, 40]) {
      const splitter = makeSentenceSplitter(en);
      const out: string[] = [];
      for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
      out.push(...splitter.flush());
      expect(out, `chunk size ${size}`).toEqual(whole);
    }
  });

  it("emits a sentence as soon as the next text shows it's over", () => {
    const splitter = makeSentenceSplitter(en);
    expect(splitter.push("Hello there")).toEqual([]);
    expect(splitter.push(".")).toEqual([]); // could still be "e.g." or "3.5"
    expect(splitter.push(" How")).toEqual(["Hello there."]);
    expect(splitter.push(" are you?")).toEqual([]);
    expect(splitter.flush()).toEqual(["How are you?"]);
  });

  it("cuts a long first sentence at a clause while it's still arriving, so speech can start sooner", () => {
    const long =
      "Your daughter Inês was born on 2 September 2017, which makes her nine years old today, and her next birthday is in about ten months. Anything else?";
    const splitter = makeSentenceSplitter({ language: "en", firstClauseAfter: 80 });
    const out: string[] = [];
    for (let i = 0; i < long.length; i += 10) out.push(...splitter.push(long.slice(i, i + 10)));
    out.push(...splitter.flush());
    expect(out).toEqual([
      "Your daughter Inês was born on 2 September 2017,",
      "which makes her nine years old today, and her next birthday is in about ten months.",
      "Anything else?",
    ]);
  });

  it("keeps a long first sentence whole when it has already ended", () => {
    const long = "Your daughter Inês was born on 2 September 2017, which makes her nine years old today. Anything else?";
    expect(splitSentences(long, { language: "en", firstClauseAfter: 40 })).toEqual([
      "Your daughter Inês was born on 2 September 2017, which makes her nine years old today.",
      "Anything else?",
    ]);
  });

  it("never cuts a later sentence at a clause", () => {
    const out = splitSentences(`Hi. ${"word, ".repeat(40)}end.`, { language: "en", firstClauseAfter: 40 });
    expect(out).toHaveLength(2);
  });
});
