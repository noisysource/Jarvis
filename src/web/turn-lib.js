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
 * What the phase line says (and screen readers read out).
 * @param {Phase} phase @param {"en" | "pt"} language
 */
export const phaseLabel = (phase, language) => {
  const labels = {
    en: { idle: "", listening: "Listening… say “that's all” to stop", thinking: "Thinking…", speaking: "Speaking…" },
    pt: { idle: "", listening: "A ouvir… diz “é tudo” para parar", thinking: "A pensar…", speaking: "A falar…" },
  };
  return labels[language][phase];
};
