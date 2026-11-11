// @ts-check
// Pure logic for the chat page: no DOM, no network, so it can be unit-tested.
// app.js wires it to the page, the microphone and speech.

/** Same limits as the server (src/request.ts). */
export const LIMITS = { historyTurns: 20, turnChars: 4000, questionChars: 2000, toolsPerTurn: 5, toolChars: 80 };

/** Speech languages: English by default, Portuguese (Portugal) as the alternative. */
export const LANGUAGES = {
  en: { label: "English", speech: "en-GB" },
  pt: { label: "Português", speech: "pt-PT" },
};
export const DEFAULT_LANGUAGE = "en";

/** @param {unknown} value @returns {"en" | "pt"} */
export const parseLanguage = (value) => (value === "pt" ? "pt" : DEFAULT_LANGUAGE);

/**
 * @typedef {{ role: "user" | "assistant", text: string, tools?: string[] }} Turn
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
 * `tools`: the tool calls that really ran for an answer (#104), e.g.
 * "calendar_read Wed 11 Nov → 1 event", so the brain knows later what it did.
 * @param {readonly Turn[]} history @param {Turn["role"]} role @param {string} text @param {readonly string[]} [tools] @returns {Turn[]}
 */
export const appendTurn = (history, role, text, tools) => {
  const kept = (tools ?? []).slice(0, LIMITS.toolsPerTurn).map((t) => t.slice(0, LIMITS.toolChars));
  return [...history, { role, text: text.slice(0, LIMITS.turnChars), ...(kept.length > 0 ? { tools: kept } : {}) }].slice(-LIMITS.historyTurns);
};

/**
 * Actions waiting for Renato's OK (Reach 2): each one gets a card with
 * "Add it" / "Don't add".
 * @param {readonly PathStep[]} path @returns {{ id: string, label: string, kind?: "calendar" | "skill" }[]}
 */
export const confirmsOf = (path) =>
  path.flatMap((step) =>
    (step.kind === "tool" || step.kind === "skill") && step.ok && step.confirm && typeof step.confirm.id === "string" && typeof step.confirm.label === "string" ? [step.confirm] : [],
  );

/**
 * The tool calls that ran and worked for an answer, from its path (#104):
 * dates and counts only, never titles.
 * @param {readonly PathStep[]} path @returns {string[]}
 */
export const toolsRan = (path) =>
  path.flatMap((step) => (step.kind === "tool" && step.ok ? [`${step.name}${step.args ? ` ${step.args}` : ""} → ${step.result ?? "ok"}`] : []));

/**
 * The POST /ask body. `conversationId` groups this conversation's history
 * memory on the server; `remember: false` is "don't remember this".
 * `spoken`: a spoken turn (answered for speed, #76); `stickyContext`: the
 * context the spoken conversation was last answered in (used only when the
 * server has STICKY_CONTEXT=on); `brain`: "claude" or "local" (#88).
 * @param {{ question: string, context?: string, history: readonly Turn[], conversationId?: string, remember?: boolean, spoken?: boolean, stickyContext?: string, brain?: "claude" | "local" }} input
 */
export const buildAskBody = ({ question, context, history, conversationId, remember, spoken, stickyContext, brain }) => ({
  question: question.trim().slice(0, LIMITS.questionChars),
  ...(context ? { context } : {}),
  ...(history.length > 0 ? { history: [...history] } : {}),
  ...(conversationId ? { conversationId } : {}),
  ...(remember === false ? { remember: false } : {}),
  ...(spoken ? { spoken: true } : {}),
  ...(spoken && stickyContext && !context ? { stickyContext } : {}),
  ...(brain ? { brain } : {}),
});

/** The page's brain choice (#88): Local unless Claude was picked. @param {string | null} saved */
export const parseBrain = (saved) => (saved === "claude" ? "claude" : "local");

/** Shown once (#100): with the calendar on and Claude answering, event titles leave this computer. */
export const CALENDAR_CLAUDE_NOTE =
  "Your calendar is connected. With ☁️ Claude answering, the titles, times and places of the events you ask about are sent to Anthropic. Switch to 🧠 Local to keep them on this computer. EC events are only ever sent as \"EC work, handled by Kiro\".";

