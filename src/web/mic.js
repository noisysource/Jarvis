// @ts-check
// The mic for a spoken conversation (#74, #75): opened once when you press
// the mic, with echo cancellation, noise suppression and auto gain, and kept
// open (so you can interrupt Jarvis) until the conversation ends. Its audio
// is resampled to 16 kHz and handed out in Silero's 512-sample frames. It
// stays in this page: only an utterance, as a WAV, is sent to this server's
// /transcribe.

import { makeFramer, makeResampler } from "./mic-lib.js";
import { SILERO_FRAME } from "./silero.js";

/** Can this browser record the mic for Whisper? */
export const canRecord = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";

/** @type {WeakMap<AudioContext, Promise<void>>} */
const workletLoaded = new WeakMap();

/**
 * Opens the mic. Rejects if it can't (err.name "NotAllowedError" when blocked).
 * @param {{ ctx: AudioContext, onFrame: (frame: Float32Array) => void }} options
 * @returns {Promise<{ close: () => void }>}
 */
export const openMic = async ({ ctx, onFrame }) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  try {
    await ctx.resume();
    if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule("/mic-worklet.js"));
    await workletLoaded.get(ctx);
  } catch (e) {
    for (const track of stream.getTracks()) track.stop();
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "jarvis-capture");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const resample = makeResampler(ctx.sampleRate);
  const frames = makeFramer(SILERO_FRAME);
  node.port.onmessage = (/** @type {MessageEvent<Float32Array>} */ e) => {
    for (const frame of frames(resample(e.data))) onFrame(frame);
  };
  source.connect(node);
  // Some browsers only run a node that leads to the speakers; a silent gain keeps the mic inaudible.
  node.connect(mute).connect(ctx.destination);
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      for (const track of stream.getTracks()) track.stop();
    },
  };
};
