// @ts-check
// Chat page wiring: DOM, POST /ask, listening (local Whisper through
// /transcribe, #74) and speech synthesis (the browser's voices). Conversation history
// lives in this page's memory only; reload or "New conversation" clears it.

import {
  CONVERSATION,
  LANGUAGES,
  appendTurn,
  badgeText,
  buildAskBody,
  formatMemoryDay,
  groupMemories,
  isStopPhrase,
  matchContextOption,
  newConversationId,
  parseLanguage,
  pickVoice,
  shouldReopenMic,
  unseenIds,
  viewFromHttp,
  voiceKey,
  voicesFor,
} from "./chat.js";
import { playSpeech } from "./audio.js";
import { makeSpeaker } from "./speaker.js";
import { chooseVoice, parseSse, phaseLabel } from "./turn-lib.js";
import { canRecord, recordUtterance } from "./mic.js";

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
const phaseBanner = byId("phase");
const phaseText = byId("phase-text");
const voiceNote = byId("voice-note");
const micNote = byId("mic-note");
const autoNote = byId("auto-note");
const rememberButton = /** @type {HTMLButtonElement} */ (byId("remember"));
const memoriesButton = /** @type {HTMLButtonElement} */ (byId("memories"));
const memoriesBadge = byId("memories-badge");
const memoriesPanel = /** @type {HTMLDialogElement} */ (byId("memories-panel"));
const memoriesClose = /** @type {HTMLButtonElement} */ (byId("memories-close"));
const memoriesList = byId("memories-list");
const memoriesStatus = byId("memories-status");
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
 *   listening: boolean, transcribing: boolean, pending: PendingClarify | null,
 *   phase: import("./turn-lib.js").Phase,
 *   conversation: boolean, voiceSession: boolean, autoBlocked: boolean,
 *   conversationId: string, remember: boolean,
 * }}
 */
const state = {
  history: [],
  language: parseLanguage(load("jarvis.language")),
  muted: load("jarvis.muted") === "true",
  busy: false,
  listening: false,
  transcribing: false,
  phase: "idle",
  pending: null,
  conversation: load("jarvis.conversation") !== "false",
  voiceSession: false,
  autoBlocked: false,
  conversationId: newConversationId(randomBytes),
  // "Don't remember this", for the current conversation only.
  remember: true,
};

// ---- rendering ----

/** Listening / Thinking / Speaking, shown and read out. @param {import("./turn-lib.js").Phase} phase */
const setPhase = (phase) => {
  if (state.phase === phase) return;
  state.phase = phase;
  renderControls();
};

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

/** Adds a streamed sentence to a message. @param {HTMLElement} item @param {string} sentence */
const appendToMessage = (item, sentence) => {
  const body = item.querySelector("p");
  if (body) body.textContent = body.textContent ? `${body.textContent} ${sentence}` : sentence;
  item.scrollIntoView({ block: "end", behavior: "smooth" });
};

/** @param {HTMLElement} item @param {string} text */
const setMessageText = (item, text) => {
  const body = item.querySelector("p");
  if (body) body.textContent = text;
};

const renderControls = () => {
  sendButton.disabled = state.busy;
  // Context buttons can't be used while a request is in flight.
  for (const b of state.pending?.buttons ?? []) b.disabled = state.busy;
  micButton.setAttribute("aria-pressed", String(state.listening));
  micButton.textContent = state.listening ? "■ Stop" : "🎤 Speak";
  micButton.classList.toggle("listening", state.listening);
  phaseBanner.dataset.phase = state.phase;
  phaseBanner.hidden = state.phase === "idle";
  phaseText.textContent = phaseLabel(state.phase, state.language);
  micButton.disabled = !listenAvailable() || (state.transcribing && !state.listening);
  micButton.title = !micSupported ? "This browser can't record the microphone" : listenAvailable() ? "" : "Listening is English-only for now";
  micNote.hidden = listenAvailable();
  micNote.textContent = micSupported
    ? "Listening works in English only for now (Whisper on this computer). Type in Portuguese."
    : "This browser can't record the microphone. Typing works; for voice use Chrome or Safari.";
  conversationButton.setAttribute("aria-pressed", String(state.conversation));
  conversationButton.textContent = state.conversation ? "💬 Conversation on" : "💬 Conversation off";
  autoNote.hidden = !(state.conversation && state.autoBlocked);
  rememberButton.setAttribute("aria-pressed", String(state.remember));
  rememberButton.textContent = state.remember ? "🧠 Remembering" : "🙈 Not remembering this conversation";
  muteButton.setAttribute("aria-pressed", String(state.muted));
  muteButton.textContent = state.muted ? "🔇 Muted" : "🔊 Sound on";
  languageSelect.value = state.language;
  document.documentElement.lang = LANGUAGES[state.language].speech;
};

