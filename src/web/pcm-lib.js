// @ts-check
// Pure helpers for playing /speak audio (#73): no DOM, so they're unit-tested.

/** @param {Uint8Array} bytes 16-bit little-endian samples @returns {Float32Array} */
export const pcm16ToFloat32 = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
};

/**
 * The audio format of a /speak response, or null if it isn't one we can play.
 * @param {{ get: (name: string) => string | null }} headers
 */
export const readAudioFormat = (headers) => {
  const sampleRate = Number(headers.get("x-sample-rate"));
  if (headers.get("x-audio-format") !== "pcm_s16le" || headers.get("x-channels") !== "1") return null;
  return Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000 ? { sampleRate } : null;
};
