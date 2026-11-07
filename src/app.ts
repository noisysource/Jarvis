// Builds the real dependencies for the ask handler from config. Used by the
// server (#15) and the end-to-end tests. Refuses to start (returns an error)
// if contexts.md, the profile or the API key is missing or invalid.

import { readFile } from "node:fs/promises";
import { makePersonalAnswerer } from "./answer/personal.js";
import { makeAnswerRouter } from "./answer/router.js";
import { makeClassifier } from "./classify.js";
import type { Config, Env } from "./config.js";
import { loadContexts } from "./contexts.js";
import type { ModelRef } from "./llm/model-ref.js";
import { makeLlm, type ProviderKeys } from "./llm/registry.js";
import type { LlmCall } from "./llm/types.js";
import { extractNothing, makeMemoryHooks, makeSafeMemoryHooks } from "./memory.js";
import { makeMemoryStoreInMemory, type MemoryStore } from "./memory-store.js";
import { makePrecheck } from "./precheck.js";
import { makeProfileSource, type ProfileFileSystem } from "./profile.js";
import { err, ok, type Result } from "./result.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey } from "./secrets.js";
import type { Context, Deps, Logger } from "./types.js";

export type AppInputs = {
  readonly config: Config;
  readonly env: Env;
  readonly log: Logger;
  /** Overrides for tests. */
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly profileFs?: ProfileFileSystem;
  readonly makeLlm?: (ref: ModelRef, keys: ProviderKeys) => Result<LlmCall, string>;
  readonly now?: () => Date;
  /** Where memories live. Defaults to an in-memory store until the SQLite store (#60). */
  readonly memoryStore?: MemoryStore;
};

/** "What Jarvis can do", from contexts.md and which contexts have an answerer. */
export const capabilitiesText = (contexts: readonly Context[], answered: ReadonlySet<string>): string =>
  [
    "Jarvis can help with:",
    ...contexts.map((c) => {
      if (c.handling.kind === "handoff") return `- ${c.name}: not handled by Jarvis; those requests go to ${c.handling.to}.`;
      if (answered.has(c.id)) return `- ${c.name}: ${c.description} (answered from: ${c.data})`;
      return `- ${c.name}: not connected yet, so Jarvis can't answer these questions yet.`;
    }),
    "- General questions and conversation.",
    "You can type or speak, and answers are read aloud in English or Portuguese.",
  ].join("\n");

export const buildDeps = async (inputs: AppInputs): Promise<Result<Deps, string>> => {
  const { config, env, log } = inputs;

  const contexts = await loadContexts(inputs.readTextFile ?? ((p) => readFile(p, "utf8")), config.contextsPath);
  if (!contexts.ok) return contexts;

  // Check the profile now, so a missing one stops startup with a clear message.
  const profile = makeProfileSource(config.profileSource, { ...(inputs.profileFs ? { fs: inputs.profileFs } : {}) });
  const firstProfile = await profile();
  if (!firstProfile.ok) return err(firstProfile.error.message);

  const project = config.secrets.gcpProject;
  const key = await resolveAnthropicKey({
    config,
    env,
    getSecret: project ? makeSecretGetter({ project, access: makeGcpSecretAccess() }) : undefined,
  });
  if (!key.ok) return key;
  log.info("anthropic key loaded", { source: key.value.source });

  const buildLlm = inputs.makeLlm ?? makeLlm;
  const keys: ProviderKeys = { anthropic: key.value.key };
  const classifierLlm = buildLlm(config.models.classifier, keys);
  if (!classifierLlm.ok) return err(`CLASSIFIER_MODEL: ${classifierLlm.error}`);
  const answerLlm = buildLlm(config.models.answer, keys);
  if (!answerLlm.ok) return err(`ANSWER_MODEL: ${answerLlm.error}`);

  if (!contexts.value.some((c) => c.id === "personal" && c.handling.kind === "answer")) {
    return err(`${config.contextsPath} needs an answered "personal" context`);
  }

  const now = inputs.now ?? (() => new Date());
  const memoryStore = inputs.memoryStore ?? makeMemoryStoreInMemory({ now });

  return ok({
    contexts: contexts.value,
    precheck: makePrecheck(contexts.value),
    classify: makeClassifier({ contexts: contexts.value, llm: classifierLlm.value, log }),
    answer: makeAnswerRouter({
      personal: makePersonalAnswerer({
        llm: answerLlm.value,
        profile,
        timeZone: config.timeZone,
        capabilities: capabilitiesText(contexts.value, new Set(["personal"])),
        log,
      }),
    }),
    memory: makeSafeMemoryHooks(makeMemoryHooks({ store: memoryStore, extract: extractNothing, now, log }), { log }),
    now,
    log,
  });
};
