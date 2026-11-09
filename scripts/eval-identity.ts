// Who is who, the intro and conversational style (#88), in bare mode, against
// the brains as configured: Claude (ANSWER_MODEL) and Local (OLLAMA_MODEL on
// Ollama).
//
//   npm run eval:identity              # both brains
//   npm run eval:identity -- local     # or: claude
//   npm run eval:identity -- local --strict   # exit 1 on any failure
//
// Informational by default: it always exits 0, so a local model that doesn't
// pass yet blocks nothing. Long replies are warnings, not failures.
//
// Then the spoken cases (#92): the spoken style and the sentence limit, as
// the voice gets them. Each shows how soon the first words came.
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
import { checkAnswer, checkSpoken, IDENTITY_CASES, SPOKEN_CASES } from "./identity-cases.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const strict = process.argv.includes("--strict");
const which = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "both";
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
  const llm = makeLlm(brain.ref, key ? { anthropic: key } : {}, { ollama: config.ollamaUrl, ollamaThink: config.ollamaThink });
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
    const { problems, warnings } = checkAnswer(c, text);
    if (problems.length === 0) passed += 1;
    else failures += 1;
    const mark = problems.length > 0 ? "✗" : warnings.length > 0 ? "!" : "✓";
    console.log(
      `${mark} ${c.question}  [${c.why}; ${ms} ms]\n    ${text.replace(/\s+/g, " ")}` +
        (problems.length ? `\n    → ${problems.join("; ")}` : "") +
        (warnings.length ? `\n    warning: ${warnings.join("; ")}` : ""),
    );
  }
  console.log(`${brain.name}: ${passed}/${IDENTITY_CASES.length}`);

  console.log(`\n${brain.name}, spoken (at most ${config.turn.spokenSentences} sentences after the reaction)`);
  let cuts = 0;
  const log = { info: (message: string) => void (message.includes("cut at the sentence limit") && (cuts += 1)), warn: () => undefined, error: () => undefined };
  const spokenAnswer = makeBareAnswerer({ llm: llm.ok ? llm.value : fail(""), userName: EVAL_NAME, log, spokenSentences: config.turn.spokenSentences });
  let spokenPassed = 0;
  for (const c of SPOKEN_CASES) {
    const started = performance.now();
    let firstAt: number | undefined;
    const before = cuts;
    const result = await spokenAnswer({
      context: personal,
      question: c.question,
      history: [],
      memories: [],
      now: new Date(),
      spoken: true,
      onText: () => (firstAt ??= performance.now()),
    });
    const ms = Math.round(performance.now() - started);
    const firstMs = firstAt === undefined ? "–" : `${Math.round(firstAt - started)} ms`;
    if (!result.ok) {
      failures += 1;
      console.log(`✗ ${c.question}  (${result.error.message})`);
      continue;
    }
    const text = result.value.kind === "answer" ? result.value.text : result.value.message;
    const { problems, warnings } = checkSpoken(c, text, cuts > before);
    if (problems.length === 0) spokenPassed += 1;
    else failures += 1;
    const mark = problems.length > 0 ? "✗" : warnings.length > 0 ? "!" : "✓";
    console.log(
      `${mark} ${c.question}  [${c.why}; first words ${firstMs}, all ${ms} ms]\n    ${text.replace(/\s+/g, " ")}` +
        (problems.length ? `\n    → ${problems.join("; ")}` : "") +
        (warnings.length ? `\n    warning: ${warnings.join("; ")}` : ""),
    );
  }
  console.log(`${brain.name}, spoken: ${spokenPassed}/${SPOKEN_CASES.length}`);
}
process.exit(strict && failures > 0 ? 1 : 0);