// ---- speech out (#82) ----
//
// Replies are spoken with the configured voice (TTS_PROVIDER / TTS_VOICE,
// e.g. Kokoro's bm_daniel) through POST /speak, sentence by sentence as the
// answer streams in. The browser voice is used when that's what's
// configured, and otherwise only as a fallback (the service is down, or
// /speak fails), with a note. The configured voice speaks English; in
// Portuguese the browser voice speaks.

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

/** One AudioContext for Jarvis's voice, made on the first tap or send so the browser lets it play. */
/** @type {AudioContext | undefined} */
let audioCtx;
const audio = () => {
  audioCtx ??= new AudioContext();
  void audioCtx.resume();
  return audioCtx;
};

/** The voice in use, from GET /tts. @type {ReturnType<typeof chooseVoice>} */
let voiceChoice = { server: null, note: "" };
const renderVoiceNote = () => {
  voiceNote.textContent = voiceChoice.note;
  voiceNote.hidden = voiceChoice.note === "" || state.muted;
};
const refreshVoice = async () => {
  try {
    const res = await fetch("/tts");
    voiceChoice = chooseVoice(res.ok ? await res.json() : null);
  } catch {
    voiceChoice = chooseVoice(null);
  }
  renderVoiceNote();
};

/** The reply being spoken now. @type {ReturnType<typeof makeSpeaker> | undefined} */
let speaker;
const stopSpeaking = () => {
  speaker?.stop();
  speaker = undefined;
  synth?.cancel();
};
const isSpeaking = () => speaker?.active() === true;

const voices = () => (synth ? synth.getVoices() : []);

/** The user's chosen browser voice for the current language, or null for "Automatic (best)". */
const chosenVoiceName = () => load(voiceKey(state.language));

/** Fills the voice menu with this language's installed browser voices, best first. */
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
  voiceSelect.title = "The browser voice, used when Jarvis's own voice isn't available";
};

/**
 * Says one sentence with the browser voice. Resolves when it's over, with
 * how much of it was said (from the browser's word boundaries).
 * @param {string} text @param {AbortSignal} signal @param {{ fraction: () => number }} tracker
 * @returns {Promise<{ fraction: number, stopped: boolean }>}
 */
const speakBrowser = (text, signal, tracker) =>
  new Promise((resolve) => {
    if (!synth || signal.aborted) {
      resolve({ fraction: 0, stopped: signal.aborted });
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = LANGUAGES[state.language].speech;
    utterance.lang = lang;
    const voice = pickVoice(voices(), lang, chosenVoiceName());
    if (voice) utterance.voice = voice;
    let spokenChars = 0;
    utterance.onboundary = (e) => {
      spokenChars = e.charIndex;
    };
    tracker.fraction = () => (text.length === 0 ? 0 : Math.min(1, spokenChars / text.length));
    let started = false;
    let finished = false;
    const startedAt = Date.now();
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let watch;
    /** @param {boolean} stopped */
    const finish = (stopped) => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      resolve({ fraction: stopped ? tracker.fraction() : 1, stopped });
    };
    utterance.onstart = () => {
      started = true;
    };
    utterance.onend = () => finish(signal.aborted);
    utterance.onerror = () => finish(signal.aborted);
    signal.addEventListener("abort", () => {
      synth.cancel();
      finish(true);
    });
    // Some browsers occasionally never fire "end". Once speech has started and
    // nothing is speaking or queued any more, it's over. Never before it starts.
    watch = setInterval(() => {
      if (synth.speaking) started = true;
      const idle = !synth.speaking && !synth.pending;
      if ((started && idle) || (!started && Date.now() - startedAt > 10000)) finish(false);
    }, 250);
    synth.speak(utterance);
  });

/**
 * Starts speaking a reply; add sentences with say(), then finish().
 * @param {(result: import("./speaker.js").PlaybackResult) => void} onDone
 */
