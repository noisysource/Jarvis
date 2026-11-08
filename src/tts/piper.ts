// Piper, through its HTTP server running on this machine (#73). Piper
// returns a whole WAV per request; the header is read and the PCM after it
// is passed on as it arrives.

import { err, ok } from "../result.js";
import type { Language } from "../types.js";
import { alignPcm16, bodyChunks, concat, parseWavHeader } from "./pcm.js";
import type { TtsAudio, TtsError, TtsProvider, TtsVoice } from "./types.js";

/** Piper voice names start with the locale: en_GB-alan-medium. */
const LOCALE_PREFIXES: Record<Language, readonly string[]> = { en: ["en_GB-", "en_US-"] };

export const isPiperVoiceFor = (id: string, language: Language): boolean =>
  /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/.test(id) && LOCALE_PREFIXES[language].some((p) => id.startsWith(p));

const unreachable = (base: URL): TtsError => ({ kind: "unavailable", message: `Piper isn't running at ${base.origin} (npm run voice:up)` });

/** Splits a WAV byte stream into its format and the PCM that follows. */
export const readWavStream = async (chunks: AsyncIterable<Uint8Array>): Promise<TtsAudio | { readonly error: string }> => {
  const iterator = chunks[Symbol.asyncIterator]();
  let head: Uint8Array = new Uint8Array(0);
  for (;;) {
    const parsed = parseWavHeader(head);
    if (parsed !== "more") {
      if ("error" in parsed) return parsed;
      if (parsed.channels !== 1 || parsed.bitsPerSample !== 16) return { error: "expected 16-bit mono audio" };
      const rest = head.subarray(parsed.dataOffset);
      return {
        format: "pcm_s16le",
        sampleRate: parsed.sampleRate,
        channels: 1,
        chunks: alignPcm16(
          (async function* () {
            if (rest.length > 0) yield rest;
            for (;;) {
              const { done, value } = await iterator.next();
              if (done) return;
              yield value;
            }
          })(),
        ),
      };
    }
    const { done, value } = await iterator.next();
    if (done) return { error: "the audio ended before its data" };
    head = concat(head, value);
  }
};

export const makePiperTts = (deps: { readonly baseUrl: URL; readonly fetch?: typeof fetch }): TtsProvider => {
  const doFetch = deps.fetch ?? fetch;
  const url = (path: string) => new URL(path, deps.baseUrl).toString();

  return {
    id: "piper",
    speak: async ({ text, language, voice }, signal) => {
      if (!isPiperVoiceFor(voice, language)) return err({ kind: "bad_voice", message: `"${voice}" isn't a Piper ${language} voice` });
      let res: Response;
      try {
        res = await doFetch(url("/synthesize"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice }),
          ...(signal ? { signal } : {}),
        });
      } catch {
        return err(signal?.aborted ? { kind: "aborted", message: "Cancelled" } : unreachable(deps.baseUrl));
      }
      if (!res.ok) {
        return err(
          res.status >= 400 && res.status < 500
            ? { kind: "bad_voice", message: `Piper rejected voice "${voice}" (${res.status})` }
            : { kind: "failed", message: `Piper answered ${res.status}` },
        );
      }
      try {
        const audio = await readWavStream(bodyChunks(res.body));
        return "error" in audio ? err({ kind: "failed", message: `Piper sent ${audio.error}` }) : ok(audio);
      } catch {
        return err(signal?.aborted ? { kind: "aborted", message: "Cancelled" } : { kind: "failed", message: "Piper's audio stopped" });
      }
    },
    listVoices: async (language) => {
      try {
        const res = await doFetch(url("/voices"), { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return err({ kind: "failed", message: `Piper answered ${res.status}` });
        const body = (await res.json()) as Record<string, unknown>;
        const ids = Object.keys(body).filter((id) => isPiperVoiceFor(id, language)).sort();
        return ok(ids.map((id): TtsVoice => ({ id, label: id })));
      } catch {
        return err(unreachable(deps.baseUrl));
      }
    },
  };
};
