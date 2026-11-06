// Ask the personal answerer one question, using your real profile and key.
// Skips the classifier: every question goes straight to the `personal`
// answerer. For trying answers before the chat page (#27) exists.
//
//   npm run ask "When is my daughter's birthday?"
//
// Reads ANTHROPIC_API_KEY from .env locally (see README).

import { readFile } from "node:fs/promises";
import { makePersonalAnswerer } from "../src/answer/personal.js";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { formatModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import { makeProfileSource } from "../src/profile.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";
import type { Logger } from "../src/types.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const question = process.argv.slice(2).join(" ").trim();
if (question === "") fail('Usage: npm run ask "your question"');

const configResult = loadConfig(process.env);
const config = configResult.ok ? configResult.value : fail(`Config:\n${configResult.ok ? "" : configResult.error}`);

const contextsResult = await loadContexts((p) => readFile(p, "utf8"), config.contextsPath);
const contexts = contextsResult.ok ? contextsResult.value : fail(contextsResult.ok ? "" : contextsResult.error);
const personal = contexts.find((c) => c.id === "personal") ?? fail(`No "personal" context in ${config.contextsPath}`);

// Check the profile up front so a missing file gets the helpful message.
const profile = makeProfileSource(config.profileSource);
const firstLoad = await profile();
if (!firstLoad.ok) fail(firstLoad.error.message);

const project = config.secrets.gcpProject;
const keyResult = await resolveAnthropicKey({
  config,
  env: process.env,
  getSecret: project ? makeSecretGetter({ project, access: makeGcpSecretAccess() }) : undefined,
});
const key = keyResult.ok ? keyResult.value.key : fail(keyResult.ok ? "" : keyResult.error);

const llmResult = makeLlm(config.models.answer, { anthropic: key });
const llm = llmResult.ok ? llmResult.value : fail(llmResult.ok ? "" : llmResult.error);

// The answerer logs only metadata (model, token counts, failure kinds); show it dimmed on stderr.
const dim = (s: string): string => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const log: Logger = {
  info: (message, fields) => console.error(dim(`${message} ${JSON.stringify(fields ?? {})}`)),
  warn: (message, fields) => console.error(dim(`warning: ${message} ${JSON.stringify(fields ?? {})}`)),
  error: (message, fields) => console.error(dim(`error: ${message} ${JSON.stringify(fields ?? {})}`)),
};

const answer = makePersonalAnswerer({ llm, profile, timeZone: config.timeZone, log });
console.error(dim(`asking ${formatModelRef(config.models.answer)} (personal, ${config.timeZone})…`));

const result = await answer({ context: personal, question, history: [], memories: [], now: new Date() });
if (!result.ok) fail(`${result.error.code}: ${result.error.message}`);
if (result.ok) console.log(result.value);
