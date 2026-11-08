// @ts-check
// Pure helpers for listening (#74): no DOM, so they're unit-tested. The
// page records the mic, turns it into a 16 kHz mono WAV here, and finds the
// end of what you said with a simple level-based endpointer (Silero VAD
// replaces it in #75).

export const STT_SAMPLE_RATE = 16000;

/**
 * Resamples to 16 kHz by averaging each output sample's span of input
 * samples (a box filter, enough to keep speech clean for Whisper).
 * @param {Float32Array} input @param {number} inputRate @returns {Float32Array}
 */
export const downsample = (input, inputRate) => {
  if (inputRate === STT_SAMPLE_RATE) return input.slice();
  if (inputRate < STT_SAMPLE_RATE) throw new Error(`can't resample up from ${inputRate} Hz`);
  const ratio = inputRate / STT_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += input[j] ?? 0;
    out[i] = to > from ? sum / (to - from) : 0;
  }
  return out;
};

/**
 * A 16-bit PCM mono WAV file.
 * @param {Float32Array} samples in -1..1 @param {number} [sampleRate] @returns {Uint8Array}
 */
export const encodeWav = (samples, sampleRate = STT_SAMPLE_RATE) => {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  /** @param {number} at @param {string} text */
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return bytes;
};

/** @param {Float32Array} frame @returns {number} root mean square level, 0..1 */
export const rms = (frame) => {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return frame.length === 0 ? 0 : Math.sqrt(sum / frame.length);
};

/**
 * speechStartMs: this long above the threshold counts as speech starting.
 * endSilenceMs: this long quiet after speech ends the utterance.
 * noSpeechMs: no speech at all for this long gives up.
 * maxMs: an utterance never runs longer (the server takes about a minute).
 * minThreshold / noiseFactor: speech is louder than max(minThreshold, noise floor × noiseFactor).
 * preRollMs: kept before the start of speech, so the first word isn't clipped.
 */
export const ENDPOINT = {
  speechStartMs: 150,
  endSilenceMs: 900,
  noSpeechMs: 8000,
  maxMs: 55000,
  minThreshold: 0.012,
  noiseFactor: 3,
  preRollMs: 300,
};

/**
 * "waiting": no speech yet; "speech": it just started; "speaking": still
 * going; "end": a pause after speech; "max": too long, ended; "no-speech":
 * nothing heard, gave up.
 * @typedef {"waiting" | "speech" | "speaking" | "end" | "max" | "no-speech"} EndpointEvent
 */

/**
 * Finds where speech starts and ends from the level of each short frame.
 * The noise floor is learnt from the frames before speech starts.
 * @param {Partial<typeof ENDPOINT>} [options]
 */
export const makeEndpointer = (options = {}) => {
  const o = { ...ENDPOINT, ...options };
  let elapsed = 0;
  let floor = -1;
  let above = 0;
  let quiet = 0;
  let speaking = false;
  /** When speech started, in ms from the start (including the run-up above the threshold). */
  let speechAt = -1;
  /** Once ended, every later frame gets the same answer. @type {EndpointEvent | undefined} */
  let ended;
  /** @param {EndpointEvent} event */
  const end = (event) => (ended = event);
  return {
    /**
     * @param {number} level the frame's RMS @param {number} frameMs its length
     * @returns {EndpointEvent}
     */
    feed: (level, frameMs) => {
      if (ended) return ended;
      elapsed += frameMs;
      const threshold = Math.max(o.minThreshold, (floor < 0 ? level : floor) * o.noiseFactor);
      if (!speaking) {
        if (level > threshold) {
          above += frameMs;
          if (above >= o.speechStartMs) {
            speaking = true;
            speechAt = elapsed - above;
            return "speech";
          }
        } else {
          above = 0;
          floor = floor < 0 ? level : floor * 0.95 + level * 0.05;
        }
        if (elapsed >= o.noSpeechMs) return end("no-speech");
        return "waiting";
      }
      // A little below the threshold still counts as talking (hysteresis).
      quiet = level < threshold * 0.7 ? quiet + frameMs : 0;
      if (quiet >= o.endSilenceMs) return end("end");
      if (elapsed - speechAt >= o.maxMs) return end("max");
      return "speaking";
    },
    /** Where to cut the recording, in ms from its start: from just before speech to just after it. */
    span: () => ({
      fromMs: speechAt < 0 ? 0 : Math.max(0, speechAt - o.preRollMs),
      toMs: speaking ? Math.max(0, elapsed - Math.max(0, quiet - 200)) : elapsed,
    }),
    heard: () => speaking,
  };
};

/**
 * Joins the recorded chunks between two times into one buffer.
 * @param {Float32Array[]} chunks @param {number} sampleRate @param {{ fromMs: number, toMs: number }} span
 */
export const sliceRecording = (chunks, sampleRate, span) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const from = Math.min(total, Math.floor((span.fromMs / 1000) * sampleRate));
  const to = Math.min(total, Math.max(from, Math.ceil((span.toMs / 1000) * sampleRate)));
  const out = new Float32Array(to - from);
  let at = 0;
  for (const c of chunks) {
    const start = Math.max(from - at, 0);
    const end = Math.min(to - at, c.length);
    if (end > start) out.set(c.subarray(start, end), at + start - from);
    at += c.length;
    if (at >= to) break;
  }
  return out;
};
