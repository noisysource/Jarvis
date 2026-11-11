// Runs Jarvis's introspection now (#108), instead of waiting for 03:30.
//
//   npm run memory:reflect
//
// Needs MEMORY=on. Memory changes are applied; skills and tools are drafts in
// the report (data/introspection/<date>.md, readable only by you).

import { buildDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { makeJsonLogger } from "../src/log.js";
import { openSqliteMemoryStore } from "../src/memory-sqlite.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const config = loadConfig(process.env);
const cfg = config.ok ? config.value : fail(config.ok ? "" : config.error);
if (!cfg.bareMemory) fail("Introspection needs MEMORY=on (with BARE_MODE=on) in .env.");
if (cfg.memoryStore.kind !== "sqlite") fail("Introspection needs the SQLite memory (MEMORY_STORE=sqlite, the default).");
const store = cfg.memoryStore.kind === "sqlite" ? await openSqliteMemoryStore({ path: cfg.memoryStore.path }) : undefined;
if (!store?.ok) fail(store && !store.ok ? store.error : "Couldn't open the memory database.");
const log = makeJsonLogger({ fields: { service: "jarvis-reflect" } });
const deps = await buildDeps({ config: cfg, env: process.env, log, memoryStore: store?.ok ? store.value.store : fail("") });
if (!deps.ok) fail(deps.error);
const introspect = deps.ok ? deps.value.introspect : undefined;
if (!introspect) fail("Introspection isn't available.");
const report = await (introspect ?? (() => fail("")))();
console.log(
  `\n✓ Introspection done: ${report.kept} kept, ${report.promoted.length} made long-term, ${report.merged.length} merged, ${report.dropped.length} dropped; ${report.skills.length} skill and ${report.tools.length} tool draft(s).`,
);
console.log(report.kept + report.promoted.length + report.merged.length + report.dropped.length > 0 ? `  Report: data/introspection/${report.date}.md` : "  No short-term memories to review.");
if (store?.ok) store.value.close?.();
