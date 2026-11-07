// @ts-check
// Chat page wiring: DOM, POST /ask, speech recognition and speech synthesis.
// Uses only the browser's built-in Web Speech APIs. Conversation history
// lives in this page's memory only; reload or "New conversation" clears it.

import {
  CONVERSATION,
  LANGUAGES,
  appendTurn,
  buildAskBody,
  isStopPhrase,
  keepListening,
  matchContextOption,
  newConversationId,
  parseLanguage,
  pickVoice,
  shouldReopenMic,
  viewFromHttp,
  voiceKey,
  voicesFor,
} from "./chat.js";

/** @param {string} id @returns {HTMLElement} */
const byId = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const transcript = byId("transcript");
const form = /** @type {HTMLFormElement} */ (byId("ask-form"));
const input = /** @type {HTMLTextAreaElement} */ (byId("question"));
const sendButton = /** @type {HTMLButtonElement} */ (byId("send"));
const micButton = /** @type {HTMLButtonElement} */ (byId("mic"));
const muteButton = /** @type {HTMLButtonElement} */ (byId("mute"));
const languageSelect = /** @type {HTMLSelectElement} */ (byId("language"));
const voiceSelect = /** @type {HTMLSelectElement} */ (byId("voice"));
const newButton = /** @type {HTMLButtonElement} */ (byId("new-conversation"));
const conversationButton = /** @type {HTMLButtonElement} */ (byId("conversation"));
const listeningBanner = byId("listening");
const autoNote = byId("auto-note");
const status = byId("status");

// localStorage can be unavailable (private mode); preferences then just don't persist.
/** @param {string} key */
const load = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
/** @param {string} key @param {string} value */
const save = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

/** @param {number} count */
const randomBytes = (count) => crypto.getRandomValues(new Uint8Array(count));

/**
 * A clarify waiting for an answer: the question it was about, the offered
 * contexts and their buttons.
 * @typedef {{ question: string, options: import("./chat.js").ContextOption[], buttons: HTMLButtonElement[] }} PendingClarify
 */

/**
 * conversation: the Conversation mode preference (on by default).
 * voiceSession: the user is talking (last question was spoken and they haven't stopped).
 * autoBlocked: the browser refused to reopen the mic by itself; paused until the toggle is flipped.
 * @type {{
 *   history: import("./chat.js").Turn[], language: "en" | "pt", muted: boolean, busy: boolean,
 *   listening: boolean, pending: PendingClarify | null,
 *   conversation: boolean, voiceSession: boolean, autoBlocked: boolean,
 *   conversationId: string,
 * }}
 */
const state = {
  history: [],
  language: parseLanguage(load("jarvis.language")),
  muted: load("jarvis.muted") === "true",
  busy: false,
  listening: false,
  pending: null,
  conversation: load("jarvis.conversation") !== "false",
  voiceSession: false,
  autoBlocked: false,
  conversationId: newConversationId(randomBytes),
};

// ---- rendering ----

/** @param {string} text */
const setStatus = (text) => {
  status.textContent = text;
};

/**
 * @param {"user" | import("./chat.js").ReplyView["kind"]} kind
 * @param {string} text
 * @returns {HTMLElement}
 */
const addMessage = (kind, text) => {
  const item = document.createElement("li");
  item.className = `message ${kind}`;
  if (kind === "handoff") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "Handoff";
    item.append(tag);
  }
  const body = document.createElement("p");
  body.textContent = text;
  item.append(body);
  transcript.append(item);
  item.scrollIntoView({ block: "end", behavior: "smooth" });
  return item;
};

const renderControls = () => {
  sendButton.disabled = state.busy;
  // Context buttons can't be used while a request is in flight.
  for (const b of state.pending?.buttons ?? []) b.disabled = state.busy;
  micButton.setAttribute("aria-pressed", String(state.listening));
  micButton.textContent = state.listening ? "■ Stop" : "🎤 Speak";
  micButton.classList.toggle("listening", state.listening);
  listeningBanner.hidden = !state.listening;
  conversationButton.setAttribute("aria-pressed", String(state.conversation));
  conversationButton.textContent = state.conversation ? "💬 Conversation on" : "💬 Conversation off";
  autoNote.hidden = !(state.conversation && state.autoBlocked);
  muteButton.setAttribute("aria-pressed", String(state.muted));
  muteButton.textContent = state.muted ? "🔇 Muted" : "🔊 Sound on";
  languageSelect.value = state.language;
  document.documentElement.lang = LANGUAGES[state.language].speech;
};

