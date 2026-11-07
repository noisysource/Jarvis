// Review and remove what Jarvis remembers, from the terminal (#62). Opens the
// same memory database as the server (MEMORY_STORE / MEMORY_DB). See
// src/memory-cli.ts for the commands; `npm run memory` alone prints them.

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { exportMemories, formatMemoryList, MEMORY_USAGE, parseMemoryArgs } from "../src/memory-cli.js";
import { openSqliteMemoryStore } from "../src/memory-sqlite.js";
import type { ContextId } from "../src/types.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const args = parseMemoryArgs(process.argv.slice(2));
const command = args.ok ? args.value : fail(`${args.ok ? "" : args.error}\n\n${MEMORY_USAGE}`);
if (command.command === "help") {
  console.log(MEMORY_USAGE);
  process.exit(0);
}

const configResult = loadConfig(process.env);
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.memoryStore.kind !== "sqlite") {
  fail("MEMORY_STORE=memory keeps memories in the server's RAM only, so there's nothing on disk to list or change.");
}
const path = config.memoryStore.kind === "sqlite" ? config.memoryStore.path : "";

const contextsResult = await loadContexts((p) => readFile(p, "utf8"), config.contextsPath);
const contexts = contextsResult.ok ? contextsResult.value : fail(contextsResult.ok ? "" : contextsResult.error);
const checkContext = (id: string | undefined): ContextId | undefined => {
  if (id === undefined) return undefined;
  const found = contexts.find((c) => c.id === id && c.handling.kind === "answer");
  return found ? found.id : fail(`unknown context "${id}" (yours: ${contexts.filter((c) => c.handling.kind === "answer").map((c) => c.id).join(", ")})`);
};

const opened = await openSqliteMemoryStore({ path });
const { store, close } = opened.ok ? opened.value : fail(opened.ok ? "" : opened.error);

try {
  switch (command.command) {
    case "list": {
      const contextId = checkContext(command.context);
      console.log(formatMemoryList(await store.list({ ...(contextId ? { contextId } : {}), ...(command.kind ? { kind: command.kind } : {}) })));
      break;
    }
    case "export": {
      const contextId = checkContext(command.context);
      console.log(exportMemories(await store.list(contextId ? { contextId } : {})));
      break;
    }
    case "delete":
      if (!(await store.delete(command.id))) fail(`no memory with id ${command.id}`);
      console.log(`Deleted ${command.id}.`);
      break;
    case "wipe": {
      const contextId = checkContext(command.context) as ContextId;
      const count = (await store.list({ contextId })).length;
      if (count === 0) {
        console.log(`No ${contextId} memories.`);
        break;
      }
      if (!command.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`Delete all ${count} ${contextId} memories? This can't be undone. Type "${contextId}" to confirm: `);
        rl.close();
        if (answer.trim() !== contextId) fail("Not confirmed; nothing deleted.");
      }
      console.log(`Deleted ${await store.wipe({ contextId })} ${contextId} memories.`);
      break;
    }
  }
} finally {
  close();
}
