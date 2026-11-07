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
import { handleAsk } from "./ask.js";
import { withLogFields } from "./log.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import type { MemoryStore } from "./memory-store.js";
import { parseAskRequest } from "./request.js";
import type { Deps } from "./types.js";
import { WEB_SECURITY_HEADERS, type WebAssets } from "./web.js";

/** Enough for a 2000-char question plus 20 turns of 4000 chars, with room for JSON overhead. */
export const MAX_BODY_BYTES = 256 * 1024;

const errorBody = (message: string) => ({ type: "error" as const, message });

export type ServerEnv = { Variables: { requestId: string } };

/** The Host values a local browser sends for this server. */
export const localHosts = (port: number): readonly string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

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
  } = {},
): Hono<ServerEnv> => {
  const newRequestId = options.newRequestId ?? randomUUID;
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

      const response = await handleAsk(
        { ...deps, log: withLogFields(deps.log, { requestId: c.get("requestId") }) },
        request.value,
        { requestId: c.get("requestId") },
      );
      return c.json(response);
    },
  );

  if (options.memories) registerMemoryRoutes(app, { store: options.memories, contexts: deps.contexts, log: deps.log });

  app.notFound((c) => c.json(errorBody("Not found."), 404));

  app.onError((e, c) => {
    deps.log.error("unhandled error", { requestId: c.get("requestId"), errorName: e.name });
    return c.json(errorBody("Sorry, something went wrong. Please try again."), 500);
  });

  return app;
};
