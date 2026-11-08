// The mouth (#73):
//
//   GET  /tts     the configured provider and voice, and every provider's
//                 voices for the language (for /voices and the turn manager)
//   POST /speak   { text, provider?, voice? } → streamed 16-bit mono PCM,
//                 with X-Audio-Format / X-Sample-Rate headers
//
// Behind the same guards as /ask: the Host allowlist, and JSON-only POSTs.
// The text is never stored or logged; logs carry provider, voice, length
// and timings. Leaving early (barge-in) cancels the synthesis.

import type { Context as HonoContext, Hono } from "hono";
import { z } from "zod";
import type { TtsConfig } from "./config.js";
import type { ServerEnv } from "./server.js";
import type { TtsProviders } from "./tts/registry.js";
import type { TtsProviderId } from "./tts/types.js";
import type { Language, Logger } from "./types.js";

export const MAX_SPEAK_CHARS = 1_000;

const SpeakBody = z
  .object({
    text: z.string().trim().min(1).max(MAX_SPEAK_CHARS),
    provider: z.enum(["kokoro", "piper"]).optional(),
    voice: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  })
  .strict();

const errorBody = (message: string) => ({ type: "error" as const, message });

const isJson = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

// "aborted" means the client already left; any status will do.
const STATUS = { unavailable: 503, bad_voice: 400, failed: 502, aborted: 408 } as const;

export const registerTtsRoutes = (
  app: Hono<ServerEnv>,
  deps: { readonly providers: TtsProviders; readonly config: TtsConfig; readonly language: Language; readonly log: Logger },
): void => {
  app.get("/tts", async (c) => {
    const ids: readonly TtsProviderId[] = ["kokoro", "piper", "browser"];
    const providers = await Promise.all(
      ids.map(async (id) => {
        const voices = await deps.providers[id].listVoices(deps.language);
        return voices.ok
          ? { id, available: true, voices: voices.value }
          : { id, available: false, voices: [], problem: voices.error.message };
      }),
    );
    c.header("Cache-Control", "no-store");
    return c.json({ language: deps.language, provider: deps.config.provider, voice: deps.config.voice, providers });
  });

  app.post("/speak", async (c: HonoContext<ServerEnv>) => {
    if (!isJson(c.req.header("content-type"))) {
      deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_json" });
      return c.json(errorBody("POST /speak needs Content-Type: application/json."), 415);
    }
    const body = SpeakBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(errorBody(`Send { text } (up to ${MAX_SPEAK_CHARS} characters), optionally provider and voice.`), 400);

    const providerId = body.data.provider ?? deps.config.provider;
    if (providerId === "browser") return c.json(errorBody("The browser voice plays in the page."), 400);
    const voice = body.data.voice ?? deps.config.voice;
    if (voice === "") return c.json(errorBody(`No voice set for ${providerId}: set TTS_VOICE, or send a voice.`), 400);

    const started = performance.now();
    const controller = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => controller.abort());
    const audio = await deps.providers[providerId].speak({ text: body.data.text, language: deps.language, voice }, controller.signal);
    const logFields = { requestId: c.get("requestId"), provider: providerId, voice, chars: body.data.text.length };
    if (!audio.ok) {
      deps.log.warn("speak failed", { ...logFields, kind: audio.error.kind });
      return c.json(errorBody(audio.error.message), STATUS[audio.error.kind]);
    }

    const iterator = audio.value.chunks[Symbol.asyncIterator]();
    let firstByteMs: number | undefined;
    let bytes = 0;
    const finish = (outcome: string) =>
      deps.log.info("speak", { ...logFields, outcome, bytes, ...(firstByteMs !== undefined ? { firstByteMs } : {}), totalMs: Math.round(performance.now() - started) });
    const stream = new ReadableStream<Uint8Array>({
      pull: async (out) => {
        try {
          const { done, value } = await iterator.next();
          if (done) {
            out.close();
            finish("done");
            return;
          }
          firstByteMs ??= Math.round(performance.now() - started);
          bytes += value.length;
          out.enqueue(value);
        } catch {
          out.error(new Error("speech stopped"));
          finish(controller.signal.aborted ? "cancelled" : "failed");
        }
      },
      cancel: async () => {
        controller.abort();
        await iterator.return?.();
        finish("cancelled");
      },
    });
    return c.body(stream, 200, {
      "Content-Type": "application/octet-stream",
      "X-Audio-Format": audio.value.format,
      "X-Sample-Rate": String(audio.value.sampleRate),
      "X-Channels": "1",
      "Cache-Control": "no-store",
    });
  });
};