/**
 * Whether to show that note now: the calendar is on, Claude is answering,
 * and it hasn't been shown before.
 * @param {{ calendar: boolean, brain: "claude" | "local", seen: boolean }} s
 */
export const calendarNoteDue = ({ calendar, brain, seen }) => calendar && brain === "claude" && !seen;

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
 * A memory as GET /memories returns it.
 * @typedef {{ id: string, contextId: string, contextName: string, kind: "fact" | "playbook" | "history", text: string,
 *   origin: "auto" | "explicit", createdAt: string, updatedAt: string, expiresAt?: string, seen: boolean }} MemoryView
 * @typedef {{ kind: MemoryView["kind"], label: string, items: MemoryView[] }} MemoryKindGroup
 * @typedef {{ contextId: string, contextName: string, count: number, kinds: MemoryKindGroup[] }} MemoryContextGroup
 */

export const MEMORY_KIND_LABELS = {
  fact: "Facts",
  playbook: "How you like things done",
  history: "Recent conversations",
};

/**
 * Groups memories for the panel: by context (in the order given, then any
 * others), then by kind (facts, playbooks, history). Empty groups are left out.
 * @param {readonly MemoryView[]} memories @param {readonly { id: string, name: string }[]} contexts
 * @returns {MemoryContextGroup[]}
 */
export const groupMemories = (memories, contexts) => {
  const order = [...contexts.map((c) => c.id), ...memories.map((m) => m.contextId)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  return order
    .map((contextId) => {
      const mine = memories.filter((m) => m.contextId === contextId);
      const contextName = contexts.find((c) => c.id === contextId)?.name ?? mine[0]?.contextName ?? contextId;
      const kinds = /** @type {const} */ (["fact", "playbook", "history"])
        .map((kind) => ({ kind, label: MEMORY_KIND_LABELS[kind], items: mine.filter((m) => m.kind === kind) }))
        .filter((g) => g.items.length > 0);
      return { contextId, contextName, count: mine.length, kinds };
    })
    .filter((g) => g.count > 0);
};

/** "7 Nov 2026", or "7 de novembro de 2026" in Portuguese. @param {string} iso @param {"en" | "pt"} language */
export const formatMemoryDay = (iso, language) =>
  language === "pt"
    ? new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso))
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

/** Ids the user hasn't seen yet. @param {readonly MemoryView[]} memories */
export const unseenIds = (memories) => memories.filter((m) => !m.seen).map((m) => m.id);

/** The badge text: "" when there's nothing new, "9+" past nine. @param {number} unseen */
export const badgeText = (unseen) => (unseen <= 0 ? "" : unseen > 9 ? "9+" : String(unseen));

// ---- voice only in voice mode (#102) ----

/**
 * Whether a reply is read aloud: when you asked with the mic (or in a
 * spoken conversation), or when "read typed replies aloud" is on. Never
 * when muted.
 * @param {{ spoken: boolean, readTyped: boolean, muted: boolean }} turn
 */
export const shouldSpeak = ({ spoken, readTyped, muted }) => !muted && (spoken || readTyped);

/**
 * Whether the voice note ("Kokoro isn't running… using the browser voice")
 * shows: only when there is one and the voice is actually being used for
 * this turn. Typed, text-only turns don't show it.
 * @param {{ note: string, voiceInUse: boolean }} s
 */
export const voiceNoteVisible = ({ note, voiceInUse }) => note !== "" && voiceInUse;

// ---- the answer's path (#102) ----

/**
 * @typedef {{ kind: "precheck", result: "none" | "handoff" | "route" }
 *   | { kind: "brain", brain: "claude" | "local" }
 *   | { kind: "tool" | "skill", name: string, args: string, by: "code" | "model", ok: boolean, result?: string, error?: string, confirm?: { id: string, label: string, kind?: "calendar" | "skill" } }
 *   | { kind: "guard", claimedAction: number, promise: number, perception: number, toolResult?: number, replaced: boolean }} PathStep
 */

