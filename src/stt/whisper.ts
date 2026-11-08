// Whisper, through whisper.cpp's server running on this machine (#74),
// with Metal acceleration on Apple silicon.
//
// The WAV goes to its `/inference` endpoint as a multipart upload. Started
// without --convert, the server decodes it in memory and writes no file;
// without --print-realtime it doesn't print what it heard.

import { err, ok } from "../result.js";
import type { Language } from "../types.js";
import type { SttError, SttProvider } from "./types.js";

/** Whisper's language codes for Jarvis's languages. */
const WHISPER_LANGUAGE: Record<Language, string> = { en: "en" };

/**
 * Whisper's text, cleaned: segments joined into one line, and the markers
 * it writes for non-speech ("[BLANK_AUDIO]", "[Music]", "(silence)") removed.
 */
export const cleanTranscript = (raw: string): string =>
  raw
    .replace(/\[[^\]]*\]|\((?:silence|music|noise|inaudible|blank_audio)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Down: "starting" while voice:up is still waiting for it (#80), else "isn't running". */
const unreachable = async (base: URL, isStarting: (() => Promise<boolean>) | undefined): Promise<SttError> =>
  (await isStarting?.())
    ? { kind: "starting", message: "Whisper is starting (loading its model)" }
    : { kind: "unavailable", message: `Whisper isn't running at ${base.origin} (npm run voice:up)` };

export const makeWhisperStt = (deps: {
  readonly baseUrl: URL;
  readonly fetch?: typeof fetch;
  readonly isStarting?: () => Promise<boolean>;
}): SttProvider => {
  const doFetch = deps.fetch ?? fetch;
  const url = (path: string) => new URL(path, deps.baseUrl).toString();

  return {
    id: "whisper",
    transcribe: async ({ wav, language }, signal) => {
      const form = new FormData();
      // The file name is the only thing whisper-server logs about a request.
      form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "speech.wav");
      form.append("response_format", "json");
      form.append("temperature", "0");
      form.append("language", WHISPER_LANGUAGE[language]);
      let res: Response;
      try {
        res = await doFetch(url("/inference"), { method: "POST", body: form, ...(signal ? { signal } : {}) });
      } catch {
        return err(signal?.aborted ? { kind: "aborted", message: "Cancelled" } : await unreachable(deps.baseUrl, deps.isStarting));
      }
      // 503 while the model is (re)loading.
      if (res.status === 503) return err({ kind: "starting", message: "Whisper is starting (loading its model)" });
      if (!res.ok) return err({ kind: "failed", message: `Whisper answered ${res.status}` });
      try {
        const body = (await res.json()) as { text?: unknown };
        if (typeof body.text !== "string") return err({ kind: "failed", message: "Whisper sent no text" });
        return ok({ text: cleanTranscript(body.text) });
      } catch {
        return err(signal?.aborted ? { kind: "aborted", message: "Cancelled" } : { kind: "failed", message: "Whisper sent an unreadable answer" });
      }
    },
    status: async () => {
      try {
        const res = await doFetch(url("/health"), { signal: AbortSignal.timeout(3000) });
        if (res.ok) return ok(true);
        if (res.status === 503) return err({ kind: "starting", message: "Whisper is starting (loading its model)" });
        return err({ kind: "failed", message: `Whisper answered ${res.status}` });
      } catch {
        return err(await unreachable(deps.baseUrl, deps.isStarting));
      }
    },
  };
};
