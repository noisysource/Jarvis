// HTTP routes: POST /ask, GET /healthz, the chat page, and (when given a
// store) the Memories panel's /memories routes (memory-routes.ts). The app is built from ready-made
// deps (see app.ts), so tests can run it with stubs and no network.
//
// The local server has no login, so two guards keep other websites out:
// - Host allowlist (local only): a page on another site can point its own
//   hostname at 127.0.0.1 ("DNS rebinding"); its requests then carry that
//   hostname in Host, so anything but 127.0.0.1 / localhost on our port is
//   refused.
// - POST /ask only takes application/json. Cross-site forms and text/plain
//   "simple" requests are refused, and a cross-site JSON request needs a
//   CORS preflight, which this server never answers.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { handleAsk } from "./ask.js";
import { withLogFields } from "./log.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { registerSkillRoutes } from "./skill-routes.js";
import type { MemoryStore } from "./memory-store.js";
import { makeTurnRegistry, type TurnRegistry } from "./turns.js";
import type { TtsConfig, TurnConfig } from "./config.js";
import { registerSttRoutes } from "./stt-routes.js";
import type { SttProvider } from "./stt/types.js";
import { registerTtsRoutes } from "./tts-routes.js";
import type { TtsProviders } from "./tts/registry.js";
import { parseAskRequest } from "./request.js";
import type { Deps } from "./types.js";
import { WEB_SECURITY_HEADERS, type WebAssets } from "./web.js";

/** Enough for a 2000-char question plus 20 turns of 4000 chars, with room for JSON overhead. */
export const MAX_BODY_BYTES = 256 * 1024;

const errorBody = (message: string) => ({ type: "error" as const, message });

export type ServerEnv = { Variables: { requestId: string } };

/** The Host values a local browser sends for this server. */
export const localHosts = (port: number): readonly string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

/** The page asks for a streamed answer with `Accept: text/event-stream`. */
const wantsStream = (accept: string | undefined): boolean =>
  (accept ?? "").split(",").some((part) => part.split(";")[0]?.trim().toLowerCase() === "text/event-stream");

/** Why playback stopped (#89): fixed words only. */
const STOP_REASONS = [
  "finished",
  "barge-in",
  "push-interrupt",
  "new-question",
  "stop",
  "typed",
  "muted",
  "new-conversation",
  "answer-cancelled",
  "stopped",
] as const;
const count = z.number().int().min(0).max(10_000).optional();

const SpokenReport = z
  .object({
    turnId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    interrupted: z.boolean(),
    spoken: z.string().max(4_000),
    // How playback ended (#89): logged as numbers and fixed words, never the text.
    reason: z.enum(STOP_REASONS).optional(),
    played: count,
    total: count,
    voiceErrors: count,
    streamComplete: z.boolean().optional(),
    bargeProb: z.number().int().min(0).max(100).optional(),
    msAfterFirstAudio: z.number().int().min(0).max(600_000).optional(),
  })
  .strict();

/** One turn's latency from the page (#76): numbers, the browser and the voice, never what was said. */
const ms = z.number().int().min(0).max(600_000).optional();
const LatencyReport = z
  .object({
    browser: z.string().regex(/^[a-z]+( \d{1,4})?$/),
    spoken: z.boolean(),
    voice: z.enum(["kokoro", "piper", "browser", "none"]),
    route: z.enum(["precheck", "picked", "sticky", "classifier"]).optional(),
    brain: z.enum(["claude", "local"]).optional(),
    speculative: z.enum(["used", "discarded"]).optional(),
    endOfTurnMs: ms,
    whisperMs: ms,
    whisperServerMs: ms,
    routeMs: ms,
    memoriesMs: ms,
    firstTokenMs: ms,
    firstSentenceMs: ms,
    voiceFirstAudioMs: ms,
    fillerMs: ms,
    firstChunkChars: z.number().int().min(0).max(5000).optional(),
    echoPeak: z.number().int().min(0).max(100).optional(),
    echoRunMs: ms,
    totalMs: ms,
  })
  .strict();

const isJson = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

