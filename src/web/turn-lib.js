// @ts-check
// Pure helpers for spoken turns (#82, #75): no DOM, so they're unit-tested.

/**
 * Reads server-sent events from a growing text buffer. Returns the complete
 * events and the unfinished rest, to prepend to the next chunk.
 * @param {string} buffer
 * @returns {{ events: { event: string, data: string }[], rest: string }}
 */
export const parseSse = (buffer) => {
  const normalised = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalised.split("\n\n");
  const rest = blocks.pop() ?? "";
  /** @type {{ event: string, data: string }[]} */
  const events = [];
  for (const block of blocks) {
    let event = "message";
    /** @type {string[]} */
    const data = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
};

/**
 * What Jarvis actually said: the sentences played in full, then the one cut
 * off, up to the share of it that played (at a word boundary), ending in "—".
 * @param {readonly string[]} sentences
 * @param {{ full: number, cutFraction?: number }} played
 *   full: how many sentences played to the end; cutFraction: 0..1 of the next one
 */
export const spokenText = (sentences, played) => {
  const done = sentences.slice(0, played.full).join(" ");
  const next = sentences[played.full];
  const fraction = played.cutFraction ?? 0;
  if (next === undefined || fraction <= 0) return done;
  const words = next.split(/\s+/).filter(Boolean);
  const keep = Math.floor(words.length * Math.min(1, fraction));
  if (keep === 0) return done === "" ? "" : `${done}—`;
  const cut = words.slice(0, keep).join(" ").replace(/[.,;:!?]+$/, "");
  return `${done === "" ? "" : `${done} `}${cut}—`;
};

/**
 * Which voice the page uses, from GET /tts: the configured server voice when
 * it's running, else the browser's (with why, unless the browser voice is
 * what's configured).
 * @param {{ provider?: string, voice?: string, providers?: { id: string, available: boolean, problem?: string }[] } | null} info
 * @returns {{ server: { provider: string, voice: string } | null, note: string }}
 */
export const chooseVoice = (info) => {
  if (!info || typeof info.provider !== "string") return { server: null, note: "Jarvis's voice settings couldn't be read, so it's using the browser voice." };
  if (info.provider === "browser") return { server: null, note: "" };
  const status = (info.providers ?? []).find((p) => p.id === info.provider);
  if (!info.voice) return { server: null, note: `No ${info.provider} voice is set (TTS_VOICE), so Jarvis is using the browser voice.` };
  if (!status?.available) {
    return { server: null, note: `${status?.problem ?? `${info.provider} isn't available`}, so Jarvis is using the browser voice.` };
  }
  return { server: { provider: info.provider, voice: info.voice }, note: "" };
};

/** @typedef {"idle" | "listening" | "thinking" | "speaking"} Phase */

/**
 * What the phase line says (and screen readers read out). While speaking in
 * a conversation it says how to interrupt.
 * @param {Phase} phase @param {"en" | "pt"} language @param {BargeInMode | null} [bargeIn] null: no conversation open
 */
export const phaseLabel = (phase, language, bargeIn = null) => {
  const labels = {
    en: { idle: "", listening: "Listening… say “that's all” to stop", thinking: "Thinking…", speaking: "Speaking…" },
    pt: { idle: "", listening: "A ouvir… diz “é tudo” para parar", thinking: "A pensar…", speaking: "A falar…" },
  };
  const hint = {
    en: { vad: "just talk to interrupt", strict: "speak up to interrupt", push: "tap ✋ Interrupt or press Space" },
    pt: { vad: "fala para interromper", strict: "fala alto para interromper", push: "toca em ✋ Interromper ou carrega em Espaço" },
  };
  const label = labels[language][phase];
  return phase === "speaking" && bargeIn ? `${label} ${hint[language][bargeIn]}` : label;
};

/**
 * How barge-in works in a browser (#75), set per browser in config:
 * "vad": speaking over Jarvis interrupts him (needs good echo cancellation);
 * "strict": the same, but it takes clearer, longer speech while he talks;
 * "push": the mic is ignored while he talks; tap Interrupt (or press Space).
 * @typedef {"vad" | "strict" | "push"} BargeInMode
 */

/** @typedef {"chrome" | "safari" | "firefox" | "other"} BrowserFamily */

/** @param {string} userAgent @returns {BrowserFamily} */
export const browserFamily = (userAgent) => {
  if (/Firefox\//.test(userAgent)) return "firefox";
  if (/(Chrome|Chromium|CriOS|Edg)\//.test(userAgent)) return "chrome";
  if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) return "safari";
  return "other";
};

/**
 * Silero thresholds and timings. Frames are 32 ms (512 samples at 16 kHz).
 * speech/silence: probabilities above / below which a frame is speech / quiet.
 * minSpeechMs: this much speech starts an utterance (a click or a cough doesn't).
 * endSilenceMs: this much quiet after speech ends the turn (config, default 500).
 * bargeIn: while Jarvis is speaking, per mode.
 */
export const TURN = {
  frameMs: 32,
  speech: 0.5,
  silence: 0.35,
  minSpeechMs: 96,
  endSilenceMs: 500,
  preRollMs: 320,
  noSpeechMs: 8000,
  maxMs: 55000,
  bargeIn: {
    vad: { speech: 0.5, minSpeechMs: 200 },
    strict: { speech: 0.85, minSpeechMs: 450 },
  },
};

/**
 * "quiet": nothing yet; "start": speech just started; "speech": still going;
 * "end": the turn ended (a pause after speech); "max": too long, ended;
 * "no-speech": nothing said for a while; "barge-in": you spoke over Jarvis.
 * @typedef {"quiet" | "start" | "speech" | "end" | "max" | "no-speech" | "barge-in"} TurnEvent
 */

/**
 * Turns Silero's per-frame probabilities into turn events. `feed` takes the
 * frame's probability and whether Jarvis is talking (or thinking) right now:
 * then only barge-in is looked for, with that mode's thresholds; "push"
 * ignores the mic until `interrupt()`.
 *
 * Frames are counted from the start, so `span()` says which to send to Whisper.
 * @param {{ endSilenceMs?: number, bargeIn?: BargeInMode, noSpeechMs?: number }} [options]
 */
export const makeTurnDetector = (options = {}) => {
  const endSilenceMs = options.endSilenceMs ?? TURN.endSilenceMs;
  const noSpeechMs = options.noSpeechMs ?? TURN.noSpeechMs;
  const bargeIn = options.bargeIn ?? "vad";
  let frame = 0;
  let run = 0; // consecutive speech frames before the utterance started
  let quiet = 0;
  /** @type {number | undefined} frame where the current utterance's speech began */
  let speechFrom;
  let quietSince = 0; // frame since which nothing has been said (for no-speech)
  /** @type {"listening" | "ended"} */
  let status = "listening";
  let endedAt = 0; // the frame the turn ended on
  /** @param {TurnEvent} event */
  const end = (event) => {
    status = "ended";
    endedAt = frame;
    return event;
  };
  const ms = (/** @type {number} */ frames) => frames * TURN.frameMs;

  /** Starts listening afresh: after a turn was sent, or after interrupting. */
  const listen = () => {
    status = "listening";
    speechFrom = undefined;
    run = 0;
    quiet = 0;
    quietSince = frame;
  };

  return {
    /**
     * @param {number} p Silero's probability for this frame
     * @param {boolean} jarvisTalking
     * @returns {TurnEvent}
     */
    feed: (p, jarvisTalking) => {
      frame += 1;
      if (jarvisTalking) {
        // Only an interruption counts; the utterance it starts is listened to as usual.
        speechFrom = undefined;
        quietSince = frame;
        if (bargeIn === "push") return "quiet";
        const t = TURN.bargeIn[bargeIn];
        run = p >= t.speech ? run + 1 : 0;
        if (ms(run) < t.minSpeechMs) return "quiet";
        listen();
        speechFrom = frame - run;
        run = 0;
        return "barge-in";
      }
      if (status === "ended") return "quiet";
      if (speechFrom === undefined) {
        run = p >= TURN.speech ? run + 1 : p < TURN.silence ? 0 : run;
        if (ms(run) >= TURN.minSpeechMs) {
          speechFrom = frame - run;
          run = 0;
          quiet = 0;
          return "start";
        }
        if (ms(frame - quietSince) >= noSpeechMs) return end("no-speech");
        return "quiet";
      }
      quiet = p < TURN.silence ? quiet + 1 : p >= TURN.speech ? 0 : quiet;
      if (ms(quiet) >= endSilenceMs) return end("end");
      if (ms(frame - speechFrom) >= TURN.maxMs) return end("max");
      return "speech";
    },
    /** The frames to send, as [from, to): from just before speech to just after it. */
    span: () => {
      const last = status === "ended" ? endedAt : frame;
      const from = Math.max(1, (speechFrom ?? last) - Math.round(TURN.preRollMs / TURN.frameMs));
      const tail = Math.max(0, quiet - Math.round(200 / TURN.frameMs));
      return { from, to: last - tail + 1 };
    },
    /** Push-to-interrupt, or Stop: listen afresh from now. */
    interrupt: () => listen(),
    /**
     * You carried on talking after the turn ended (while Jarvis was still
     * thinking): treat it as one utterance, from where the last one began.
     * @param {number} fromFrame
     */
    continueFrom: (fromFrame) => {
      listen();
      speechFrom = Math.min(fromFrame, frame);
    },
    listen,
    frame: () => frame,
    heard: () => speechFrom !== undefined,
  };
};
