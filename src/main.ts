// Entry point: load config, build deps (refusing to start if anything is
// missing), serve HTTP, and shut down gracefully on SIGTERM / SIGINT.

import { serve } from "@hono/node-server";
import { buildDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { formatModelRef } from "./llm/model-ref.js";
import { makeJsonLogger } from "./log.js";
import { localHosts, makeServer } from "./server.js";
import { loadWebAssets } from "./web.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const log = makeJsonLogger({ fields: { service: "jarvis" } });

const refuse = (reason: string): never => {
  log.error("refusing to start", { reason });
  // Also plain text, so it's readable in a terminal.
  console.error(`\n✗ Jarvis can't start:\n${reason}\n`);
  process.exit(1);
};

const config = loadConfig(process.env);
if (!config.ok) refuse(config.error);
const cfg = config.ok ? config.value : refuse("unreachable");

const deps = await buildDeps({ config: cfg, env: process.env, log });
if (!deps.ok) refuse(deps.error);
// Locally the server has no login, so only accept requests addressed to
// localhost on our port (DNS-rebinding guard). On Cloud Run, IAM protects it.
const web = await loadWebAssets();
if (!web.ok) refuse(web.error);
const app = makeServer(deps.ok ? deps.value : refuse("unreachable"), {
  ...(cfg.env === "production" ? {} : { allowedHosts: localHosts(cfg.port) }),
  web: web.ok ? web.value : refuse("unreachable"),
});

const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  log.info("listening", {
    url: `http://${cfg.host}:${info.port}`,
    env: cfg.env,
    classifier: formatModelRef(cfg.models.classifier),
    answer: formatModelRef(cfg.models.answer),
  });
});

const shutdown = (signal: string): void => {
  log.info("shutting down", { signal });
  const force = setTimeout(() => {
    log.warn("forced shutdown after timeout", { ms: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  // Stops accepting new connections and waits for in-flight requests.
  server.close(() => {
    log.info("stopped");
    process.exit(0);
  });
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
