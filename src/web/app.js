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
import { browserFamily, chooseVoice, makeTurnDetector, parseSse, phaseLabel, TURN } from "./turn-lib.js";
import { canRecord, openMic } from "./mic.js";
import { encodeWav, makeFrameStore } from "./mic-lib.js";
import { loadVad } from "./vad.js";

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
  const pushToInterrupt = session?.bargeIn === "push" && (state.phase === "speaking" || state.phase === "thinking");
  micButton.setAttribute("aria-pressed", String(session !== null));
  micButton.textContent = session ? (pushToInterrupt ? "✋ Interrupt" : "■ Stop") : "🎤 Speak";
  micButton.title = session ? (pushToInterrupt ? "Interrupt Jarvis and speak (Space)" : "End the spoken conversation (Escape)") : "";
  micButton.classList.toggle("listening", session !== null);
  phaseBanner.dataset.phase = state.phase;
  phaseBanner.hidden = state.phase === "idle";
  phaseText.textContent = phaseLabel(state.phase, state.language, session?.bargeIn ?? null);
  micButton.disabled = !listenAvailable() && session === null;
  if (!listenAvailable()) micButton.title = !micSupported ? "This browser can't record the microphone" : "Listening is English-only for now";
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
 * Tells the server how a streamed answer's playback ended (#72), so it can
 * decide the memory wrap-up: what Jarvis actually said, if he was cut off.
 * @param {string} turnId @param {boolean} interrupted @param {string} spoken
 */
