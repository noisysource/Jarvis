// The ears (#74):
//
//   GET  /stt          whether listening works right now (the page asks
//                      before opening the mic)
//   POST /transcribe   a 16 kHz mono WAV (Content-Type: audio/wav) → { text }
//
// Behind the Host allowlist like every route. audio/wav isn't a type a
// cross-site form can send, so a browser on another site needs a CORS
// preflight, which this server never answers.
//
// The audio is held in memory for the one request and never stored. The
// transcript is returned to the page only, which sends it to /ask like typed
// text, so the local EC precheck runs on it before any model. Logs carry
// sizes, durations and timings: never the transcript.

import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerEnv } from "./server.js";
import type { SttProvider } from "./stt/types.js";
import { checkSpeechWav, MAX_WAV_BYTES } from "./stt/wav.js";
import type { Language, Logger } from "./types.js";

const errorBody = (message: string) => ({ type: "error" as const, message });

const isWav = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "audio/wav";

const STATUS = { unavailable: 503, starting: 503, failed: 502, aborted: 408 } as const;

export const registerSttRoutes = (
  app: Hono<ServerEnv>,
  deps: { readonly provider: SttProvider; readonly language: Language; readonly log: Logger },
): void => {
  app.get("/stt", async (c) => {
    c.header("Cache-Control", "no-store");
    const status = await deps.provider.status();
    return c.json({
      provider: deps.provider.id,
      language: deps.language,
      ...(status.ok ? { available: true } : { available: false, problem: status.error.message, ...(status.error.kind === "starting" ? { starting: true } : {}) }),
    });
  });

  app.post(
    "/transcribe",
    async (c, next) => {
      if (!isWav(c.req.header("content-type"))) {
        deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_wav" });
        return c.json(errorBody("POST /transcribe needs Content-Type: audio/wav."), 415);
      }
      await next();
    },
    bodyLimit({ maxSize: MAX_WAV_BYTES, onError: (c) => c.json(errorBody("That's too long to transcribe (about a minute at most)."), 413) }),
    async (c) => {
      // The page says which language it's listening in; only the configured one is set up.
      const language = c.req.query("language") ?? deps.language;
      if (language !== deps.language) return c.json(errorBody(`Listening is set up for "${deps.language}" only.`), 400);
      const wav = new Uint8Array(await c.req.arrayBuffer());
      const checked = checkSpeechWav(wav);
      if (!checked.ok) return c.json(errorBody(checked.error), 400);

      const started = performance.now();
      const controller = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => controller.abort());
      const result = await deps.provider.transcribe({ wav, language: deps.language }, controller.signal);
      const fields = {
        requestId: c.get("requestId"),
        provider: deps.provider.id,
        bytes: wav.length,
        audioMs: checked.value.audioMs,
        transcribeMs: Math.round(performance.now() - started),
      };
      if (!result.ok) {
        deps.log.warn("transcribe failed", { ...fields, kind: result.error.kind });
        return c.json(errorBody(result.error.message), STATUS[result.error.kind]);
      }
      deps.log.info("transcribe", { ...fields, empty: result.value.text === "" });
      c.header("Cache-Control", "no-store");
      return c.json({ text: result.value.text });
    },
  );
};