// ---- speech out ----

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

// Each utterance gets a token; stopping or starting new speech makes older
// "finished speaking" callbacks stale, so a cancelled reply never reopens the mic.
let speechToken = 0;

const stopSpeaking = () => {
  speechToken += 1;
  synth?.cancel();
};

const voices = () => (synth ? synth.getVoices() : []);

/** The user's chosen voice for the current language, or null for "Automatic (best)". */
const chosenVoiceName = () => load(voiceKey(state.language));

/** Fills the voice menu with this language's installed voices, best first. */
const renderVoices = () => {
  const lang = LANGUAGES[state.language].speech;
  const ranked = voicesFor(voices(), lang);
  const best = ranked[0];
  const chosen = chosenVoiceName();

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = best ? `Automatic (${best.name})` : "Automatic";
  const options = ranked.map((v) => {
    const option = document.createElement("option");
    option.value = v.name;
    option.textContent = `${v.name} (${v.lang})`;
    return option;
  });
  voiceSelect.replaceChildren(automatic, ...options);
  voiceSelect.value = chosen && ranked.some((v) => v.name === chosen) ? chosen : "";
  voiceSelect.disabled = !synth || ranked.length === 0;
};

/**
 * Speaks a reply. `onDone` runs once speech has really finished (not when it
 * was cancelled), or straight away when there's nothing to speak.
 * @param {string} text @param {() => void} [onDone]
 */
const speak = (text, onDone) => {
  if (!synth || state.muted) {
    onDone?.();
    return;
  }
  stopSpeaking();
  const token = speechToken;
  const utterance = new SpeechSynthesisUtterance(text);
  const lang = LANGUAGES[state.language].speech;
  utterance.lang = lang;
  const voice = pickVoice(voices(), lang, chosenVoiceName());
  if (voice) utterance.voice = voice;

  let started = false;
  let finished = false;
  const startedAt = Date.now();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let watch;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(watch);
    if (token === speechToken) onDone?.();
  };
  utterance.onstart = () => {
    started = true;
  };
  utterance.onend = finish;
  utterance.onerror = finish; // a cancel also lands here, but its token is stale
  // Some browsers occasionally never fire "end". Once speech has started and
  // nothing is speaking or queued any more, it's over. Never before it starts.
  watch = setInterval(() => {
    if (synth.speaking) started = true;
    const idle = !synth.speaking && !synth.pending;
    if ((started && idle) || (!started && Date.now() - startedAt > 10000)) finish();
  }, 500);
  synth.speak(utterance);
};

// ---- asking ----

/** The clarify is answered or superseded: its buttons stop working. */
const retirePending = () => {
  for (const b of state.pending?.buttons ?? []) b.disabled = true;
  state.pending = null;
};

/**
 * Sends one question. Only one request at a time, so replies can't arrive
 * out of order.
 * @param {string} question
 * @param {string} [context] set when the user picked a context after a clarify
 */
const ask = async (question, context) => {
  // A new question while listening in conversation mode can't happen (the mic
  // closes on the final result), but never leave a stale timer running.
  clearSilenceTimer();
  const text = question.trim();
  if (text === "" || state.busy) return;
  stopSpeaking();
  state.busy = true;
  renderControls();
  if (!context) addMessage("user", text);
  setStatus("Thinking…");

  /** @type {import("./chat.js").ReplyView} */
  let view;
  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildAskBody({ question: text, context, history: state.history, conversationId: state.conversationId }),
      ),
    });
    const body = await res.json().catch(() => null);
    view = viewFromHttp(res.status, body);
  } catch {
    view = viewFromHttp(0, null);
    view.text = "I can't reach Jarvis. Is the server running?";
  }

  const item = addMessage(view.kind, view.text);
  if (view.kind === "clarify") {
    const choices = document.createElement("div");
    choices.className = "choices";
    /** @type {HTMLButtonElement[]} */
    const buttons = [];
    for (const option of view.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.name;
      button.dataset.context = option.id;
      button.addEventListener("click", () => pick(option.id));
      choices.append(button);
      buttons.push(button);
    }
    item.append(choices);
    state.pending = { question: text, options: view.options, buttons };
  }
  if (view.remember) {
    state.history = appendTurn(appendTurn(state.history, "user", text), "assistant", view.text);
  }
  state.busy = false;
  setStatus("");
  renderControls();

  const reopen = shouldReopenMic({
    conversation: state.conversation,
    voiceSession: state.voiceSession,
    blocked: state.autoBlocked,
    available: recognition !== null,
    kind: view.kind,
  });
  if (view.speak) {
    speak(view.speak, reopen ? reopenMicSoon : undefined);
  } else if (reopen) {
    reopenMicSoon();
  }
  if (!state.listening && !reopen) input.focus();
};