const startSpeaker = (onDone) => {
  stopSpeaking();
  const server = state.language === "en" ? voiceChoice.server : null;
  const ctx = server ? audio() : undefined;
  const sp = makeSpeaker({
    fetchSpeech:
      server && ctx
        ? (text, signal) =>
            fetch("/speak", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text, provider: server.provider, voice: server.voice }),
              signal,
            })
        : null,
    play: (response, signal, tracker) => {
      if (!ctx) throw new Error("no audio");
      return playSpeech({ ctx, response, signal, tracker });
    },
    speakBrowser,
    muted: state.muted || (!server && !synth),
    onFallback: (why) => {
      voiceChoice = { server: null, note: `${why}, so Jarvis is using the browser voice.` };
      renderVoiceNote();
    },
    onSpeaking: () => setPhase("speaking"),
    onDone: (result) => {
      if (speaker === sp) speaker = undefined;
      onDone(result);
    },
  });
  speaker = sp;
  return sp;
};

// ---- asking ----

/** The clarify is answered or superseded: its buttons stop working. */
const retirePending = () => {
  for (const b of state.pending?.buttons ?? []) b.disabled = true;
  state.pending = null;
};

/** The answer being streamed now, so barge-in can cancel it. @type {AbortController | undefined} */
let answering;

/**
 * Sends one question and speaks the reply as it streams in. Only one request
 * at a time, so replies can't arrive out of order.
 * @param {string} question
 * @param {string} [context] set when the user picked a context after a clarify
 */
const ask = async (question, context) => {
  const text = question.trim();
  if (text === "" || state.busy) return;
  stopSpeaking();
  state.busy = true;
  setPhase("thinking");
  renderControls();
  if (!context) addMessage("user", text);
  setStatus("");
  const voiceReady = refreshVoice();

  /** @type {unknown} */
  let final = null;
  let status = 0;
  let turnId = "";
  let reachable = true;
  /** @type {HTMLElement | undefined} */
  let item;
  /** @type {import("./chat.js").ReplyView | undefined} */
  let view;
  let reopen = false;
  /** @type {ReturnType<typeof makeSpeaker> | undefined} */
  let sp;
  const controller = new AbortController();
  answering = controller;

  /** How the reply was actually spoken: the history, the report, then listening again. */
  /** @param {import("./speaker.js").PlaybackResult} result */
  const onPlayback = (result) => {
    const remember = view ? view.remember : true; // cut off mid-answer: it was an answer
    if (remember) {
      const said = result.interrupted ? result.spoken || "—" : (view?.text ?? result.spoken);
      state.history = appendTurn(appendTurn(state.history, "user", text), "assistant", said);
    }
    if (result.interrupted) item?.classList.add("interrupted");
    // The server holds a streamed answer's wrap-up until it hears how playback went (#72).
    if (turnId !== "" && (!view || view.kind === "answer")) {
      void fetch("/ask/spoken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId, interrupted: result.interrupted, spoken: result.spoken.slice(0, 4000) }),
      }).catch(() => undefined);
    }
    if (!result.interrupted) {
      if (state.phase === "speaking") setPhase("idle");
      if (reopen) reopenMicSoon();
    }
  };
  /** @param {string} sentence */
  const say = async (sentence) => {
    if (!sp) {
      await voiceReady;
      if (controller.signal.aborted) return;
      sp = startSpeaker(onPlayback);
    }
    sp.say(sentence);
  };

  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(
        buildAskBody({
          question: text,
          context,
          history: state.history,
          conversationId: state.conversationId,
          remember: state.remember,
        }),
      ),
      signal: controller.signal,
    });
    status = res.status;
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      final = await res.json().catch(() => null);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          const data = JSON.parse(ev.data);
          if (ev.event === "start") turnId = String(data.turnId ?? "");
          else if (ev.event === "sentence") {
            const sentence = String(data.text ?? "");
            if (!item) item = addMessage("answer", sentence);
            else appendToMessage(item, sentence);
            await say(sentence);
          } else if (ev.event === "done" || ev.event === "reply") final = data;
        }
      }
    }
  } catch {
    reachable = controller.signal.aborted;
  }
  if (answering === controller) answering = undefined;

  if (controller.signal.aborted) {
    // Interrupted (barge-in) while the answer was still coming: what was said is already recorded.
    sp?.stop();
    if (!sp) onPlayback({ interrupted: true, spoken: "", sentences: 0, fellBack: false });
    state.busy = false;
    renderControls();
    return;
  }

  view = reachable ? viewFromHttp(status, final) : { ...viewFromHttp(0, null), text: "I can't reach Jarvis. Is the server running?" };
  if (view.kind === "answer" && item) {
    setMessageText(item, view.text);
  } else {
    item = addMessage(view.kind, view.text);
  }
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
  reopen = shouldReopenMic({
    conversation: state.conversation,
    voiceSession: state.voiceSession,
    blocked: state.autoBlocked,
    available: listenAvailable(),
    kind: view.kind,
  });
  // A reply that isn't a streamed answer (clarify, handoff, not connected) is spoken whole.
  if (!sp && view.speak) await say(view.speak);
  state.busy = false;
  renderControls();
  // The wrap-up runs after the reply; check for new memories a little later.
  if (view.remember && state.remember) setTimeout(() => void refreshBadge(), 5000);
  if (sp) sp.finish();
  else onPlayback({ interrupted: false, spoken: "", sentences: 0, fellBack: false });
  if (!sp && state.phase === "thinking") setPhase("idle");
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
  audio(); // made on a tap or Enter, so the browser lets Jarvis's voice play
  submit(input.value);
});

