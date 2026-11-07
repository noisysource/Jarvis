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
 * The POST /ask body. `conversationId` groups this conversation's history
 * memory on the server; `remember: false` is "don't remember this".
 * @param {{ question: string, context?: string, history: readonly Turn[], conversationId?: string, remember?: boolean }} input
 */
export const buildAskBody = ({ question, context, history, conversationId, remember }) => ({
  question: question.trim().slice(0, LIMITS.questionChars),
  ...(context ? { context } : {}),
  ...(history.length > 0 ? { history: [...history] } : {}),
  ...(conversationId ? { conversationId } : {}),
  ...(remember === false ? { remember: false } : {}),
});

/**
 * A fresh id for a conversation: 32 hex characters.
 * @param {(count: number) => ArrayLike<number>} randomBytes returns `count` random bytes
 */
export const newConversationId = (randomBytes) =>
  Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");

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
 * The parts of a SpeechSynthesisVoice we use.
 * @typedef {{ name: string, lang: string, default?: boolean }} VoiceInfo
 */

/** @param {string} lang e.g. "pt_BR" → "pt-br" */
const normalizeLang = (lang) => lang.toLowerCase().replace("_", "-");

/**
 * How good a voice sounds, from its name: Premium > Enhanced > Natural/Neural > the rest.
 * (macOS/iOS label their better downloadable voices "Premium" and "Enhanced";
 * Edge and Chrome use "Natural", "Neural" or "Online" for theirs.)
 * @param {string} name
 */
export const voiceQuality = (name) => {
  if (/premium/i.test(name)) return 3;
  if (/enhanced|melhorad/i.test(name)) return 2;
  if (/natural|neural|online/i.test(name)) return 1;
  return 0;
};

/**
 * The installed voices for a language, best first: the exact region
 * (pt-PT before pt-BR) first, then quality, then the system default.
 * @template {VoiceInfo} V
 * @param {readonly V[]} voices @param {string} speechLang
 * @returns {V[]}
 */
export const voicesFor = (voices, speechLang) => {
  const want = normalizeLang(speechLang);
  const base = want.split("-")[0];
  return voices
    .filter((v) => normalizeLang(v.lang).split("-")[0] === base)
    .map((v) => ({
      v,
      exact: normalizeLang(v.lang) === want ? 1 : 0,
      quality: voiceQuality(v.name),
      isDefault: v.default ? 1 : 0,
    }))
    .sort(
      (a, b) =>
        b.exact - a.exact || b.quality - a.quality || b.isDefault - a.isDefault || a.v.name.localeCompare(b.v.name),
    )
    .map((x) => x.v);
};

/**
 * The voice to speak with: the user's choice for this language if it's still
 * installed, otherwise the best one. Undefined = browser default.
 * @template {VoiceInfo} V
 * @param {readonly V[]} voices @param {string} speechLang @param {string | null} [preferredName]
 * @returns {V | undefined}
 */
export const pickVoice = (voices, speechLang, preferredName) => {
  const ranked = voicesFor(voices, speechLang);
  return (preferredName ? ranked.find((v) => v.name === preferredName) : undefined) ?? ranked[0];
};

/** localStorage key for the chosen voice, per language. @param {"en" | "pt"} language */
export const voiceKey = (language) => `jarvis.voice.${language}`;

/** Conversation mode timings. */
export const CONVERSATION = {
  /** Stop listening after this long without hearing anything. */
  silenceMs: 8000,
  /** Pause between the end of Jarvis's speech and reopening the mic, so the tail of the audio isn't heard. */
  reopenDelayMs: 400,
};

/** Whole utterances that end conversation mode (compared as normalised words). */
const STOP_PHRASES = new Set(
  [
    "that's all",
    "that is all",
    "stop",
    "stop listening",
    "obrigado",
    "obrigada",
    "muito obrigado",
    "muito obrigada",
    "é tudo",
  ].map((p) => nameWords(p).join(" ")),
);

/** Polite words around a stop phrase ("thanks, that's all", "obrigado, é tudo", "Jarvis, stop"). */
const STOP_FILLERS = new Set(["ok", "okay", "jarvis", "thanks", "thank", "you", "please", "obrigado", "obrigada", "muito", "pronto"]);

/**
 * Is this spoken reply a request to stop listening? Only the whole utterance
 * counts, so "stop the music" is a question, not a stop.
 * @param {string} text
 */
export const isStopPhrase = (text) => {
  const words = nameWords(text);
  if (STOP_PHRASES.has(words.join(" "))) return true;
  while (words.length > 0 && STOP_FILLERS.has(words[0] ?? "")) words.shift();
  while (words.length > 0 && STOP_FILLERS.has(words[words.length - 1] ?? "")) words.pop();
  return words.length > 0 && STOP_PHRASES.has(words.join(" "));
};

/**
 * Should the mic reopen by itself after this reply? Only in conversation mode,
 * during a spoken conversation, when the browser allows it, and not after an
 * error (errors aren't spoken).
 * @param {{ conversation: boolean, voiceSession: boolean, blocked: boolean, available: boolean, kind: ReplyView["kind"] }} s
 */
export const shouldReopenMic = ({ conversation, voiceSession, blocked, available, kind }) =>
  conversation && voiceSession && !blocked && available && kind !== "error";

/**
 * The browser ended recognition with nothing heard (Chrome gives up after a
 * few seconds). Keep listening if the silence window isn't over yet.
 * @param {{ elapsedMs: number, heard: boolean, stopped: boolean }} s
 */
export const keepListening = ({ elapsedMs, heard, stopped }) =>
  !stopped && !heard && elapsedMs < CONVERSATION.silenceMs;
