// Who is who, the intro and conversational style (#88), in bare mode, against
// the brains as configured: Claude (ANSWER_MODEL) and Local (OLLAMA_MODEL on
// Ollama).
//
//   npm run eval:identity              # both brains
//   npm run eval:identity -- local     # or: claude
//
// The bare persona only, with the made-up name "Alex": never your name,
// profile or memories. Claude needs ANTHROPIC_API_KEY (from .env locally);
// Local needs Ollama running with the model pulled.

import { readFile } from "node:fs/promises";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { formatModelRef, type ModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";
import { checkAnswer, IDENTITY_CASES } from "./identity-cases.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const which = process.argv[2] ?? "both";
if (!["both", "local", "claude"].includes(which)) fail("Usage: npm run eval:identity -- [both|local|claude]");

const configResult = loadConfig(process.env);
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
const contextsResult = await loadContexts((p) => readFile(p, "utf8"), config.contextsPath);
const contexts = contextsResult.ok ? contextsResult.value : fail(contextsResult.ok ? "" : contextsResult.error);
const personal = contexts.find((c) => c.id === "personal") ?? fail("No personal context");

// A made-up name, so the eval never carries yours.
const EVAL_NAME = "Alex";

const keyFor = async (ref: ModelRef): Promise<string | undefined> => {
  if (ref.provider !== "anthropic") return undefined;
  const project = config.secrets.gcpProject;
  const key = await resolveAnthropicKey({
    config,
    env: process.env,
    getSecret: project ? makeSecretGetter({ project, access: makeGcpSecretAccess() }) : undefined,
  });
  return key.ok ? key.value.key : fail(key.ok ? "" : key.error);
};

const brains: { name: string; ref: ModelRef }[] = [
  ...(which !== "claude" ? [{ name: "Local", ref: config.models.local }] : []),
  ...(which !== "local" ? [{ name: "Claude", ref: config.models.answer }] : []),
];

let failures = 0;
for (const brain of brains) {
  const key = await keyFor(brain.ref);
  const llm = makeLlm(brain.ref, key ? { anthropic: key } : {}, { ollama: config.ollamaUrl });
  if (!llm.ok) fail(llm.error);
  const answer = makeBareAnswerer({ llm: llm.ok ? llm.value : fail(""), userName: EVAL_NAME });
  console.log(`\n${brain.name} (${formatModelRef(brain.ref)})`);
  let passed = 0;
  for (const c of IDENTITY_CASES) {
    const started = performance.now();
    const result = await answer({ context: personal, question: c.question, history: [], memories: [], now: new Date() });
    const ms = Math.round(performance.now() - started);
    if (!result.ok) {
      failures += 1;
      console.log(`✗ ${c.question}  (${result.error.message})`);
      continue;
    }
    const text = result.value.kind === "answer" ? result.value.text : result.value.message;
    const problems = checkAnswer(c, text);
    if (problems.length === 0) passed += 1;
    else failures += 1;
    console.log(`${problems.length === 0 ? "✓" : "✗"} ${c.question}  [${c.why}; ${ms} ms]\n    ${text.replace(/\s+/g, " ")}${problems.length ? `\n    → ${problems.join("; ")}` : ""}`);
  }
  console.log(`${brain.name}: ${passed}/${IDENTITY_CASES.length}`);
}
process.exit(failures === 0 ? 0 : 1);
