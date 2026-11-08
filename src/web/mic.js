// @ts-check
// Recording one utterance from the mic (#74): the audio stays in this page
// until it's sent, as a 16 kHz mono WAV, to POST /transcribe on this server.
// The end of what you said is found by mic-lib's endpointer. Nothing is
// stored; the mic is released as soon as the utterance ends.

import { downsample, encodeWav, makeEndpointer, rms, sliceRecording } from "./mic-lib.js";

/** Can this browser record the mic for Whisper? */
export const canRecord = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";

/** @type {Map<AudioContext, Promise<void>>} */
const workletLoaded = new Map();

/**
 * Records until the endpointer says you've finished, `stop()` is called, or
 * `signal` aborts (then no audio is returned).
 *
 * Resolves with the WAV, or null when nothing was said. `reason` is the
 * endpointer's ("end", "max", "no-speech"), "stopped" or "cancelled".
 * Rejects if the mic can't be opened (err.name "NotAllowedError" when blocked).
 *
 * @param {{ ctx: AudioContext, signal?: AbortSignal, noSpeechMs?: number, onSpeech?: () => void }} options
 * @returns {{ done: Promise<{ wav: Uint8Array | null, reason: string, audioMs: number }>, stop: () => void }}
 */
export const recordUtterance = ({ ctx, signal, noSpeechMs, onSpeech }) => {
  // stop() can come before the mic has opened; it's then applied as soon as it does.
  let stopRequested = false;
  /** @type {(() => void) | undefined} */
  let stopNow;
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      await ctx.resume();
      if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule("/mic-worklet.js"));
      await workletLoaded.get(ctx);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "jarvis-capture");
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const endpointer = makeEndpointer(noSpeechMs === undefined ? {} : { noSpeechMs });
      /** @type {Float32Array[]} */
      const chunks = [];

      /** @type {string} */
      const reason = await new Promise((resolve) => {
        const finish = (/** @type {string} */ why) => resolve(why);
        stopNow = () => finish("stopped");
        if (stopRequested) stopNow();
        if (signal?.aborted) finish("cancelled");
        signal?.addEventListener("abort", () => finish("cancelled"), { once: true });
        node.port.onmessage = (/** @type {MessageEvent<Float32Array>} */ e) => {
          chunks.push(e.data);
          const event = endpointer.feed(rms(e.data), (e.data.length / ctx.sampleRate) * 1000);
          if (event === "speech") onSpeech?.();
          if (event === "end" || event === "max" || event === "no-speech") finish(event);
        };
        source.connect(node);
        // Some browsers only run a node that leads to the speakers; a silent gain keeps the mic inaudible.
        node.connect(mute).connect(ctx.destination);
      });
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      mute.disconnect();

      const span = endpointer.span();
      const audioMs = Math.max(0, span.toMs - span.fromMs);
      if (reason === "cancelled" || !endpointer.heard()) return { wav: null, reason, audioMs: 0 };
      const samples = downsample(sliceRecording(chunks, ctx.sampleRate, span), ctx.sampleRate);
      chunks.length = 0;
      return { wav: encodeWav(samples), reason, audioMs };
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
  })();
  return {
    done,
    stop: () => {
      stopRequested = true;
      stopNow?.();
    },
  };
};
