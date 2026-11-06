// HTTP routes: POST /ask and GET /healthz. The app is built from ready-made
// deps (see app.ts), so tests can run it with stubs and no network.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { handleAsk } from "./ask.js";
import { withLogFields } from "./log.js";
import { parseAskRequest } from "./request.js";
import type { Deps } from "./types.js";

/** Enough for a 2000-char question plus 20 turns of 4000 chars, with room for JSON overhead. */
export const MAX_BODY_BYTES = 256 * 1024;

const errorBody = (message: string) => ({ type: "error" as const, message });

export type ServerEnv = { Variables: { requestId: string } };

export const makeServer = (deps: Deps, options: { readonly newRequestId?: () => string } = {}): Hono<ServerEnv> => {
  const newRequestId = options.newRequestId ?? randomUUID;
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

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.post(
    "/ask",
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
      );
      return c.json(response);
    },
  );

  app.notFound((c) => c.json(errorBody("Not found."), 404));

  app.onError((e, c) => {
    deps.log.error("unhandled error", { requestId: c.get("requestId"), errorName: e.name });
    return c.json(errorBody("Sorry, something went wrong. Please try again."), 500);
  });

  return app;
};