/**
 * Picks a context for the pending clarify, by button or by name.
 * @param {string} contextId
 */
const pick = (contextId) => {
  const pending = state.pending;
  if (!pending || state.busy) return; // ignored while a request is in flight
  for (const b of pending.buttons) if (b.dataset.context === contextId) b.classList.add("picked");
  retirePending();
  void ask(pending.question, contextId);
};

/**
 * Typed or spoken input. After a clarify, a reply that names one of the
 * offered contexts picks it (matched here, no model call); anything else is a
 * new question. In conversation mode a spoken stop phrase ends the
 * conversation instead of being sent.
 * @param {string} raw @param {{ spoken?: boolean }} [how]
 */
const submit = (raw, how = {}) => {
  const text = raw.trim();
  if (text === "") return;
  if (how.spoken && state.conversation && isStopPhrase(text)) {
    input.value = "";
    endVoice("phrase");
    return;
  }
  // Talking starts (or continues) a spoken conversation; typing ends it, and
  // closes the mic if it was open. Words sent by tapping Stop end it too.
  if (!how.spoken && state.listening) endVoice("reset");
  state.voiceSession = how.spoken === true && !listen$.stopped;
  if (state.busy) {
    // Keep the text so nothing is lost; it can be sent once the answer arrives.
    input.value = text;
    setStatus("Still answering the last question…");
    return;
  }
  input.value = "";
  const chosen = state.pending ? matchContextOption(text, state.pending.options) : undefined;
  if (chosen) {
    addMessage("user", text);
    pick(chosen.id);
    return;
  }
  retirePending();
  void ask(text);
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(input.value);
});

input.addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter adds a new line.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// ---- speech in ----

/** @type {any} */
const w = window;
const Recognition = w.SpeechRecognition ?? w.webkitSpeechRecognition;
/** @type {any} */
let recognition = null;

/**
 * The current listening window: when it opened, whether anything was heard,
 * whether it was opened automatically, and whether the user or a stop
 * condition closed it on purpose.
 */
const listen$ = { startedAt: 0, heard: false, auto: false, stopped: false, lastError: "" };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let silenceTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reopenTimer;

const clearSilenceTimer = () => {
  clearTimeout(silenceTimer);
  silenceTimer = undefined;
};

/** (Re)starts the silence countdown: about 8 seconds without hearing anything ends conversation mode. */
const armSilenceTimer = () => {
  clearSilenceTimer();
  if (!state.conversation) return; // plain mic: the browser decides when to stop
  silenceTimer = setTimeout(() => endVoice("silence"), CONVERSATION.silenceMs);
};

/** The browser wouldn't reopen the mic by itself: fall back to the button, with a note. */
const blockAuto = () => {
  state.autoBlocked = true;
  state.voiceSession = false;
  setStatus("");
  renderControls();
};

/**
 * Ends the spoken conversation: closes the mic and doesn't reopen it.
 * @param {"silence" | "phrase" | "user" | "reset"} reason
 */
const endVoice = (reason) => {
  clearSilenceTimer();
  clearTimeout(reopenTimer);
  state.voiceSession = false;
  listen$.stopped = true;
  if (state.listening && recognition) {
    // Tapping Stop mid-sentence still sends what was heard; otherwise just close.
    if (reason === "user" && listen$.heard) recognition.stop();
    else recognition.abort();
  }
  state.listening = false;
  setStatus(
    reason === "silence"
      ? "Stopped listening after a quiet spell. Tap 🎤 Speak to talk again."
      : reason === "phrase"
        ? "OK, I've stopped listening. Tap 🎤 Speak when you need me."
        : "",
  );
  renderControls();
};

/**
 * Opens the mic.
 * @param {boolean} auto opened by conversation mode rather than a tap
 * @param {boolean} [resume] continuing the same listening window after the browser gave up early
 */
