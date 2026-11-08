// @ts-check
// Playing Jarvis's voice from POST /speak (#73): streamed 16-bit mono PCM,
// scheduled on Web Audio as it arrives. The pure helpers are unit-tested;
// `playSpeech` drives an AudioContext. Shared by /voices and, in #75, the
// turn manager.

import { pcm16ToFloat32, readAudioFormat } from "./pcm-lib.js";

export { pcm16ToFloat32, readAudioFormat };

/** Samples per scheduled buffer: big enough to avoid gaps, small enough to start soon (~85 ms at 24 kHz). */
const MIN_SAMPLES = 2048;

/**
 * Plays a /speak response as it arrives. Resolves when playback has ended
 * (or was stopped). `onFirstAudio` is called with the time, from
 * `performance.now()`, at which the first sound actually starts.
 * @param {{ ctx: AudioContext, response: Response, signal?: AbortSignal, onFirstAudio?: (atMs: number) => void }} options
 * @returns {Promise<{ playedSeconds: number, totalSeconds: number, stopped: boolean }>}
 */
export const playSpeech = async ({ ctx, response, signal, onFirstAudio }) => {
  const format = readAudioFormat(response.headers);
  if (!format || !response.body) throw new Error("Jarvis's voice sent audio this page can't play.");
  const reader = response.body.getReader();
  /** @type {AudioBufferSourceNode[]} */
  const sources = [];
  let startAt = 0;
  let nextTime = 0;
  let totalSeconds = 0;
  let stopped = false;
  /** @type {Uint8Array} */
  let pending = new Uint8Array(0);

  const stop = () => {
    stopped = true;
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* not started yet */
      }
    }
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", stop);

  /** @param {Uint8Array} bytes */
  const schedule = (bytes) => {
    const samples = pcm16ToFloat32(bytes);
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, format.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const when = Math.max(nextTime, ctx.currentTime + 0.02);
    if (sources.length === 0) {
      startAt = when;
      onFirstAudio?.(performance.now() + (when - ctx.currentTime) * 1000);
    }
    source.start(when);
    sources.push(source);
    nextTime = when + buffer.duration;
    totalSeconds += buffer.duration;
  };

  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending, 0);
      merged.set(value, pending.length);
      const usable = merged.length - (merged.length % 2);
      if (usable / 2 >= MIN_SAMPLES || sources.length > 0) {
        schedule(merged.subarray(0, usable));
        pending = merged.slice(usable);
      } else {
        pending = merged;
      }
    }
    if (!stopped && pending.length >= 2) schedule(pending.subarray(0, pending.length - (pending.length % 2)));
  } catch {
    if (!stopped) throw new Error("Jarvis's voice stopped part-way.");
  }

  if (!stopped && sources.length > 0) {
    await new Promise((resolve) => {
      const last = sources[sources.length - 1];
      if (!last) return resolve(undefined);
      last.onended = () => resolve(undefined);
      signal?.addEventListener("abort", () => resolve(undefined));
    });
  }
  signal?.removeEventListener("abort", stop);
  const playedSeconds = stopped ? Math.max(0, Math.min(totalSeconds, ctx.currentTime - startAt)) : totalSeconds;
  return { playedSeconds, totalSeconds, stopped };
};