const reportPlayback = (turnId, interrupted, spoken) =>
  fetch("/ask/spoken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId, interrupted, spoken: spoken.slice(0, 4000) }),
  }).catch(() => undefined);

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
  const userItem = context ? undefined : addMessage("user", text);
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
    // You carried on talking before he answered: this question is replaced by the whole one.
    if (controller.signal.reason === "continue") {
      userItem?.remove();
      item?.remove();
      if (turnId !== "") void reportPlayback(turnId, true, "");
      return;
    }
    const remember = view ? view.remember : true; // cut off mid-answer: it was an answer
    if (remember) {
      const said = result.interrupted ? result.spoken || "—" : (view?.text ?? result.spoken);
      state.history = appendTurn(appendTurn(state.history, "user", text), "assistant", said);
    }
    if (result.interrupted) item?.classList.add("interrupted");
    // The server holds a streamed answer's wrap-up until it hears how playback went (#72).
    if (turnId !== "" && (!view || view.kind === "answer")) void reportPlayback(turnId, result.interrupted, result.spoken);
    if (!result.interrupted) {
      if (state.phase === "speaking") setPhase("idle");
      if (reopen) reopenMicSoon();
      else if (session) endVoice("done");
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
 * @param {string} raw @param {{ spoken?: boolean, keepVoice?: boolean }} [how] keepVoice false: the last words of a conversation (Stop)
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
  if (!how.spoken && session) endVoice("reset");
  state.voiceSession = how.spoken === true && how.keepVoice !== false && session !== null;
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

// ---- speech in: the turn manager (#74, #75) ----
//
// Pressing 🎤 opens one spoken conversation: the mic (echo cancellation,
// noise suppression and auto gain on) stays open, every 32 ms frame goes
// through Silero VAD (run in this page from files this server hosts), and a
// turn detector decides when you've finished (a tunable silence, 500 ms by
// default). Your utterance is sent as a 16 kHz WAV to Whisper on this
// machine (/transcribe), its text to /ask like typed text (so the local EC
// precheck runs first), and the answer is spoken sentence by sentence.
//
// Barge-in: while Jarvis speaks the mic stays open; talking over him stops
// the audio at once, cancels the answer and what's still being fetched, and
// what you're saying becomes the next question. History keeps only what he
// actually said. How it works is set per browser (GET /voice-settings):
// "vad", "strict" (it takes clearer speech, for weaker echo cancellation) or
// "push" (the mic is ignored while he talks; tap ✋ Interrupt or press Space).
//
// The browser's own speech recognition (audio to Google or Apple) isn't
// used, and there's no fallback to it.

const micSupported = canRecord();
/** Local listening is English-only for now (#74); Portuguese is typed. */
const listenAvailable = () => micSupported && state.language === "en";

/** About a minute of recent mic audio, in 32 ms frames: enough for the longest utterance. */
const KEPT_FRAMES = Math.ceil(60_000 / TURN.frameMs);
/** You carried on talking within this long of your turn ending: it's the same question. */
const CONTINUE_WITHIN_MS = 4000;

/**
 * The open spoken conversation, if any.
 * @type {{
 *   mic: { close: () => void },
 *   detector: ReturnType<typeof makeTurnDetector>,
 *   store: ReturnType<typeof makeFrameStore>,
 *   bargeIn: import("./turn-lib.js").BargeInMode,
 *   oneShot: boolean,
 *   ignoreUntil: number,
 *   heard: boolean,
 *   lastTurn: { from: number, endedAt: number } | null,
 * } | null}
 */
let session = null;
/** The utterance being transcribed, so it can be cancelled. @type {AbortController | undefined} */
let transcribing;

/** The browser wouldn't open the mic by itself: fall back to the button, with a note. */
const blockAuto = () => {
  state.autoBlocked = true;
  state.voiceSession = false;
  setStatus("");
  renderControls();
};

/**
 * Ends the spoken conversation: closes the mic.
 * @param {"silence" | "phrase" | "user" | "reset" | "done"} reason
 */
const endVoice = (reason) => {
  const open = session;
  session = null;
  state.voiceSession = false;
  state.listening = false;
  if (open) {
    // Tapping Stop mid-sentence still sends what was heard.
    if (reason === "user" && open.heard && !state.busy && !state.transcribing) {
      const { from, to } = open.detector.span();
      void transcribeAndSend(open.store.slice(from, to), { final: true });
    }
    open.mic.close();
  }
  if (reason === "user" || reason === "reset") {
    stopSpeaking();
    answering?.abort();
  }
  if (state.phase === "listening" || (state.phase === "speaking" && !isSpeaking())) state.phase = "idle";
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

/** How this browser interrupts, from GET /voice-settings. */
const voiceSettings = async () => {
  /** @type {{ endOfTurnMs: number, bargeIn: import("./turn-lib.js").BargeInMode }} */
  const fallback = { endOfTurnMs: TURN.endSilenceMs, bargeIn: "vad" };
  try {
    const res = await fetch("/voice-settings");
    if (!res.ok) return fallback;
    const body = await res.json();
    const family = browserFamily(navigator.userAgent);
    const mode = body?.bargeIn?.[family === "firefox" ? "other" : family] ?? body?.bargeIn?.other;
    return {
      endOfTurnMs: Number.isInteger(body?.endOfTurnMs) ? body.endOfTurnMs : fallback.endOfTurnMs,
      bargeIn: mode === "strict" || mode === "push" ? mode : "vad",
    };
  } catch {
    return fallback;
  }
};

/**
 * Sends an utterance to Whisper, then its text as a spoken question.
 * @param {Float32Array} samples 16 kHz @param {{ final?: boolean }} [how] final: the conversation ended with it (Stop)
 */
const transcribeAndSend = async (samples, how = {}) => {
  const controller = new AbortController();
  transcribing = controller;
  state.transcribing = true;
  setPhase("thinking");
  renderControls();
  let text = "";
  let problem = "";
  try {
    const res = await fetch(`/transcribe?language=${state.language}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: /** @type {Uint8Array<ArrayBuffer>} */ (encodeWav(samples)),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (res.ok && typeof body?.text === "string") text = body.text;
    else problem = typeof body?.message === "string" ? body.message : `Listening failed (status ${res.status}).`;
  } catch {
    problem = controller.signal.aborted ? "" : "I can't reach Jarvis. Is the server running?";
  }
  if (transcribing === controller) transcribing = undefined;
  state.transcribing = false;
  if (controller.signal.aborted) return; // you carried on talking: it's being sent again, whole
  if (state.phase === "thinking") state.phase = session ? "listening" : "idle";
  renderControls();
  if (problem !== "") {
    endVoice("reset");
    setStatus(problem);
    return;
  }
  if (text === "") {
    // A cough, or words Whisper couldn't make out: keep listening.
    if (session) session.detector.listen();
    else setStatus("I didn't catch that.");
    return;
  }
  input.value = text;
  submit(text, { spoken: true, keepVoice: how.final !== true });
};

/**
 * You spoke over Jarvis (or tapped Interrupt): stop him at once and listen.
 * If he hadn't started answering yet, you're carrying on with the same
 * question: it's cancelled and sent again, whole, when you finish.
 */
const interrupt = () => {
  const open = session;
  if (!open) return;
  const last = open.lastTurn;
  const stillThinking = !isSpeaking() && (state.busy || state.transcribing);
  if (stillThinking && last && performance.now() - last.endedAt < CONTINUE_WITHIN_MS) {
    transcribing?.abort();
    answering?.abort("continue");
    open.detector.continueFrom(last.from);
  } else {
    stopSpeaking(); // the playback report and history are settled right here
    answering?.abort();
    synth?.cancel();
  }
  open.heard = true;
  open.lastTurn = null;
  state.phase = "listening";
  renderControls();
};

/** @param {number} p Silero's probability for the newest frame */
const onProbability = (p) => {
  const open = session;
  if (!open || performance.now() < open.ignoreUntil) return;
  const talking = isSpeaking() || state.busy || state.transcribing;
  const event = open.detector.feed(p, talking);
  if (event === "start") {
    open.heard = true;
  } else if (event === "barge-in") {
    interrupt();
  } else if (event === "end" || event === "max") {
    const { from, to } = open.detector.span();
    open.lastTurn = { from, endedAt: performance.now() };
    open.heard = false;
    void transcribeAndSend(open.store.slice(from, to));
  } else if (event === "no-speech") {
    endVoice(state.conversation ? "silence" : "done");
    if (!state.conversation) setStatus("I didn't hear anything.");
  }
};

/** Opens the mic and starts a spoken conversation. */
const startVoice = async () => {
  if (!listenAvailable() || session) return;
  const ctx = audio(); // on the tap, so the browser lets it start
  setStatus("");
  const [ready, settings, vad] = await Promise.all([
    sttStatus(),
    voiceSettings(),
    loadVad().catch((e) => /** @type {Error} */ (e)),
  ]);
  if (!ready.ok) {
    setStatus(ready.problem);
    return;
  }
  if (vad instanceof Error) {
    setStatus(`Voice detection couldn't start (${vad.message}).`);
    return;
  }
  if (session) return; // pressed twice
  const detector = makeTurnDetector({ endSilenceMs: settings.endOfTurnMs, bargeIn: settings.bargeIn, noSpeechMs: CONVERSATION.silenceMs });
  const store = makeFrameStore(KEPT_FRAMES);
  /** @type {{ close: () => void }} */
  let mic;
  try {
    mic = await openMic({
      ctx,
      onFrame: (frame) => {
        store.push(frame);
        vad.probability(frame).then(onProbability, () => undefined);
      },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const blocked = name === "NotAllowedError" || name === "SecurityError";
    setStatus(blocked ? "Microphone access was blocked. Allow it in the browser to speak to Jarvis." : "Couldn't start the microphone.");
    if (blocked) blockAuto();
    return;
  }
  vad.reset();
  session = {
    mic,
    detector,
    store,
    bargeIn: settings.bargeIn,
    oneShot: !state.conversation,
    ignoreUntil: 0,
    heard: false,
    lastTurn: null,
  };
  state.voiceSession = true;
  state.autoBlocked = false;
  state.listening = true;
  state.phase = isSpeaking() ? "speaking" : "listening";
  renderControls();
};

/** After Jarvis has answered: listen for the next turn, or close the mic after a one-off question. */
const reopenMicSoon = () => {
  const open = session;
  if (!open) return;
  if (open.oneShot || !state.conversation) {
    endVoice("done");
    return;
  }
  // A moment's pause, so the tail of his voice isn't taken for yours.
  open.ignoreUntil = performance.now() + CONVERSATION.reopenDelayMs;
  open.detector.listen();
  open.heard = false;
  state.phase = "listening";
  renderControls();
};

micButton.addEventListener("click", () => {
  if (session && session.bargeIn === "push" && (isSpeaking() || state.busy)) {
    session.detector.interrupt();
    interrupt();
    return;
  }
  if (session) {
    endVoice("user");
    return;
  }
  stopSpeaking();
  void startVoice();
});

// Push-to-interrupt from the keyboard: Space (outside the text box); Escape stops.
document.addEventListener("keydown", (event) => {
  if (!session || event.target === input) return;
  if (event.key === "Escape") {
    endVoice("user");
  } else if (event.key === " " && session.bargeIn === "push" && (isSpeaking() || state.busy)) {
    event.preventDefault();
    session.detector.interrupt();
    interrupt();
  }
});

conversationButton.addEventListener("click", () => {
  state.conversation = !state.conversation;
  save("jarvis.conversation", String(state.conversation));
  state.autoBlocked = false; // flipping the toggle retries the automatic mic
  if (session) session.oneShot = !state.conversation;
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