input.addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter adds a new line.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// ---- speech in (#74) ----
//
// Whisper on this machine: the page records one utterance, sends it as a
// 16 kHz WAV to POST /transcribe, and sends the text it gets back like typed
// text (so /ask's local EC precheck runs on it first). The browser's own
// speech recognition, which sends audio to Google or Apple, isn't used. If
// Whisper isn't running, the page says so; there's no fallback.

const micSupported = canRecord();
/** Local listening is English-only for now (#74); Portuguese is typed. */
const listenAvailable = () => micSupported && state.language === "en";

/** @type {AudioContext | undefined} */
let micCtx;
/** The utterance being recorded. @type {{ stop: () => void, controller: AbortController } | undefined} */
let recording;
/**
 * The current listening window: whether speech was heard, whether it was
 * opened automatically, and whether the user or a stop condition closed it on purpose.
 */
const listen$ = { heard: false, auto: false, stopped: false };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reopenTimer;

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
  clearTimeout(reopenTimer);
  state.voiceSession = false;
  listen$.stopped = true;
  if (recording) {
    // Tapping Stop mid-sentence still sends what was heard; otherwise just close.
    if (reason === "user" && listen$.heard) recording.stop();
    else recording.controller.abort();
  }
  state.listening = false;
  if (state.phase === "listening") state.phase = "idle";
  setStatus(
    reason === "silence"
      ? "Stopped listening after a quiet spell. Tap 🎤 Speak to talk again."
      : reason === "phrase"
        ? "OK, I've stopped listening. Tap 🎤 Speak when you need me."
        : "",
  );
  renderControls();
};

/** Is Whisper up? @returns {Promise<{ ok: true } | { ok: false, problem: string }>} */
const sttStatus = async () => {
  try {
    const res = await fetch("/stt");
    const body = await res.json();
    if (body?.available === true) return { ok: true };
    const problem = typeof body?.problem === "string" ? body.problem : "Listening isn't available.";
    return { ok: false, problem: body?.starting ? `${problem}… try again in a moment.` : problem };
  } catch {
    return { ok: false, problem: "I can't reach Jarvis. Is the server running?" };
  }
};

/**
 * Sends a recorded utterance to Whisper, then sends its text as a spoken question.
 * @param {Uint8Array} wav
 */
