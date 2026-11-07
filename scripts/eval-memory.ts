// Runs every case in test/fixtures/memory-extraction.json through the same
// flow as the live server: handleAsk with the real precheck, the real answer
// router (only ANSWERED_CONTEXT_IDS are answered; the rest reply "not
// connected yet" and get no wrap-up), the real memory hooks and the real
// extract step (classifier model + code rules). Only the answer itself is
// the fixture's, so no answer-model calls are made.
//
//   npm run eval:memory
//
// Memories go into a fresh in-memory store per case and are thrown away:
// this never opens data/memory.sqlite or any other file store. Reads
// ANTHROPIC_API_KEY from .env locally (see README). Prints the fixture's own
// example text only, never your profile or memories.

import { readFile } from "node:fs/promises";
import { makeAnswerRouter } from "../src/answer/router.js";
import { ANSWERED_CONTEXT_IDS } from "../src/app.js";
import { handleAsk } from "../src/ask.js";
import { loadConfig } from "../src/config.js";
import { loadContexts } from "../src/contexts.js";
import { formatModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import { makeMemoryHooks } from "../src/memory.js";
import { makeModelExtract } from "../src/memory-extract.js";
import { makeMemoryStoreInMemory } from "../src/memory-store.js";
import { makePrecheck } from "../src/precheck.js";
import { ok } from "../src/result.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "../src/secrets.js";
import type { ContextId, Deps, Logger } from "../src/types.js";

type Fixture = {
  context: string;
  question: string;
  answer: string;
  related?: { kind: "fact" | "playbook"; text: string }[];
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
const log: Logger = {
  info: (m, f) => {
    if (m.startsWith("memory")) notes.push(`${m} ${JSON.stringify(f ?? {})}`);
  },
  warn: (m, f) => notes.push(`${m} ${JSON.stringify(f ?? {})}`),
  error: (m, f) => notes.push(`${m} ${JSON.stringify(f ?? {})}`),
};
const extract = makeModelExtract({
  llm,
  contexts,
  // The fixture's own example names, so the eval never needs your real list.
  neverRemember: ["Jane Example"],
  timeZone: config.timeZone,
  log,
});

const { cases } = JSON.parse(await readFile("test/fixtures/memory-extraction.json", "utf8")) as { cases: Fixture[] };
const now = new Date();

console.log(`Extractor: ${formatModelRef(config.models.classifier)}; answered contexts: ${ANSWERED_CONTEXT_IDS.join(", ")}\n`);
let passed = 0;
let skipped = 0;
for (const [i, f] of cases.entries()) {
  notes.length = 0;
  // A throwaway store per case: nothing is written to disk.
  const store = makeMemoryStoreInMemory({ now: () => now });
  const seeded = await Promise.all(
    (f.related ?? []).map((r) => store.add({ ...r, contextId: f.context as ContextId, origin: "auto", source: "eval-seed" })),
  );
  // The fixture's answer stands in for the answer model, for the contexts the server answers.
  const answerers = Object.fromEntries(
    ANSWERED_CONTEXT_IDS.map((id): [string, Deps["answer"]] => [id, async () => ok({ kind: "answer", text: f.answer })]),
  );
  const deps: Deps = {
    contexts,
    precheck: makePrecheck(contexts),
    classify: async () => ({ kind: "unclear" }), // never used: each case names its context
    answer: makeAnswerRouter(answerers),
    // Not wrapped in the 2 s safety timeout, so a slow model call is scored rather than cut off.
    memory: makeMemoryHooks({ store, extract, now: () => now, log }),
    now: () => now,
    log,
  };
  const response = await handleAsk(deps, {
    question: f.question,
    context: f.context as ContextId,
    conversationId: `eval-case-${i}-${now.getTime()}`,
  });

  const after = await store.list();
  const seededText = new Map(seeded.map((m) => [m.id, m.text]));
  const changed = after.filter((m) => m.kind !== "history" && seededText.get(m.id) !== m.text);
  const deleted = seeded.filter((m) => !after.some((a) => a.id === m.id));
  const history = after.filter((m) => m.kind === "history");

  const decisionsOkay =
    f.expect === "nothing"
      ? changed.length === 0 && deleted.length === 0
      : f.expect === "delete"
        ? deleted.length > 0
        : changed.some((m) => m.text.toLowerCase().includes((f.includes ?? "").toLowerCase()));
  const historyOkay = f.history !== "none" || history.length === 0;
  const okay = decisionsOkay && historyOkay;
  // Keeping something in a context that isn't connected can't happen in the
  // live flow (no wrap-up after "not connected yet"); such cases wait for it.
  const notConnected = response.type === "unavailable" && f.expect !== "nothing";
  if (notConnected) skipped += 1;
  else if (okay) passed += 1;

  const kept = [
    ...changed.map((m) => `${seededText.has(m.id) ? "update" : "add"}: ${m.text}`),
    ...deleted.map((m) => `delete: ${m.text}`),
  ];
  const mark = notConnected ? "–" : okay ? "✓" : "✗";
  console.log(
    `${mark} [${f.context} → ${response.type}] ${f.question}\n    expected ${f.expect}${f.includes ? ` "${f.includes}"` : ""}${f.history === "none" ? ", no history" : ""}; kept ${kept.length ? kept.join(" | ") : "nothing"}` +
      history.map((h) => `\n    history: ${h.text}${historyOkay ? "" : "  ← should be none"}`).join("") +
      (notConnected ? `\n    (skipped: ${f.context} isn't connected yet, so the live flow doesn't wrap up; runs once it is)` : "") +
      (notes.length ? `\n    (${notes.join("; ")})` : ""),
  );
}
const scored = cases.length - skipped;
console.log(`\n${passed}/${scored} as expected${skipped ? `; ${skipped} skipped until their context is connected` : ""}`);