const startListening = (auto, resume = false) => {
  if (!recognition || state.busy) return;
  if (state.listening && !resume) return;
  // Never listen while Jarvis is talking.
  if (auto && synth?.speaking) {
    reopenMicSoon();
    return;
  }
  recognition.lang = LANGUAGES[state.language].speech;
  if (!resume) {
    listen$.startedAt = Date.now();
    listen$.heard = false;
    listen$.auto = auto;
    listen$.stopped = false;
  }
  listen$.lastError = "";
  try {
    recognition.start();
  } catch {
    if (auto) blockAuto();
    else setStatus("Couldn't start the microphone.");
    state.listening = false;
    renderControls();
    return;
  }
  state.listening = true;
  if (!resume) armSilenceTimer();
  setStatus(""); // the Listening banner says it
  renderControls();
};

/** After Jarvis finishes speaking: wait a moment, then listen again. */
const reopenMicSoon = () => {
  clearTimeout(reopenTimer);
  reopenTimer = setTimeout(() => {
    if (!state.voiceSession || !state.conversation || state.autoBlocked || state.busy || state.listening) return;
    startListening(true);
  }, CONVERSATION.reopenDelayMs);
};

if (!Recognition) {
  micButton.disabled = true;
  micButton.title = "Speech recognition isn't available in this browser";
  byId("mic-note").hidden = false;
} else {
  recognition = new Recognition();
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (/** @type {any} */ event) => {
    let heard = "";
    let final = false;
    for (const result of event.results) {
      heard += result[0].transcript;
      final = final || result.isFinal;
    }
    if (heard.trim() !== "") {
      listen$.heard = true;
      armSilenceTimer(); // still talking: the quiet spell starts again
    }
    input.value = heard;
    if (final) {
      clearSilenceTimer();
      submit(heard, { spoken: true });
    }
  };
  recognition.onerror = (/** @type {any} */ event) => {
    listen$.lastError = String(event.error ?? "");
  };
  recognition.onend = () => {
    const error = listen$.lastError;
    const blocked = error === "not-allowed" || error === "service-not-allowed";
    if (blocked && listen$.auto) {
      state.listening = false;
      clearSilenceTimer();
      blockAuto();
      return;
    }
    // Chrome gives up after a few seconds of silence; in conversation mode keep
    // the window open for the full quiet spell.
    const resume =
      state.conversation &&
      !blocked &&
      (error === "" || error === "no-speech") &&
      keepListening({ elapsedMs: Date.now() - listen$.startedAt, heard: listen$.heard, stopped: listen$.stopped });
    if (resume) {
      startListening(listen$.auto, true);
      return;
    }
    state.listening = false;
    if (!listen$.heard) clearSilenceTimer();
    renderControls();
    if (state.busy || listen$.stopped) return;
    if (blocked) setStatus("Microphone access was blocked. Allow it in the browser to speak to Jarvis.");
    else if (!listen$.heard && state.conversation) endVoice("silence");
    else if (error === "no-speech") setStatus("I didn't hear anything.");
    else if (error !== "" && error !== "aborted") setStatus("Speech recognition stopped.");
    else setStatus("");
  };
}

micButton.addEventListener("click", () => {
  if (!recognition) return;
  if (state.listening) {
    endVoice("user");
    return;
  }
  stopSpeaking();
  clearTimeout(reopenTimer);
  startListening(false);
});

conversationButton.addEventListener("click", () => {
  state.conversation = !state.conversation;
  save("jarvis.conversation", String(state.conversation));
  state.autoBlocked = false; // flipping the toggle retries the automatic mic
  if (!state.conversation) {
    clearTimeout(reopenTimer);
    clearSilenceTimer();
  }
  renderControls();
});

// ---- settings ----

muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  save("jarvis.muted", String(state.muted));
  if (state.muted) stopSpeaking();
  renderControls();
});

languageSelect.addEventListener("change", () => {
  state.language = parseLanguage(languageSelect.value);
  save("jarvis.language", state.language);
  renderControls();
  renderVoices();
});

voiceSelect.addEventListener("change", () => {
  // "" means Automatic: forget the choice so the best voice is used.
  if (voiceSelect.value === "") {
    try {
      window.localStorage.removeItem(voiceKey(state.language));
    } catch {
      /* ignore */
    }
  } else {
    save(voiceKey(state.language), voiceSelect.value);
  }
});

newButton.addEventListener("click", () => {
  endVoice("reset");
  stopSpeaking();
  retirePending();
  state.history = [];
  state.conversationId = newConversationId(randomBytes);
  transcript.replaceChildren();
  setStatus("New conversation.");
  input.focus();
});

// Browsers load voices asynchronously; refresh the menu when they arrive.
synth?.addEventListener?.("voiceschanged", renderVoices);

renderControls();
renderVoices();
input.focus();
