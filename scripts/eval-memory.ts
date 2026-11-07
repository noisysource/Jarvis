// Runs every case in test/fixtures/memory-extraction.json through the real
// wrap-up extract step (the classifier model plus the code rules) and prints
// what it kept. One small model call per case, except EC questions, which
// the rules skip without a call.
//
//   npm run eval:memory
//
// Reads ANTHROPIC_API_KEY from .env locally (see README). Prints the
// fixture's own example text only, never your profile or memories.

import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { formatModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import { makeModelExtract } from "../src/memory-extract.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";
import type { ContextId, Memory } from "../src/types.js";

type Fixture = {
  context: string;
  question: string;
  answer: string;
  related?: { id: string; kind: "fact" | "playbook"; text: string }[];
  expect: "keep" | "delete" | "nothing";
  includes?: string;
  /** "none": no history line may be kept for this exchange. */
  history?: "none";
};

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const configResult = loadConfig(process.env);
const config = configResult.ok ? configResult.value : fail(`Config:\n${configResult.ok ? "" : configResult.error}`);
const contextsResult = await loadContexts((p) => readFile(p, "utf8"), config.contextsPath);
const contexts = contextsResult.ok ? contextsResult.value : fail(contextsResult.ok ? "" : contextsResult.error);

const project = config.secrets.gcpProject;
const keyResult = await resolveAnthropicKey({
  config,
  env: process.env,
  getSecret: project ? makeSecretGetter({ project, access: makeGcpSecretAccess() }) : undefined,
});
const key = keyResult.ok ? keyResult.value.key : fail(keyResult.ok ? "" : keyResult.error);
const llmResult = makeLlm(config.models.classifier, { anthropic: key });
const llm = llmResult.ok ? llmResult.value : fail(llmResult.ok ? "" : llmResult.error);

const notes: string[] = [];
const extract = makeModelExtract({
  llm,
  contexts,
  // The fixture's own example names, so the eval never needs your real list.
  neverRemember: ["Jane Example"],
  timeZone: config.timeZone,
  log: {
    info: (m, f) => notes.push(`${m} ${JSON.stringify(f ?? {})}`),
    warn: (m, f) => notes.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: () => undefined,
  },
});

const { cases } = JSON.parse(await readFile("test/fixtures/memory-extraction.json", "utf8")) as { cases: Fixture[] };
const now = new Date();

console.log(`Extractor: ${formatModelRef(config.models.classifier)}\n`);
let passed = 0;
for (const f of cases) {
  notes.length = 0;
  const related: Memory[] = (f.related ?? []).map((r) => ({
    ...r,
    contextId: f.context as ContextId,
    origin: "auto",
    createdAt: now,
    updatedAt: now,
    source: "eval",
    seen: true,
  }));
  const result = await extract({ question: f.question, answer: f.answer, contextId: f.context as ContextId, related, now });
  const texts = result.decisions.flatMap((d) => (d.action === "delete" ? [] : [d.text]));
  const deletes = result.decisions.filter((d) => d.action === "delete").length;
  const historyOkay = f.history !== "none" || result.historyLine === undefined;
  const decisionsOkay =
    f.expect === "nothing"
      ? result.decisions.length === 0
      : f.expect === "delete"
        ? deletes > 0
        : texts.some((t) => t.toLowerCase().includes((f.includes ?? "").toLowerCase()));
  const okay = decisionsOkay && historyOkay;
  if (okay) passed += 1;
  const kept = result.decisions.map((d) => (d.action === "delete" ? `delete ${d.id}` : `${d.action}: ${d.text}`));
  console.log(
    `${okay ? "✓" : "✗"} [${f.context}] ${f.question}\n    expected ${f.expect}${f.includes ? ` "${f.includes}"` : ""}${f.history === "none" ? ", no history" : ""}; kept ${kept.length ? kept.join(" | ") : "nothing"}` +
      `${result.historyLine ? `\n    history: ${result.historyLine}${historyOkay ? "" : "  ← should be none"}` : ""}${notes.length ? `\n    (${notes.join("; ")})` : ""}`,
  );
}
console.log(`\n${passed}/${cases.length} as expected`);
