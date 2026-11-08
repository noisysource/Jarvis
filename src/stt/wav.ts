// What /transcribe accepts (#74): one WAV file, 16 kHz mono 16-bit PCM, up
// to about a minute. Checked before anything is sent to the service.

import { err, ok, type Result } from "../result.js";
import { parseWavHeader } from "../tts/pcm.js";

export const STT_SAMPLE_RATE = 16_000;
/** About 60 s of 16 kHz 16-bit mono, plus the header. */
export const MAX_WAV_BYTES = 2 * 1024 * 1024;

/** How long the speech is, in ms, or why it can't be used. */
export const checkSpeechWav = (wav: Uint8Array): Result<{ readonly audioMs: number }, string> => {
  const header = parseWavHeader(wav);
  if (header === "more") return err("The audio is incomplete.");
  if ("error" in header) return err(`The audio isn't usable: ${header.error}.`);
  if (header.channels !== 1 || header.bitsPerSample !== 16 || header.sampleRate !== STT_SAMPLE_RATE) {
    return err("Send 16 kHz mono 16-bit WAV.");
  }
  const samples = Math.floor((wav.length - header.dataOffset) / 2);
  if (samples === 0) return err("The audio is empty.");
  return ok({ audioMs: Math.round((samples / STT_SAMPLE_RATE) * 1000) });
};