export const makeServer = (
  deps: Deps,
  options: {
    readonly newRequestId?: () => string;
    /** Accepted Host headers (case-insensitive). Unset = no Host check (production, behind Cloud Run IAM). */
    readonly allowedHosts?: readonly string[];
    /** The chat page's files, served at their paths (e.g. "/", "/app.js"). */
    readonly web?: WebAssets;
    /** The memory store behind the Memories panel's routes. Unset = no /memories routes. */
    readonly memories?: MemoryStore;
    /** Streamed answers waiting for their playback report (#72). */
    readonly turns?: TurnRegistry;
    readonly newTurnId?: () => string;
    /** Jarvis's voice (#73): GET /tts and POST /speak. Unset = no voice routes. */
    readonly tts?: { readonly providers: TtsProviders; readonly config: TtsConfig };
    /** Jarvis's ears (#74): GET /stt and POST /transcribe. Unset = no listening routes. */
    readonly stt?: SttProvider;
    /** How the page runs a spoken turn (#75): GET /voice-settings. */
    readonly turn?: TurnConfig;
    /** Development: the page shows a timing line under each answer (#76). */
    readonly dev?: boolean;
    /** Spoken replies open with a short reaction (bare mode, #92): the page's fillers step back. */
    readonly reactionFirst?: boolean;
    /** Warms the model connection (#76): POST /warm, when a spoken conversation starts. */
    readonly warm?: () => void;
    /** The two brains the page can pick (#88): GET /brains. Ids and labels only. */
    readonly brains?: {
      readonly default: "claude" | "local";
      readonly labels: { readonly claude: string; readonly local: string };
      /** CALENDAR=on (#100): the page notes once that, with Claude, event titles go to Anthropic. */
      readonly calendar?: boolean;
    };
  } = {},
): Hono<ServerEnv> => {
  const newRequestId = options.newRequestId ?? randomUUID;
  const newTurnId = options.newTurnId ?? randomUUID;
  const turns = options.turns ?? makeTurnRegistry({ log: deps.log });
  const allowedHosts = options.allowedHosts?.map((h) => h.toLowerCase());
  const app = new Hono<ServerEnv>();

  // Request id + one access-log line per request (method, path, status, time; no bodies).
  app.use("*", async (c, next) => {
    const requestId = newRequestId();
    c.set("requestId", requestId);
    const started = performance.now();
    await next();
    c.header("X-Request-Id", requestId);
    deps.log.info("request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  // Host allowlist, before any route (including /healthz and 404s).
  if (allowedHosts) {
    app.use("*", async (c, next) => {
      const host = c.req.header("host")?.trim().toLowerCase();
      if (host === undefined || !allowedHosts.includes(host)) {
        // Log the reason only; the Host value comes from the requester.
        deps.log.warn("rejected request", {
          requestId: c.get("requestId"),
          reason: host === undefined ? "missing_host" : "host_not_allowed",
        });
        return c.json(errorBody("This server only accepts requests to localhost."), 403);
      }
      await next();
    });
  }

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  for (const [path, asset] of Object.entries(options.web ?? {})) {
    app.get(path, (c) => {
      for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) c.header(name, value);
      c.header("Content-Type", asset.contentType);
      if (asset.cacheControl) c.header("Cache-Control", asset.cacheControl);
      return c.body(asset.body);
    });
  }

  app.post(
    "/ask",
    async (c, next) => {
      if (!isJson(c.req.header("content-type"))) {
        deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_json" });
        return c.json(errorBody("POST /ask needs Content-Type: application/json."), 415);
      }
      await next();
    },
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("The request is too large."), 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(errorBody("The request body must be JSON."), 400);
      }
      const request = parseAskRequest(body);
      if (!request.ok) return c.json(errorBody(request.error), 400);

      const requestId = c.get("requestId");
      const askDeps = { ...deps, log: withLogFields(deps.log, { requestId }) };

      if (!wantsStream(c.req.header("accept"))) {
        return c.json(await handleAsk(askDeps, request.value, { requestId }));
      }

      // Streaming (#72): start, then each sentence as it completes, then
      // done (an answer) or reply (anything else). Leaving cancels the answer.
      return streamSSE(c, async (stream) => {
        const started = performance.now();
        const turnId = newTurnId();
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        c.req.raw.signal.addEventListener("abort", () => controller.abort());
        let sentences = 0;
        let firstSentenceMs: number | undefined;
        // Latency (#76): numbers only, never content.
        let firstTokenMs: number | undefined;
        const stages: { routeMs?: number; route?: string; memoriesMs?: number; speculative?: string } = {};
        let writes = Promise.resolve();
        const send = (event: string, data: unknown): void => {
          writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined);
        };
        const sendSentences = (list: readonly string[]): void => {
          for (const text of list) {
            firstSentenceMs ??= Math.round(performance.now() - started);
            send("sentence", { index: sentences, text });
            sentences += 1;
          }
        };

        send("start", { turnId });
        const response = await handleAsk(askDeps, request.value, {
          requestId,
          signal: controller.signal,
          // Raw text only for the timing; what's sent is each sentence the honesty guard passed (#96).
          onText: () => {
            firstTokenMs ??= Math.round(performance.now() - started);
          },
          onSentence: (text) => sendSentences([text]),
          ...(options.turn ? { firstClauseAfter: options.turn.firstChunkChars } : {}),
          deferWrapUp: (turn) => turns.hold(turnId, turn),
          onStage: (stage, fields) => {
            if (stage === "route") {
              stages.routeMs = fields.ms;
              if (fields.how) stages.route = fields.how;
              if (fields.speculative) stages.speculative = fields.speculative;
            } else {
              stages.memoriesMs = fields.ms;
            }
          },
        });
        const timing = {
          ...stages,
          ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
          ...(firstSentenceMs !== undefined ? { firstSentenceMs } : {}),
          totalMs: Math.round(performance.now() - started),
        };
        send("timing", timing);
        send(response.type === "answer" ? "done" : "reply", response);
        await writes;
        askDeps.log.info("ask stream", { outcome: controller.signal.aborted ? "cancelled" : response.type, sentences, ...timing });
      });
    },
  );

  // How a streamed answer's playback ended, so its wrap-up can be decided (turns.ts).
  app.post(
    "/ask/spoken",
    async (c, next) => {
      if (!isJson(c.req.header("content-type"))) {
        deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_json" });
        return c.json(errorBody("POST /ask/spoken needs Content-Type: application/json."), 415);
      }
      await next();
    },
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
    async (c) => {
      const body = SpokenReport.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody("Send { turnId, interrupted, spoken }."), 400);
      const { turnId, interrupted, spoken, ...how } = body.data;
      if (how.reason !== undefined) deps.log.info("playback", { requestId: c.get("requestId"), interrupted, ...how });
      const known = turns.report(turnId, { interrupted, spoken });
      // A turn with nothing held (simple voice mode skips the wrap-up) still had its playback logged.
      if (!known && how.reason !== undefined) return c.json({ ok: true, held: false });
      return known ? c.json({ ok: true }) : c.json(errorBody("No answer is waiting for that turn."), 404);
    },
  );

  // Reach 2: Renato's answer to a proposed calendar event. Only "yes" creates it.
  const confirm = deps.calendarConfirm;
  if (confirm) {
    const ConfirmBody = z
      .object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) })
      .strict();
    app.post(
      "/calendar/confirm",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /calendar/confirm needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
      async (c) => {
        const body = ConfirmBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
        const result = await confirm(body.data.id, body.data.decision);
        return c.json(result);
      },
    );
  }

  // A spoken conversation is starting: warm the model connection (#76). No body, nothing returned.
  const warm = options.warm;
  if (warm) {
    app.post("/warm", (c) => {
      warm();
      return c.json({ ok: true });
    });
  }

  // Latency per turn (#76): logged as numbers only, with the browser, to compare stages and browsers.
  app.post(
    "/latency",
    async (c, next) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /latency needs Content-Type: application/json."), 415);
      await next();
    },
    bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
    async (c) => {
      const body = LatencyReport.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody("Send the turn's timings: numbers only."), 400);
      deps.log.info("latency", { requestId: c.get("requestId"), ...body.data });
      return c.json({ ok: true });
    },
  );

  if (options.tts) registerTtsRoutes(app, { ...options.tts, language: "en", log: deps.log });
  if (options.stt) registerSttRoutes(app, { provider: options.stt, language: "en", log: deps.log });
  const brains = options.brains;
  if (brains) {
    app.get("/brains", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({
        default: brains.default,
        brains: [
          { id: "local", label: brains.labels.local },
          { id: "claude", label: brains.labels.claude },
        ],
        calendar: brains.calendar === true,
      });
    });
  }
  const turnConfig = options.turn;
  if (turnConfig) {
    app.get("/voice-settings", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({
        language: "en",
        endOfTurnMs: turnConfig.endOfTurnMs,
        bargeIn: turnConfig.bargeIn,
        dev: options.dev === true,
        reactionFirst: options.reactionFirst === true,
      });
    });
  }
  if (options.memories) registerMemoryRoutes(app, { store: options.memories, contexts: deps.contexts, log: deps.log });
  if (deps.skills) registerSkillRoutes(app, { store: deps.skills, log: deps.log });

  app.notFound((c) => c.json(errorBody("Not found."), 404));

  app.onError((e, c) => {
    deps.log.error("unhandled error", { requestId: c.get("requestId"), errorName: e.name });
    return c.json(errorBody("Sorry, something went wrong. Please try again."), 500);
  });

  return app;
};
