// Live check of the configured models with your real key. Makes two tiny
// calls (a few hundred tokens): a JSON classification on the classifier model
// and a short text answer on the answer model.
//
//   npm run smoke:llm
//
// Reads ANTHROPIC_API_KEY from .env locally (see README).

import { loadConfig } from "../src/config.js";
import { formatModelRef, type ModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import type { LlmCall } from "../src/llm/types.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const config = loadConfig(process.env);
if (!config.ok) fail(`Config:\n${config.error}`);
const cfg = config.ok ? config.value : fail("unreachable");

const project = cfg.secrets.gcpProject;
const key = await resolveAnthropicKey({
  config: cfg,
  env: process.env,
  getSecret: project ? makeSecretGetter({ project, access: makeGcpSecretAccess() }) : undefined,
});
if (!key.ok) fail(key.error);
const apiKey = key.ok ? key.value.key : fail("unreachable");
console.log(`Key source: ${key.ok ? key.value.source : ""}`);

const check = async (label: string, ref: ModelRef, run: (llm: LlmCall) => Promise<string>): Promise<void> => {
  const llm = makeLlm(ref, { anthropic: apiKey });
  if (!llm.ok) return fail(llm.error);
  console.log(`✓ ${label} (${formatModelRef(ref)}): ${await run(llm.value)}`);
};

await check("classifier JSON", cfg.models.classifier, async (llm) => {
  const result = await llm({
    system: "Classify the question. Reply with JSON only.",
    messages: [{ role: "user", text: "When is my daughter's birthday?" }],
    outputSchema: {
      type: "object",
      properties: { context: { type: "string", enum: ["personal", "kidclub", "unclear"] } },
      required: ["context"],
      additionalProperties: false,
    },
    effort: "low",
    maxTokens: 1000,
  });
  if (!result.ok) return fail(`${result.error.kind}: ${result.error.message}`);
  return `${JSON.stringify(result.value.kind === "json" ? result.value.value : result.value)} [served by ${result.value.servedBy}]`;
});

await check("answer text", cfg.models.answer, async (llm) => {
  const result = await llm({
    system: "You are Jarvis. Answer in one short sentence.",
    messages: [{ role: "user", text: "Say hello and tell me today's day of the week is unknown to you." }],
    effort: "medium",
    maxTokens: 2000,
  });
  if (!result.ok) return fail(`${result.error.kind}: ${result.error.message}`);
  return `${result.value.kind === "text" ? result.value.text : result.value.kind} [served by ${result.value.servedBy}]`;
});
