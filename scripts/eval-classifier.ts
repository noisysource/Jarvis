// Runs every question in test/fixtures/classifier-questions.json through the
// real classifier (local precheck, then the classifier model) and prints which
// ones route as expected. Precheck cases make no model call; the rest make
// one small call each on the classifier model.
//
//   npm run eval:classifier
//
// Reads ANTHROPIC_API_KEY from .env locally (see README).

import { readFile } from "node:fs/promises";
import { makeClassifier } from "../src/classify.js";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { formatModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";

type Fixture = { question: string; expected: string; precheck?: boolean };

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

const warnings: string[] = [];
const classify = makeClassifier({
  contexts,
  llm,
  log: { info: () => undefined, warn: (m, f) => warnings.push(`${m} ${JSON.stringify(f ?? {})}`), error: () => undefined },
});

const { cases } = JSON.parse(await readFile("test/fixtures/classifier-questions.json", "utf8")) as { cases: Fixture[] };

console.log(`Classifier: ${formatModelRef(config.models.classifier)}\n`);
let passed = 0;
for (const f of cases) {
  warnings.length = 0;
  const result = await classify({ question: f.question, history: [] });
  const got = result.kind === "context" ? result.contextId : "unclear";
  const okay = got === f.expected;
  if (okay) passed += 1;
  const via = f.precheck ? "precheck" : "model";
  console.log(`${okay ? "✓" : "✗"} [${via}] ${f.question}\n    expected ${f.expected}, got ${got}${warnings.length ? `  (${warnings.join("; ")})` : ""}`);
}
console.log(`\n${passed}/${cases.length} as expected`);
