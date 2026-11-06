// @ts-check
// Pure logic for the chat page: no DOM, no network, so it can be unit-tested.
// app.js wires it to the page, the microphone and speech.

/** Same limits as the server (src/request.ts). */
export const LIMITS = { historyTurns: 20, turnChars: 4000, questionChars: 2000 };

/** Speech languages: English by default, Portuguese (Portugal) as the alternative. */
export const LANGUAGES = {
  en: { label: "English", speech: "en-GB" },
  pt: { label: "Português", speech: "pt-PT" },
};
export const DEFAULT_LANGUAGE = "en";

/** @param {unknown} value @returns {"en" | "pt"} */
export const parseLanguage = (value) => (value === "pt" ? "pt" : DEFAULT_LANGUAGE);

/**
 * @typedef {{ role: "user" | "assistant", text: string }} Turn
 * @typedef {{ id: string, name: string, aliases?: string[] }} ContextOption
 * @typedef {
 *   | { type: "answer", context: string, answer: string }
 *   | { type: "unavailable", context: string, message: string }
 *   | { type: "handoff", context: string, to: string, message: string }
 *   | { type: "clarify", message: string, options: ContextOption[] }
 *   | { type: "error", message: string }
 * } AskResponse
 * @typedef {{
 *   kind: "answer" | "unavailable" | "handoff" | "clarify" | "error",
 *   text: string,
 *   speak: string | null,
 *   options: ContextOption[],
 *   remember: boolean,
 * }} ReplyView
 */

/**
 * Adds a turn, keeping only the most recent turns the server accepts.
 * @param {readonly Turn[]} history @param {Turn["role"]} role @param {string} text @returns {Turn[]}
 */
export const appendTurn = (history, role, text) =>
  [...history, { role, text: text.slice(0, LIMITS.turnChars) }].slice(-LIMITS.historyTurns);

/**
 * The POST /ask body.
 * @param {{ question: string, context?: string, history: readonly Turn[] }} input
 */
export const buildAskBody = ({ question, context, history }) => ({
  question: question.trim().slice(0, LIMITS.questionChars),
  ...(context ? { context } : {}),
  ...(history.length > 0 ? { history: [...history] } : {}),
});

/**
 * How a reply is shown and spoken. `remember` says whether the exchange goes
 * into the conversation history: a clarify doesn't (the question is resent
 * with the picked context), and neither does an error.
 * @param {AskResponse} response @returns {ReplyView}
 */
export const replyView = (response) => {
  switch (response.type) {
    case "answer":
      return { kind: "answer", text: response.answer, speak: response.answer, options: [], remember: true };
    case "unavailable":
      return { kind: "unavailable", text: response.message, speak: response.message, options: [], remember: true };
    case "handoff":
      return { kind: "handoff", text: response.message, speak: response.message, options: [], remember: true };
    case "clarify":
      return { kind: "clarify", text: response.message, speak: response.message, options: response.options, remember: false };
    case "error":
      return { kind: "error", text: response.message, speak: null, options: [], remember: false };
    default:
      return { kind: "error", text: "Sorry, I got a reply I don't understand.", speak: null, options: [], remember: false };
  }
};

/**
 * Reads the server's reply; a non-JSON or unexpected body becomes an error view.
 * @param {number} status @param {unknown} body @returns {ReplyView}
 */
export const viewFromHttp = (status, body) => {
  const known = ["answer", "unavailable", "handoff", "clarify", "error"];
  if (typeof body === "object" && body !== null && "type" in body && known.includes(String(body.type))) {
    return replyView(/** @type {AskResponse} */ (body));
  }
  return replyView({ type: "error", message: `Sorry, the server answered with status ${status}.` });
};

/** Words people put in front of a context name when answering "which one?" ("a pessoal", "it's KidClub"). */
const FILLER_WORDS = new Set(["a", "o", "the", "its", "it", "s", "is", "e", "about", "para", "sobre", "do", "da", "de"]);

/**
 * Lowercase, accents removed, split into words on anything that isn't a
 * letter or digit. "Kid-Club!" → ["kid", "club"].
 * @param {string} text @returns {string[]}
 */
export const nameWords = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

/** @param {string} text */
const squash = (text) => nameWords(text).join("");

/**
 * After a clarify: if the whole reply names one of the offered contexts (its
 * name, id or an alias), return it; otherwise it's a new question. Case,
 * accents, spaces and punctuation don't matter, and leading filler words are
 * ignored. Matched locally, with no model call.
 * @param {string} reply @param {readonly ContextOption[]} options
 * @returns {ContextOption | undefined}
 */
export const matchContextOption = (reply, options) => {
  const words = nameWords(reply);
  // Drop leading filler words, but never the last word ("a" on its own isn't a pick).
  while (words.length > 1 && FILLER_WORDS.has(words[0] ?? "")) words.shift();
  const said = words.join("");
  if (said === "") return undefined;
  const matches = options.filter((o) =>
    [o.name, o.id, ...(o.aliases ?? [])].some((n) => squash(n) === said),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * Picks a voice for the language: an exact match, then same language, else none (browser default).
 * @param {readonly { lang: string }[]} voices @param {string} speechLang
 */
export const pickVoice = (voices, speechLang) => {
  const want = speechLang.toLowerCase();
  const base = want.split("-")[0] ?? want;
  return (
    voices.find((v) => v.lang.toLowerCase() === want) ??
    voices.find((v) => v.lang.toLowerCase().replace("_", "-").split("-")[0] === base)
  );
};
