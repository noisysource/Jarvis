import { describe, expect, it } from "vitest";
import {
  CONVERSATION,
  LANGUAGES,
  LIMITS,
  appendTurn,
  badgeText,
  buildAskBody,
  formatMemoryDay,
  groupMemories,
  isStopPhrase,
  matchContextOption,
  nameWords,
  newConversationId,
  parseLanguage,
  pickVoice,
  replyView,
  shouldReopenMic,
  unseenIds,
  viewFromHttp,
  voiceKey,
  voiceQuality,
  voicesFor,
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

describe("conversation ids", () => {
  it("sends the conversation id, and remember only when it's false", () => {
    expect(buildAskBody({ question: "hi", history: [], conversationId: "abcdef12" })).toEqual({
      question: "hi",
      conversationId: "abcdef12",
    });
    expect(buildAskBody({ question: "hi", history: [], remember: false })).toEqual({ question: "hi", remember: false });
    expect(buildAskBody({ question: "hi", history: [], remember: true })).toEqual({ question: "hi" });
  });

  it("marks spoken turns, with the sticky context only for spoken turns without a picked context (#76)", () => {
    expect(buildAskBody({ question: "hi", history: [], spoken: true, stickyContext: "personal" })).toEqual({
      question: "hi",
      spoken: true,
      stickyContext: "personal",
    });
    expect(buildAskBody({ question: "hi", history: [], spoken: false, stickyContext: "personal" })).toEqual({ question: "hi" });
    expect(buildAskBody({ question: "hi", history: [], spoken: true, context: "kidclub", stickyContext: "personal" })).toEqual({
      question: "hi",
      context: "kidclub",
      spoken: true,
    });
  });

  it("makes 32 hex characters from 16 random bytes", () => {
    const id = newConversationId((n) => Uint8Array.from({ length: n }, (_, i) => i * 17));
    expect(id).toBe("00112233445566778899aabbccddeeff");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
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

describe("voices", () => {
  const installed = [
    { name: "Samantha", lang: "en-US", default: true },
    { name: "Daniel", lang: "en-GB" },
    { name: "Serena (Premium)", lang: "en-GB" },
    { name: "Kate (Enhanced)", lang: "en-GB" },
    { name: "Google UK English Female", lang: "en-GB" },
    { name: "Microsoft Sonia Online (Natural) - English (United Kingdom)", lang: "en-GB" },
    { name: "Joana", lang: "pt-PT" },
    { name: "Joana (Melhorada)", lang: "pt_PT" },
    { name: "Luciana (Enhanced)", lang: "pt-BR" },
    { name: "Amélie", lang: "fr-CA" },
  ];
  const names = (lang: string) => voicesFor(installed, lang).map((v) => v.name);

  it("rates names: Premium > Enhanced > Natural/Neural/Online > others", () => {
    expect(voiceQuality("Serena (Premium)")).toBe(3);
    expect(voiceQuality("Kate (Enhanced)")).toBe(2);
    expect(voiceQuality("Joana (Melhorada)")).toBe(2);
    expect(voiceQuality("Microsoft Sonia Online (Natural)")).toBe(1);
    expect(voiceQuality("Daniel")).toBe(0);
  });

  it("lists this language's voices, exact region first, then best quality", () => {
    expect(names("en-GB")).toEqual([
      "Serena (Premium)",
      "Kate (Enhanced)",
      "Microsoft Sonia Online (Natural) - English (United Kingdom)",
      "Daniel",
      "Google UK English Female",
      "Samantha",
    ]);
    expect(names("pt-PT")).toEqual(["Joana (Melhorada)", "Joana", "Luciana (Enhanced)"]);
    expect(names("de-DE")).toEqual([]);
  });

  it("picks the best voice automatically", () => {
    expect(pickVoice(installed, "en-GB")?.name).toBe("Serena (Premium)");
    expect(pickVoice(installed, "pt-PT")?.name).toBe("Joana (Melhorada)");
    expect(pickVoice([{ name: "Luciana", lang: "pt-BR" }], "pt-PT")?.name).toBe("Luciana");
    expect(pickVoice(installed, "de-DE")).toBeUndefined();
  });

  it("uses the remembered voice when it's still installed for this language", () => {
    expect(pickVoice(installed, "en-GB", "Daniel")?.name).toBe("Daniel");
    expect(pickVoice(installed, "en-GB", "Uninstalled Voice")?.name).toBe("Serena (Premium)");
    expect(pickVoice(installed, "en-GB", "Joana")?.name).toBe("Serena (Premium)"); // wrong language
    expect(pickVoice(installed, "en-GB", null)?.name).toBe("Serena (Premium)");
  });

  it("remembers the voice per language", () => {
    expect(voiceKey("en")).toBe("jarvis.voice.en");
    expect(voiceKey("pt")).toBe("jarvis.voice.pt");
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

describe("conversation mode", () => {
  it.each([
    "that's all",
    "That's all.",
    "that is all",
    "Stop",
    "stop!",
    "stop listening",
    "obrigado",
    "Obrigada",
    "muito obrigado",
    "é tudo",
    "É tudo.",
    "e tudo",
    "thanks, that's all",
    "OK, that's all, thank you",
    "obrigado, é tudo",
    "é tudo, obrigado",
    "Jarvis, stop",
    "ok stop",
  ])("%j stops listening", (text) => {
    expect(isStopPhrase(text)).toBe(true);
  });

  it.each([
    "stop the music",
    "don't stop",
    "is that all?",
    "that's all I wanted to know about her birthday",
    "obrigado pela ajuda, e agora a fatura?",
    "thank you",
    "thanks",
    "ok",
    "",
    "tudo bem?",
  ])("%j is a normal question", (text) => {
    expect(isStopPhrase(text)).toBe(false);
  });

  const reopen = {
    conversation: true,
    voiceSession: true,
    blocked: false,
    available: true,
    kind: "answer" as const,
  };

  it("reopens the mic only in a spoken conversation with conversation mode on", () => {
    expect(shouldReopenMic(reopen)).toBe(true);
    for (const kind of ["unavailable", "handoff", "clarify"] as const) expect(shouldReopenMic({ ...reopen, kind })).toBe(true);
    expect(shouldReopenMic({ ...reopen, conversation: false })).toBe(false);
    expect(shouldReopenMic({ ...reopen, voiceSession: false })).toBe(false); // typed question
    expect(shouldReopenMic({ ...reopen, blocked: true })).toBe(false); // browser blocked it: use the button
    expect(shouldReopenMic({ ...reopen, available: false })).toBe(false);
    expect(shouldReopenMic({ ...reopen, kind: "error" })).toBe(false);
  });

  it("listens for about 8 seconds of silence before giving up", () => {
    expect(CONVERSATION.silenceMs).toBe(8000);
  });
});

describe("memories panel helpers", () => {
  const m = (id: string, contextId: string, kind: "fact" | "playbook" | "history", seen = true) => ({
    id,
    contextId,
    contextName: contextId === "kidclub" ? "KidClub" : "Personal",
    kind,
    text: `text ${id}`,
    origin: "auto" as const,
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:00:00.000Z",
    seen,
  });
  const contexts = [
    { id: "personal", name: "Personal" },
    { id: "kidclub", name: "KidClub" },
    { id: "noisysource", name: "Noisy Source" },
  ];

  it("groups by context in the given order, then by kind, leaving out empty groups", () => {
    const groups = groupMemories([m("1", "kidclub", "playbook"), m("2", "personal", "history"), m("3", "personal", "fact")], contexts);
    expect(groups.map((g) => [g.contextName, g.count, g.kinds.map((k) => [k.label, k.items.map((i) => i.id)])])).toEqual([
      ["Personal", 2, [["Facts", ["3"]], ["Recent conversations", ["2"]]]],
      ["KidClub", 1, [["How you like things done", ["1"]]]],
    ]);
    expect(groupMemories([], contexts)).toEqual([]);
  });

  it("still shows memories of a context it wasn't told about", () => {
    expect(groupMemories([m("1", "oldctx", "fact")], contexts).map((g) => g.contextId)).toEqual(["oldctx"]);
  });

  it("finds unseen ids and makes the badge text", () => {
    expect(unseenIds([m("1", "personal", "fact", false), m("2", "personal", "fact")])).toEqual(["1"]);
    expect([0, 1, 9, 10, 42].map(badgeText)).toEqual(["", "1", "9", "9+", "9+"]);
  });

  it("formats the day in the page's language", () => {
    expect(formatMemoryDay("2026-11-07T10:00:00.000Z", "en")).toBe("7 Nov 2026");
    expect(formatMemoryDay("2026-11-07T10:00:00.000Z", "pt")).toBe("7 de novembro de 2026");
  });
});