const transcribeAndSend = async (wav) => {
  state.transcribing = true;
  setPhase("thinking");
  renderControls();
  let text = "";
  let problem = "";
  try {
    const res = await fetch(`/transcribe?language=${state.language}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: /** @type {Uint8Array<ArrayBuffer>} */ (wav),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && typeof body?.text === "string") text = body.text;
    else problem = typeof body?.message === "string" ? body.message : `Listening failed (status ${res.status}).`;
  } catch {
    problem = "I can't reach Jarvis. Is the server running?";
  }
  state.transcribing = false;
  if (state.phase === "thinking") state.phase = "idle";
  setStatus("");
  renderControls();
  if (problem !== "") {
    state.voiceSession = false;
    setStatus(problem);
    return;
  }
  if (text === "") {
    // A cough, or words Whisper couldn't make out: in conversation mode, listen again.
    if (state.conversation && !listen$.stopped) void startListening(listen$.auto);
    else setStatus("I didn't catch that.");
    return;
  }
  input.value = text;
  submit(text, { spoken: true });
};

/**
 * Opens the mic for one utterance.
 * @param {boolean} auto opened by conversation mode rather than a tap
 */
const startListening = async (auto) => {
  if (!listenAvailable() || state.busy || state.listening || state.transcribing) return;
  // Never listen while Jarvis is talking.
  if (auto && isSpeaking()) {
    reopenMicSoon();
    return;
  }
  const ready = await sttStatus();
  if (!ready.ok) {
    state.voiceSession = false;
    setStatus(ready.problem);
    renderControls();
    return;
  }
  // Something else happened while asking (a typed question, another tap).
  if (state.busy || state.listening || state.transcribing) return;

  listen$.heard = false;
  listen$.auto = auto;
  listen$.stopped = false;
  micCtx = audio();
  const controller = new AbortController();
  const rec = recordUtterance({
    ctx: micCtx,
    signal: controller.signal,
    noSpeechMs: CONVERSATION.silenceMs,
    onSpeech: () => {
      listen$.heard = true;
    },
  });
  recording = { stop: rec.stop, controller };
  state.listening = true;
  setStatus("");
  setPhase("listening");
  renderControls();

  /** @type {{ wav: Uint8Array | null, reason: string }} */
  let result;
  try {
    result = await rec.done;
  } catch (e) {
    recording = undefined;
    state.listening = false;
    if (state.phase === "listening") state.phase = "idle";
    const name = e instanceof Error ? e.name : "";
    const blocked = name === "NotAllowedError" || name === "SecurityError";
    if (blocked && auto) {
      blockAuto();
      return;
    }
    setStatus(blocked ? "Microphone access was blocked. Allow it in the browser to speak to Jarvis." : "Couldn't start the microphone.");
    renderControls();
    return;
  }
  recording = undefined;
  state.listening = false;
  if (state.phase === "listening") state.phase = "idle";
  renderControls();
  if (result.reason === "cancelled") return;
  if (!result.wav) {
    if (listen$.stopped) return;
    if (state.conversation) endVoice("silence");
    else setStatus("I didn't hear anything.");
    return;
  }
  await transcribeAndSend(result.wav);
};

/** After Jarvis finishes speaking: wait a moment, then listen again. */
const reopenMicSoon = () => {
  clearTimeout(reopenTimer);
  reopenTimer = setTimeout(() => {
    if (!state.voiceSession || !state.conversation || state.autoBlocked || state.busy || state.listening) return;
    void startListening(true);
  }, CONVERSATION.reopenDelayMs);
};

micButton.addEventListener("click", () => {
  if (state.listening) {
    endVoice("user");
    return;
  }
  stopSpeaking();
  clearTimeout(reopenTimer);
  // Made on a tap, so the browser lets it start.
  micCtx = audio();
  void startListening(false);
});

conversationButton.addEventListener("click", () => {
  state.conversation = !state.conversation;
  save("jarvis.conversation", String(state.conversation));
  state.autoBlocked = false; // flipping the toggle retries the automatic mic
  if (!state.conversation) clearTimeout(reopenTimer);
  renderControls();
});

// ---- memories panel ----

/** @type {import("./chat.js").MemoryView[]} */
let memories = [];
/** @type {{ id: string, name: string }[]} */
let memoryContexts = [];

/** @param {string} path @param {RequestInit} [init] */
const memoryRequest = async (path, init) => {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body && typeof body.message === "string" ? body.message : `status ${res.status}`);
  return body;
};

/** @param {number} unseen */
const renderBadge = (unseen) => {
  const text = badgeText(unseen);
  memoriesBadge.textContent = text;
  memoriesBadge.hidden = text === "";
  memoriesButton.setAttribute("aria-label", text ? `Memories, ${unseen} new` : "Memories");
};

const loadMemories = async () => {
  const body = await memoryRequest("/memories");
  memories = body.memories;
  memoryContexts = body.contexts;
  return body;
};

const refreshBadge = async () => {
  try {
    renderBadge((await loadMemories()).unseen);
  } catch {
    // The badge is a nicety; the panel shows errors when opened.
  }
};

/** @param {string} text */
const setMemoriesStatus = (text) => {
  memoriesStatus.textContent = text;
};

const renderMemories = () => {
  const groups = groupMemories(memories, memoryContexts);
  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Nothing remembered yet.";
    memoriesList.replaceChildren(empty);
    return;
  }
  memoriesList.replaceChildren(
    ...groups.map((group) => {
      const section = document.createElement("section");
      section.className = "memory-group";
      const heading = document.createElement("h3");
      const title = document.createElement("span");
      title.textContent = `${group.contextName} (${group.count})`;
      const wipe = document.createElement("button");
      wipe.type = "button";
      wipe.textContent = "Wipe all";
      wipe.setAttribute("aria-label", `Wipe all ${group.contextName} memories`);
      wipe.addEventListener("click", () => void wipeContext(group.contextId, group.contextName, group.count));
      heading.append(title, wipe);
      section.append(heading);
      for (const kindGroup of group.kinds) {
        const kindHeading = document.createElement("h4");
        kindHeading.textContent = kindGroup.label;
        const list = document.createElement("ul");
        list.className = "memory-list";
        for (const m of kindGroup.items) {
          const item = document.createElement("li");
          item.className = m.seen ? "memory-item" : "memory-item new";
          const body = document.createElement("div");
          const text = document.createElement("p");
          text.textContent = m.text;
          const meta = document.createElement("span");
          meta.className = "memory-meta";
          meta.textContent = [
            formatMemoryDay(m.updatedAt, state.language),
            ...(m.origin === "explicit" ? ["you asked"] : []),
            ...(m.seen ? [] : ["new"]),
          ].join(" · ");
          body.append(text, meta);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
          remove.setAttribute("aria-label", `Delete memory: ${m.text}`);
          remove.addEventListener("click", () => void deleteMemory(m.id));
          item.append(body, remove);
          list.append(item);
        }
        section.append(kindHeading, list);
      }
      return section;
    }),
  );
};

/** @param {string} id */
const deleteMemory = async (id) => {
  try {
    await memoryRequest(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
    memories = memories.filter((m) => m.id !== id);
    renderMemories();
    setMemoriesStatus("Deleted.");
  } catch (e) {
    setMemoriesStatus(`Couldn't delete it: ${e instanceof Error ? e.message : "unknown error"}`);
  }
};

/** @param {string} contextId @param {string} name @param {number} count */
const wipeContext = async (contextId, name, count) => {
  if (!window.confirm(`Delete all ${count} ${name} memories? This can't be undone.`)) return;
  try {
    const body = await memoryRequest("/memories/wipe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextId }),
    });
    memories = memories.filter((m) => m.contextId !== contextId);
    renderMemories();
    setMemoriesStatus(`Deleted ${body.wiped} ${name} memories.`);
  } catch (e) {
    setMemoriesStatus(`Couldn't wipe them: ${e instanceof Error ? e.message : "unknown error"}`);
  }
};

