// Who is who, the intro and conversational style (#88), in bare mode, against
// the brains as configured: Claude (ANSWER_MODEL) and Local (OLLAMA_MODEL on
// Ollama).
//
//   npm run eval:identity              # both brains
//   npm run eval:identity -- local     # or: claude
//   npm run eval:identity -- local --strict   # exit 1 on any failure
//   npm run eval:identity -- local --guarded  # what you'd actually get: through the honesty guard
//   npm run eval:identity -- local --profile  # with the made-up example profile (PROFILE=on)
//
// Informational by default: it always exits 0, so a local model that doesn't
// pass yet blocks nothing. Long replies are warnings, not failures.
//
// Then the spoken cases (#92): the spoken style and the sentence limit, as
// the voice gets them. Each shows how soon the first words came.
//
// The bare persona only, with the made-up name "Alex": never your name,
// profile or memories. --profile (or PROFILE=on) adds the made-up example
// profile, data/profile.example.md, never yours, and its cases.
//
// --guarded runs each reply through the honesty guard (#96), shows what it
// dropped, and checks the text you'd actually see and hear. Claude needs ANTHROPIC_API_KEY (from .env locally);
// Local needs Ollama running with the model pulled.

import { readFile } from "node:fs/promises";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { makeHonestyGuard } from "../src/answer/honesty.js";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { formatModelRef, type ModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import { EXAMPLE_PROFILE_PATH, makeFileProfileSource } from "../src/profile.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";
import { checkAnswer, checkSpoken, IDENTITY_CASES, openingVariety, PROFILE_CASES, SPOKEN_CASES } from "./identity-cases.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const strict = process.argv.includes("--strict");
const guarded = process.argv.includes("--guarded");
const which = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "both";
if (!["both", "local", "claude"].includes(which)) fail("Usage: npm run eval:identity -- [both|local|claude]");

const configResult = loadConfig(process.env);
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
const contextsResult = await loadContexts((p) => readFile(p, "utf8"), config.contextsPath);
const contexts = contextsResult.ok ? contextsResult.value : fail(contextsResult.ok ? "" : contextsResult.error);
const personal = contexts.find((c) => c.id === "personal") ?? fail("No personal context");

// A made-up name, so the eval never carries yours.
const EVAL_NAME = "Alex";

// The profile back (#98): always the made-up example, never data/profile.md.
const withProfile = process.argv.includes("--profile") || config.bareProfile;
const profile = withProfile ? { profile: makeFileProfileSource({ path: EXAMPLE_PROFILE_PATH }) } : {};
const cases = withProfile ? [...IDENTITY_CASES.filter((c) => !c.withoutProfileOnly), ...PROFILE_CASES] : IDENTITY_CASES;

/**
 * --guarded: the reply as you'd get it, through the honesty guard (#96),
 * with the streamed pieces in the order they came. Notes what was dropped.
 */
const checkedText = (question: string, text: string, deltas: readonly string[]): { text: string; note: string } => {
  if (!guarded) return { text, note: "" };
  const guard = makeHonestyGuard({ question });
  for (const d of deltas) guard.onText(d);
  const result = guard.finish(text);
  const dropped = Object.entries(result.dropped).filter(([, n]) => n > 0);
  const note = dropped.length === 0 ? "" : `\n    guard dropped ${dropped.map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ")}${result.replaced ? ", said it can't" : ""}; the model said: ${text.replace(/\s+/g, " ")}`;
  return { text: result.text, note };
};

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
  const answer = makeBareAnswerer({ llm: llm.ok ? llm.value : fail(""), userName: EVAL_NAME, ...profile });
  console.log(`\n${brain.name} (${formatModelRef(brain.ref)})${withProfile ? ", with the example profile" : ""}${guarded ? ", guarded" : ""}`);
  let passed = 0;
  for (const c of cases) {
    const started = performance.now();
    const result = await answer({ context: personal, question: c.question, history: [], memories: [], now: new Date() });
    const ms = Math.round(performance.now() - started);
    if (!result.ok) {
      failures += 1;
      console.log(`✗ ${c.question}  (${result.error.message})`);
      continue;
    }
    const raw = result.value.kind === "answer" ? result.value.text : result.value.message;
    const { text, note } = checkedText(c.question, raw, []);
    const { problems, warnings } = checkAnswer(c, text);
    if (problems.length === 0) passed += 1;
    else failures += 1;
    const mark = problems.length > 0 ? "✗" : warnings.length > 0 ? "!" : "✓";
    console.log(
      `${mark} ${c.question}  [${c.why}; ${ms} ms]\n    ${text.replace(/\s+/g, " ")}${note}` +
        (problems.length ? `\n    → ${problems.join("; ")}` : "") +
        (warnings.length ? `\n    warning: ${warnings.join("; ")}` : ""),
    );
  }
  console.log(`${brain.name}: ${passed}/${cases.length}`);

  console.log(`\n${brain.name}, spoken (at most ${config.turn.spokenSentences} sentences after the reaction${config.turn.punctuationStyle ? ", pauses on" : ""})`);
  let cuts = 0;
  const log = { info: (message: string) => void (message.includes("cut at the sentence limit") && (cuts += 1)), warn: () => undefined, error: () => undefined };
  const spokenAnswer = makeBareAnswerer({ llm: llm.ok ? llm.value : fail(""), userName: EVAL_NAME, log, spokenSentences: config.turn.spokenSentences, pauses: config.turn.punctuationStyle, ...profile });
  let spokenPassed = 0;
  const spokenAnswers: string[] = [];
  for (const c of SPOKEN_CASES) {
    const started = performance.now();
    let firstAt: number | undefined;
    const deltas: string[] = [];
    const before = cuts;
    const result = await spokenAnswer({
      context: personal,
      question: c.question,
      history: [],
      memories: [],
      now: new Date(),
      spoken: true,
      onText: (d) => {
        firstAt ??= performance.now();
        deltas.push(d);
      },
    });
    const ms = Math.round(performance.now() - started);
    const firstMs = firstAt === undefined ? "–" : `${Math.round(firstAt - started)} ms`;
    if (!result.ok) {
      failures += 1;
      console.log(`✗ ${c.question}  (${result.error.message})`);
      continue;
    }
    const raw = result.value.kind === "answer" ? result.value.text : result.value.message;
    const { text, note } = checkedText(c.question, raw, deltas);
    spokenAnswers.push(text);
    const { problems, warnings } = checkSpoken(c, text, cuts > before);
    if (problems.length === 0) spokenPassed += 1;
    else failures += 1;
    const mark = problems.length > 0 ? "✗" : warnings.length > 0 ? "!" : "✓";
    console.log(
      `${mark} ${c.question}  [${c.why}; first words ${firstMs}, all ${ms} ms]\n    ${text.replace(/\s+/g, " ")}${note}` +
        (problems.length ? `\n    → ${problems.join("; ")}` : "") +
        (warnings.length ? `\n    warning: ${warnings.join("; ")}` : ""),
    );
  }
  const variety = openingVariety(spokenAnswers);
  const openings = Object.entries(variety.counts).map(([o, n]) => `${o} ×${n}`).join(", ");
  if (variety.problem) failures += 1;
  console.log(`${variety.problem ? "✗" : "✓"} openings: ${openings}${variety.problem ? `\n    → ${variety.problem}` : ""}`);
    console.log(`${brain.name}, spoken: ${spokenPassed}/${SPOKEN_CASES.length}`);
}
process.exit(strict && failures > 0 ? 1 : 0);
