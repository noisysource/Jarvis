import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  LIMITS,
  appendTurn,
  buildAskBody,
  matchContextOption,
  nameWords,
  parseLanguage,
  pickVoice,
  replyView,
  viewFromHttp,
} from "../src/web/chat.js";

describe("languages", () => {
  it("defaults to English and toggles to pt-PT", () => {
    expect(parseLanguage(null)).toBe("en");
    expect(parseLanguage("fr")).toBe("en");
    expect(parseLanguage("pt")).toBe("pt");
    expect(LANGUAGES.en.speech).toBe("en-GB");
    expect(LANGUAGES.pt.speech).toBe("pt-PT");
  });
});

describe("appendTurn", () => {
  it("keeps the last 20 turns and caps each at 4000 chars", () => {
    let history: ReturnType<typeof appendTurn> = [];
    for (let i = 0; i < 25; i += 1) history = appendTurn(history, i % 2 === 0 ? "user" : "assistant", `t${i}`);
    expect(history).toHaveLength(LIMITS.historyTurns);
    expect(history[0]?.text).toBe("t5");
    expect(appendTurn([], "user", "x".repeat(5000))[0]?.text).toHaveLength(4000);
  });

  it("doesn't change the original history", () => {
    const history = [{ role: "user" as const, text: "a" }];
    appendTurn(history, "assistant", "b");
    expect(history).toHaveLength(1);
  });
});

describe("buildAskBody", () => {
  it("sends only what's set", () => {
    expect(buildAskBody({ question: "  hi  ", history: [] })).toEqual({ question: "hi" });
    expect(
      buildAskBody({ question: "And her birthday?", context: "personal", history: [{ role: "user", text: "Name?" }] }),
    ).toEqual({ question: "And her birthday?", context: "personal", history: [{ role: "user", text: "Name?" }] });
  });
});

describe("replyView", () => {
  it("shows and speaks answers, unavailable and handoff replies, and remembers them", () => {
    expect(replyView({ type: "answer", context: "personal", answer: "2 September." })).toEqual({
      kind: "answer",
      text: "2 September.",
      speak: "2 September.",
      options: [],
      remember: true,
    });
    const unavailable = replyView({ type: "unavailable", context: "kidclub", message: "KidClub isn't connected yet." });
    expect(unavailable).toMatchObject({ kind: "unavailable", speak: "KidClub isn't connected yet.", remember: true });
    const handoff = replyView({ type: "handoff", context: "ec-hrt", to: "Kiro", message: "This is for Kiro." });
    expect(handoff).toMatchObject({ kind: "handoff", speak: "This is for Kiro.", remember: true });
  });

  it("speaks a clarify with its options but doesn't remember it", () => {
    const options = [{ id: "personal", name: "Personal" }];
    expect(replyView({ type: "clarify", message: "Which?", options })).toEqual({
      kind: "clarify",
      text: "Which?",
      speak: "Which?",
      options,
      remember: false,
    });
  });

  it("shows errors without speaking or remembering them", () => {
    expect(replyView({ type: "error", message: "Sorry." })).toMatchObject({ kind: "error", speak: null, remember: false });
  });
});

describe("viewFromHttp", () => {
  it("reads a known reply", () => {
    expect(viewFromHttp(200, { type: "answer", context: "personal", answer: "Hi" }).kind).toBe("answer");
    expect(viewFromHttp(400, { type: "error", message: "question: question is empty" }).text).toBe(
      "question: question is empty",
    );
  });

  it("turns anything else into an error", () => {
    expect(viewFromHttp(502, null)).toMatchObject({ kind: "error", text: "Sorry, the server answered with status 502." });
    expect(viewFromHttp(200, { type: "surprise" }).kind).toBe("error");
  });
});

describe("pickVoice", () => {
  const voices = [{ lang: "en-US" }, { lang: "pt_BR" }, { lang: "pt-PT" }, { lang: "en-GB" }];
  it("prefers an exact match, then the same language", () => {
    expect(pickVoice(voices, "pt-PT")).toEqual({ lang: "pt-PT" });
    expect(pickVoice(voices, "en-GB")).toEqual({ lang: "en-GB" });
    expect(pickVoice([{ lang: "pt_BR" }], "pt-PT")).toEqual({ lang: "pt_BR" });
    expect(pickVoice([{ lang: "fr-FR" }], "pt-PT")).toBeUndefined();
  });
});

describe("matchContextOption (typed or spoken pick after a clarify)", () => {
  const options = [
    { id: "personal", name: "Personal", aliases: ["pessoal", "me", "myself"] },
    { id: "kidclub", name: "KidClub" },
    { id: "noisysource", name: "Noisy Source" },
  ];
  const picked = (reply: string) => matchContextOption(reply, options)?.id;

  it.each([
    ["kidclub", "kidclub"],
    ["KidClub", "kidclub"],
    ["kid club", "kidclub"],
    ["  Kid-Club! ", "kidclub"],
    ["KÍDCLUB", "kidclub"],
    ["personal", "personal"],
    ["Personal.", "personal"],
    ["pessoal", "personal"],
    ["a pessoal", "personal"],
    ["Pessoál", "personal"],
    ["me", "personal"],
    ["the personal", "personal"],
    ["noisy source", "noisysource"],
    ["Noisy Source", "noisysource"],
    ["noisysource", "noisysource"],
    ["it's KidClub", "kidclub"],
    ["é a KidClub", "kidclub"],
    ["about noisy source", "noisysource"],
  ])("%j picks %s", (reply, id) => {
    expect(picked(reply)).toBe(id);
  });

  it.each([
    "check the kidclub invoices",
    "kidclub invoices",
    "hello",
    "the",
    "a",
    "",
    "   ",
    "noisy",
    "personal stuff please",
  ])("%j is a new question, not a pick", (reply) => {
    expect(picked(reply)).toBeUndefined();
  });

  it("only offers what the clarify offered", () => {
    expect(matchContextOption("noisy source", [{ id: "personal", name: "Personal" }])).toBeUndefined();
  });

  it("normalises names to words", () => {
    expect(nameWords("Kid-Club! Comissão")).toEqual(["kid", "club", "comissao"]);
  });
});
