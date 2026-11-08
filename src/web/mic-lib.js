// @ts-check
// Pure helpers for listening (#74, #75): no DOM, so they're unit-tested.
// The mic's audio is resampled to 16 kHz, cut into Silero's 512-sample
// frames, kept for a minute, and turned into a WAV for Whisper.

export const STT_SAMPLE_RATE = 16000;

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

/**
 * A resampler to 16 kHz that keeps its place across chunks, so no samples
 * are lost or doubled at chunk boundaries (a box filter: each output sample averages its span of input samples).
 * @param {number} inputRate
 */
export const makeResampler = (inputRate) => {
  if (inputRate < STT_SAMPLE_RATE) throw new Error(`can't resample up from ${inputRate} Hz`);
  const ratio = inputRate / STT_SAMPLE_RATE;
  /** Input samples not yet used, carried to the next chunk. */
  let carry = new Float32Array(0);
  /** Where the next output sample starts, in input samples from the start of carry. */
  let at = 0;
  /** @param {Float32Array} chunk @returns {Float32Array} */
  return (chunk) => {
    const input = new Float32Array(carry.length + chunk.length);
    input.set(carry, 0);
    input.set(chunk, carry.length);
    /** @type {number[]} */
    const out = [];
    while (at + ratio <= input.length) {
      const from = Math.floor(at);
      const to = Math.floor(at + ratio);
      let sum = 0;
      for (let j = from; j < to; j += 1) sum += input[j] ?? 0;
      out.push(to > from ? sum / (to - from) : 0);
      at += ratio;
    }
    const keep = Math.floor(at);
    carry = input.slice(keep);
    at -= keep;
    return Float32Array.from(out);
  };
};

/**
 * Cuts a stream of samples into fixed-size frames.
 * @param {number} size
 */
export const makeFramer = (size) => {
  let pending = new Float32Array(0);
  /** @param {Float32Array} samples @returns {Float32Array[]} */
  return (samples) => {
    const all = new Float32Array(pending.length + samples.length);
    all.set(pending, 0);
    all.set(samples, pending.length);
    /** @type {Float32Array[]} */
    const frames = [];
    let i = 0;
    for (; i + size <= all.length; i += size) frames.push(all.slice(i, i + size));
    pending = all.slice(i);
    return frames;
  };
};

/**
 * The last `max` frames, numbered from 1 (the turn detector's numbering).
 * Older frames are dropped, so the audio kept in the page stays bounded.
 * @param {number} max
 */
export const makeFrameStore = (max) => {
  /** @type {Float32Array[]} */
  const frames = [];
  let first = 1;
  return {
    /** @param {Float32Array} frame */
    push: (frame) => {
      frames.push(frame);
      if (frames.length > max) {
        frames.shift();
        first += 1;
      }
    },
    /** Frames [from, to) joined; what's no longer kept is left out. @param {number} from @param {number} to */
    slice: (from, to) => {
      const parts = frames.slice(Math.max(0, from - first), Math.max(0, to - first));
      const out = new Float32Array(parts.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of parts) {
        out.set(f, o);
        o += f.length;
      }
      return out;
    },
    clear: () => {
      first += frames.length;
      frames.length = 0;
    },
  };
};