/** The steps of a reply's path, if it has one that this page understands. @param {unknown} body @returns {PathStep[]} */
export const pathOf = (body) => {
  const path = body && typeof body === "object" && "path" in body ? body.path : undefined;
  if (!Array.isArray(path)) return [];
  return path.filter((s) => s && typeof s === "object" && ["precheck", "brain", "tool", "skill", "guard"].includes(s.kind));
};

/** Tools do or fetch something; skills are ways of working. They're marked differently. @param {PathStep & { kind: "tool" | "skill" }} step */
const toolIcon = (step) => (step.kind === "skill" ? "✨" : step.name.startsWith("calendar") ? "🗓" : "🔧");

/** @param {PathStep & { kind: "guard" }} g */
const guardDropped = (g) => g.claimedAction + g.promise + g.perception + (g.toolResult ?? 0);

/** @param {number} n @param {string} one */
const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The one-line summary: "🧠 Local · 🗓 calendar_read Wed 11 Nov → 2 events · 🛡 guard: 1 dropped".
 * @param {readonly PathStep[]} path
 */
export const pathSummary = (path) =>
  path
    .flatMap((step) => {
      switch (step.kind) {
        case "precheck":
          return step.result === "handoff" ? ["🚦 EC precheck → Kiro"] : [];
        case "brain":
          return [step.brain === "claude" ? "☁️ Claude" : "🧠 Local"];
        case "tool":
        case "skill":
          return [`${toolIcon(step)} ${step.kind === "skill" ? "skill " : ""}${step.name}${step.args ? ` ${step.args}` : ""} → ${step.ok ? (step.result ?? "ok") : `failed (${step.error ?? "error"})`}`];
        case "guard":
          return guardDropped(step) > 0 ? [`🛡 guard: ${guardDropped(step)} dropped`] : [];
        default:
          return [];
      }
    })
    .join(" · ");

/**
 * Each step in order, for the expanded view.
 * @param {readonly PathStep[]} path @param {Record<string, string>} [brainLabels] e.g. { local: "Local · qwen3:8b" }
 */
export const pathLines = (path, brainLabels = {}) =>
  path.map((step) => {
    switch (step.kind) {
      case "precheck":
        return step.result === "handoff"
          ? "🚦 EC precheck: EC work, handed to Kiro. No model ran."
          : step.result === "route"
            ? "🚦 EC precheck: mentions the EC, but it's yours to answer (invoicing)."
            : "🚦 EC precheck: not EC work.";
      case "brain":
        return `${step.brain === "claude" ? "☁️" : "🧠"} Brain: ${brainLabels[step.brain] ?? (step.brain === "claude" ? "Claude" : "Local")}`;
      case "tool":
      case "skill": {
        const who = step.by === "code" ? "worked out by code" : "chosen by the model, checked by code";
        const args = step.args ? ` · ${step.args} (${who})` : "";
        return `${toolIcon(step)} ${step.kind === "skill" ? "Skill" : "Tool"} ${step.name}${args} · ${step.ok ? `ok${step.result ? `: ${step.result}` : ""}` : `failed: ${step.error ?? "error"}`}`;
      }
      case "guard": {
        if (guardDropped(step) === 0) return "🛡 Honesty guard: nothing dropped.";
        const kinds = [
          step.claimedAction > 0 ? count(step.claimedAction, "claimed action") : "",
          step.promise > 0 ? count(step.promise, "promise") : "",
          step.perception > 0 ? count(step.perception, "claim") + " to see or hear you" : "",
          (step.toolResult ?? 0) > 0 ? count(step.toolResult ?? 0, "claim") + " about your calendar with no read" : "",
        ].filter(Boolean);
        const said = (step.toolResult ?? 0) > 0 ? "; said it hadn't checked" : step.replaced ? "; said it can't do that yet" : "";
        return `🛡 Honesty guard: dropped ${kinds.join(", ")}${said}.`;
      }
      default:
        return "";
    }
  });
