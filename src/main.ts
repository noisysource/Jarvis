// Entry point: load config, build deps (refusing to start if anything is
// missing), serve HTTP, and shut down gracefully on SIGTERM / SIGINT.

import { serve } from "@hono/node-server";
import { buildDeps } from "./app.js";
import { makeBackgroundTasks } from "./background.js";
import { loadConfig } from "./config.js";
import { formatModelRef } from "./llm/model-ref.js";
import { makeJsonLogger } from "./log.js";
import { openSqliteMemoryStore, startMemoryPurge } from "./memory-sqlite.js";
import { makeMemoryStoreInMemory } from "./memory-store.js";
import { localHosts, makeServer } from "./server.js";
import { makeTurnRegistry } from "./turns.js";
import { makeTtsProviders } from "./tts/registry.js";
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

// Memories: a local SQLite file by default; refuse to start if it can't be opened.
const sqlite =
  cfg.memoryStore.kind === "sqlite" ? await openSqliteMemoryStore({ path: cfg.memoryStore.path }) : undefined;
if (sqlite && !sqlite.ok) refuse(sqlite.error);
// One store for answers and the Memories panel: SQLite, or RAM only.
const memoryStore = sqlite?.ok ? sqlite.value.store : makeMemoryStoreInMemory();
const stopPurge = sqlite?.ok
  ? startMemoryPurge(memoryStore, {
      onPurged: (n) => {
        if (n > 0) log.info("expired memories purged", { count: n });
      },
      onError: (e) => log.warn("memory purge failed", { errorName: e instanceof Error ? e.name : typeof e }),
    })
  : undefined;

// The memory wrap-up runs here, after each reply.
const background = makeBackgroundTasks({ log });

const deps = await buildDeps({ config: cfg, env: process.env, log, background, memoryStore });
if (!deps.ok) refuse(deps.error);
// Locally the server has no login, so only accept requests addressed to
// localhost on our port (DNS-rebinding guard). On Cloud Run, IAM protects it.
// The /voices audition page is dev-only (#73).
const web = await loadWebAssets(undefined, undefined, { dev: cfg.env !== "production" });
if (!web.ok) refuse(web.error);
// Spoken answers waiting for their playback report (#72); settled on shutdown (#78).
const turns = makeTurnRegistry({ log });

// Jarvis's voice (#73): local services only (checked in config).
const tts = { providers: makeTtsProviders({ kokoroUrl: cfg.tts.kokoroUrl, piperUrl: cfg.tts.piperUrl }), config: cfg.tts };

const app = makeServer(deps.ok ? deps.value : refuse("unreachable"), {
  turns,
  tts,
  ...(cfg.env === "production" ? {} : { allowedHosts: localHosts(cfg.port) }),
  web: web.ok ? web.value : refuse("unreachable"),
  memories: memoryStore,
});

const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  log.info("listening", {
    url: `http://${cfg.host}:${info.port}`,
    env: cfg.env,
    classifier: formatModelRef(cfg.models.classifier),
    answer: formatModelRef(cfg.models.answer),
    voice: cfg.tts.voice ? `${cfg.tts.provider}:${cfg.tts.voice}` : cfg.tts.provider,
    memory: cfg.memoryStore.kind === "sqlite" ? `sqlite:${cfg.memoryStore.path}` : "memory (not kept after a restart)",
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
    // Spoken answers still waiting for their playback report are settled as
    // unreported (#78), so their wrap-ups are queued before the drain.
    const settled = turns.settleAll();
    if (settled > 0) log.info("settled spoken turns", { count: settled });
    // Let wrap-ups still running after their replies finish, then close the database.
    const waiting = background.pending();
    if (waiting > 0) log.info("waiting for background work", { tasks: waiting });
    void background.drain().then(() => {
      stopPurge?.();
      if (sqlite?.ok) sqlite.value.close();
      log.info("stopped");
      process.exit(0);
    });
  });
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
