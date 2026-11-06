// @ts-check
// Chat page wiring: DOM, POST /ask, speech recognition and speech synthesis.
// Uses only the browser's built-in Web Speech APIs. Conversation history
// lives in this page's memory only; reload or "New conversation" clears it.

import {
  LANGUAGES,
  appendTurn,
  buildAskBody,
  matchContextOption,
  parseLanguage,
  pickVoice,
  viewFromHttp,
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
const newButton = /** @type {HTMLButtonElement} */ (byId("new-conversation"));
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

/**
 * A clarify waiting for an answer: the question it was about, the offered
 * contexts and their buttons.
 * @typedef {{ question: string, options: import("./chat.js").ContextOption[], buttons: HTMLButtonElement[] }} PendingClarify
 */

/** @type {{ history: import("./chat.js").Turn[], language: "en" | "pt", muted: boolean, busy: boolean, listening: boolean, pending: PendingClarify | null }} */
const state = {
  history: [],
  language: parseLanguage(load("jarvis.language")),
  muted: load("jarvis.muted") === "true",
  busy: false,
  listening: false,
  pending: null,
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
  muteButton.setAttribute("aria-pressed", String(state.muted));
  muteButton.textContent = state.muted ? "🔇 Muted" : "🔊 Sound on";
  languageSelect.value = state.language;
  document.documentElement.lang = LANGUAGES[state.language].speech;
};

// ---- speech out ----

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

const stopSpeaking = () => synth?.cancel();

/** @param {string} text */
const speak = (text) => {
  if (!synth || state.muted) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const lang = LANGUAGES[state.language].speech;
  utterance.lang = lang;
  const voice = pickVoice(synth.getVoices(), lang);
  if (voice) utterance.voice = /** @type {SpeechSynthesisVoice} */ (voice);
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
      body: JSON.stringify(buildAskBody({ question: text, context, history: state.history })),
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
  if (view.speak) speak(view.speak);

  state.busy = false;
  setStatus("");
  renderControls();
  if (!state.listening) input.focus();
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
 * new question.
 * @param {string} raw
 */
const submit = (raw) => {
  const text = raw.trim();
  if (text === "") return;
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
    input.value = heard;
    if (final) submit(heard);
  };
  recognition.onend = () => {
    state.listening = false;
    renderControls();
    if (!state.busy) setStatus("");
  };
  recognition.onerror = (/** @type {any} */ event) => {
    state.listening = false;
    renderControls();
    setStatus(
      event.error === "not-allowed"
        ? "Microphone access was blocked. Allow it in the browser to speak to Jarvis."
        : event.error === "no-speech"
          ? "I didn't hear anything."
          : "Speech recognition stopped.",
    );
  };
}

micButton.addEventListener("click", () => {
  if (!recognition) return;
  stopSpeaking();
  if (state.listening) {
    recognition.stop();
    return;
  }
  recognition.lang = LANGUAGES[state.language].speech;
  try {
    recognition.start();
    state.listening = true;
    setStatus("Listening…");
  } catch {
    setStatus("Couldn't start the microphone.");
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
});

newButton.addEventListener("click", () => {
  stopSpeaking();
  retirePending();
  state.history = [];
  transcript.replaceChildren();
  setStatus("New conversation.");
  input.focus();
});

// Some browsers load voices asynchronously; nothing to do but make sure they load.
synth?.addEventListener?.("voiceschanged", () => undefined);

renderControls();
input.focus();
