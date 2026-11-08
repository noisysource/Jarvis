// Kokoro, through Kokoro-FastAPI running on this machine (#73). Uses its
// OpenAI-compatible speech endpoint with streamed raw PCM (24 kHz mono
// 16-bit), so audio starts while later parts are still being generated.

import { err, ok } from "../result.js";
import type { Language } from "../types.js";
import { alignPcm16, bodyChunks } from "./pcm.js";
import type { TtsError, TtsProvider, TtsVoice } from "./types.js";

export const KOKORO_SAMPLE_RATE = 24_000;

/** Kokoro voice ids start with a language letter: a = American English, b = British English. */
const LANGUAGE_PREFIXES: Record<Language, readonly string[]> = { en: ["a", "b"] };
const ACCENTS: Record<string, string> = { a: "American", b: "British" };

export const kokoroVoiceLabel = (id: string): string => {
  const accent = ACCENTS[id[0] ?? ""] ?? "";
  const gender = id[1] === "f" ? "female" : id[1] === "m" ? "male" : "";
  const details = [accent, gender].filter(Boolean).join(", ");
  return details ? `${id} (${details})` : id;
};

export const isKokoroVoiceFor = (id: string, language: Language): boolean =>
  /^[a-z][fm]_[a-z0-9_]+$/.test(id) && LANGUAGE_PREFIXES[language].includes(id[0] ?? "");

/** Down: "starting" while voice:up is still waiting for it (#80), else "isn't running". */
const unreachable = async (base: URL, isStarting: (() => Promise<boolean>) | undefined): Promise<TtsError> =>
  (await isStarting?.())
    ? { kind: "starting", message: `Kokoro is starting (the first start takes a minute or two)` }
    : { kind: "unavailable", message: `Kokoro isn't running at ${base.origin} (npm run voice:up)` };

export const makeKokoroTts = (deps: { readonly baseUrl: URL; readonly fetch?: typeof fetch; readonly isStarting?: () => Promise<boolean> }): TtsProvider => {
  const doFetch = deps.fetch ?? fetch;
  const url = (path: string) => new URL(path, deps.baseUrl).toString();

  return {
    id: "kokoro",
    speak: async ({ text, language, voice }, signal) => {
      if (!isKokoroVoiceFor(voice, language)) return err({ kind: "bad_voice", message: `"${voice}" isn't a Kokoro ${language} voice` });
      let res: Response;
      try {
        res = await doFetch(url("/v1/audio/speech"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "kokoro", input: text, voice, response_format: "pcm", stream: true, speed: 1 }),
          ...(signal ? { signal } : {}),
        });
      } catch {
        return err(signal?.aborted ? { kind: "aborted", message: "Cancelled" } : await unreachable(deps.baseUrl, deps.isStarting));
      }
      if (!res.ok) {
        return err(
          res.status === 400 || res.status === 404 || res.status === 422
            ? { kind: "bad_voice", message: `Kokoro rejected voice "${voice}" (${res.status})` }
            : { kind: "failed", message: `Kokoro answered ${res.status}` },
        );
      }
      return ok({ format: "pcm_s16le", sampleRate: KOKORO_SAMPLE_RATE, channels: 1, chunks: alignPcm16(bodyChunks(res.body)) });
    },
    listVoices: async (language) => {
      try {
        const res = await doFetch(url("/v1/audio/voices"), { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return err({ kind: "failed", message: `Kokoro answered ${res.status}` });
        const body = (await res.json()) as { voices?: unknown };
        const ids = (Array.isArray(body.voices) ? body.voices : [])
          .map((v) => (typeof v === "string" ? v : typeof v === "object" && v !== null && "id" in v ? String((v as { id: unknown }).id) : ""))
          .filter((id) => isKokoroVoiceFor(id, language))
          .sort();
        return ok(ids.map((id): TtsVoice => ({ id, label: kokoroVoiceLabel(id) })));
      } catch {
        return err(await unreachable(deps.baseUrl, deps.isStarting));
      }
    },
  };
};