const openMemories = async () => {
  setMemoriesStatus("Loading…");
  memoriesList.replaceChildren();
  memoriesPanel.showModal();
  try {
    await loadMemories();
    setMemoriesStatus("");
    renderMemories(); // new ones are highlighted this time…
    const unseen = unseenIds(memories);
    if (unseen.length > 0) {
      await memoryRequest("/memories/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: unseen }),
      });
      memories = memories.map((m) => ({ ...m, seen: true })); // …and seen from now on
    }
    renderBadge(0);
  } catch (e) {
    setMemoriesStatus(`Couldn't load memories: ${e instanceof Error ? e.message : "unknown error"}`);
  }
};

memoriesButton.addEventListener("click", () => void openMemories());
memoriesClose.addEventListener("click", () => memoriesPanel.close());
memoriesPanel.addEventListener("close", () => input.focus());

rememberButton.addEventListener("click", () => {
  state.remember = !state.remember;
  setStatus(state.remember ? "Remembering again." : "Nothing from this conversation will be remembered.");
  renderControls();
});

// ---- settings ----

muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  save("jarvis.muted", String(state.muted));
  if (state.muted) stopSpeaking();
  renderVoiceNote();
  renderControls();
});

languageSelect.addEventListener("change", () => {
  state.language = parseLanguage(languageSelect.value);
  save("jarvis.language", state.language);
  if (state.listening && !listenAvailable()) endVoice("reset");
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
  state.remember = true;
  transcript.replaceChildren();
  setStatus("New conversation.");
  renderControls();
  input.focus();
});

// Browsers load voices asynchronously; refresh the menu when they arrive.
synth?.addEventListener?.("voiceschanged", renderVoices);

renderControls();
renderVoices();
void refreshVoice();
void refreshBadge();
input.focus();
