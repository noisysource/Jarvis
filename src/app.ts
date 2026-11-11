// Builds the real dependencies for the ask handler from config. Used by the
// server (#15) and the end-to-end tests. Refuses to start (returns an error)
// if contexts.md, the profile or the API key is missing or invalid.

import { readFile } from "node:fs/promises";
import { makeBareAnswerer } from "./answer/bare.js";
import { makePersonalAnswerer } from "./answer/personal.js";
import { makeAnswerRouter, makeBrainRouter } from "./answer/router.js";
import { makeGoogleCalendarReader, type CalendarReader } from "./calendar/google.js";
import { makeAccessTokens } from "./calendar/oauth.js";
import { isEcEvent, localDate } from "./calendar/read.js";
import { makeGmailReader, type GmailAccount, type GmailReader } from "./gmail/gmail.js";
import { addedSentence, makeGoogleEventCreator, makePendingProposals, proposalPathLabel, type EventCreator } from "./calendar/create.js";
import { makeClassifier } from "./classify.js";
import type { Config, Env } from "./config.js";
import { loadContexts } from "./contexts.js";
import type { ModelRef } from "./llm/model-ref.js";
import { makeLlm, type ProviderKeys, type ProviderUrls } from "./llm/registry.js";
import type { LlmCall } from "./llm/types.js";
import { makeBackgroundTasks, type BackgroundTasks } from "./background.js";
import { makeMemoryHooks, makeSafeMemoryHooks } from "./memory.js";
import { makeModelExtract } from "./memory-extract.js";
import { makeEcMatchers, parseNeverRemember } from "./memory-rules.js";
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
  readonly makeLlm?: (ref: ModelRef, keys: ProviderKeys, options?: ProviderUrls & { readonly log?: Logger }) => Result<LlmCall, string>;
  readonly now?: () => Date;
  /** Where memories live. Defaults to an in-memory store until the SQLite store (#60). */
  readonly memoryStore?: MemoryStore;
  /** Runs work after the reply (the memory wrap-up). main.ts passes one so shutdown can drain it. */
  readonly background?: BackgroundTasks;
  /** The calendar (CALENDAR=on, #100); defaults to Google with this Mac's tokens. */
  readonly calendarReader?: CalendarReader;
  /** Tests: creates events instead of Google (Reach 2). */
  readonly eventCreator?: EventCreator;
  /** Tests: reads email instead of Gmail (Reach 3). */
  readonly gmailReader?: GmailReader;
};

/**
 * The contexts Jarvis can answer today. Every other answerable context gets
 * "not connected yet" (an unavailable reply, with no wrap-up). Shared with
 * eval:memory so it follows the same flow.
 */
export const ANSWERED_CONTEXT_IDS: readonly string[] = ["personal"];

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

  const readText = inputs.readTextFile ?? ((p: string) => readFile(p, "utf8"));
  const contexts = await loadContexts(readText, config.contextsPath);
  if (!contexts.ok) return contexts;

  // Optional: names memories must never contain. A missing file means none.
  const neverRemember = await readText(config.neverRememberPath).then(parseNeverRemember, (e: unknown) =>
    (e as { code?: string }).code === "ENOENT" ? [] : e,
  );
  if (!Array.isArray(neverRemember)) {
    return err(`${config.neverRememberPath}: can't read it (${neverRemember instanceof Error ? neverRemember.message : "unknown error"})`);
  }

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
  const classifierLlm = buildLlm(config.models.classifier, keys, { log });
  if (!classifierLlm.ok) return err(`CLASSIFIER_MODEL: ${classifierLlm.error}`);
  const answerLlm = buildLlm(config.models.answer, keys, { log });
  if (!answerLlm.ok) return err(`ANSWER_MODEL: ${answerLlm.error}`);
  // The "Local" brain (#88): Ollama on this machine.
  const localLlm = buildLlm(config.models.local, keys, { ollama: config.ollamaUrl, ollamaThink: config.ollamaThink });
  if (!localLlm.ok) return err(`OLLAMA_MODEL: ${localLlm.error}`);

  if (!contexts.value.some((c) => c.id === "personal" && c.handling.kind === "answer")) {
    return err(`${config.contextsPath} needs an answered "personal" context`);
  }

  const now = inputs.now ?? (() => new Date());
  const memoryStore = inputs.memoryStore ?? makeMemoryStoreInMemory({ now });

  const personalWith = (llm: LlmCall): Record<string, Deps["answer"]> => ({
    personal: makePersonalAnswerer({
      llm,
      profile,
      timeZone: config.timeZone,
      capabilities: capabilitiesText(contexts.value, new Set(ANSWERED_CONTEXT_IDS)),
      log,
      spokenThinking: config.turn.spokenThinking,
    }),
  });
  // Your personal calendar (#100), read-only, for both brains. EC-looking events reach a brain only as "EC work, handled by Kiro".
  const precheck = makePrecheck(contexts.value);
  const accessToken = makeAccessTokens({ clientPath: config.calendar.clientPath, tokensPath: config.calendar.tokensPath });
  // Reach 2 (CALENDAR_WRITE=on): Claude proposes, the page asks, and only "yes" creates.
  const pending = config.calendar.write ? makePendingProposals() : undefined;
  const creator = config.calendar.write ? (inputs.eventCreator ?? makeGoogleEventCreator({ accessToken, timeZone: config.timeZone })) : undefined;
  const isEcText = (text: string): boolean => precheck(text).kind === "handoff";
  // Reach 3 (GMAIL=on): each account has its own connection, read on first use.
  const gmailTokens = new Map<GmailAccount, ReturnType<typeof makeAccessTokens>>();
  const gmailToken = (account: GmailAccount) => {
    const existing = gmailTokens.get(account);
    if (existing) return existing();
    const made = makeAccessTokens({
      clientPath: config.calendar.clientPath,
      tokensPath: config.gmail.tokensPath(account),
      what: { name: `The ${account} Gmail`, connect: `npm run gmail:connect -- ${account}` },
    });
    gmailTokens.set(account, made);
    return made();
  };
  const gmail = config.gmail.enabled ? { reader: inputs.gmailReader ?? makeGmailReader({ accessToken: gmailToken }), isEc: isEcText } : undefined;
  const calendar = config.calendar.enabled
    ? {
        read:
          inputs.calendarReader ??
          makeGoogleCalendarReader({
            accessToken,
            timeZone: config.timeZone,
            isEc: (event) => isEcEvent(event, precheck),
          }),
        timeZone: config.timeZone,
        now,
      }
    : undefined;
  const calendarConfirm =
    pending && creator
      ? async (id: string, decision: "yes" | "no") => {
          const proposal = pending.take(id);
          if (!proposal) return { ok: false, text: "That proposal has expired or was already answered, so nothing was added. Ask me again if you still want it." };
          if (decision === "no") {
            log.info("calendar create", { outcome: "declined" });
            return { ok: true, text: "Okay, I won't add it." };
          }
          const created = await creator(proposal);
          if (!created.ok) {
            log.warn("calendar create failed", { code: created.error.code, reason: created.error.message });
            return {
              ok: false,
              text: created.error.code === "auth" ? "I couldn't add it: Google didn't allow writing to your calendar. Connect it again with write access (CALENDAR_WRITE=on npm run calendar:connect), tick the box for editing events, then restart Jarvis." : "I couldn't add it: Google Calendar didn't answer properly. Nothing was added.",
            };
          }
          log.info("calendar create", { outcome: "added", allDay: created.value.allDay });
          return { ok: true, text: addedSentence(created.value, config.timeZone, localDate(now(), config.timeZone)), tool: `calendar_create ${proposalPathLabel(proposal)} → added` };
        }
      : undefined;
  const answerers = personalWith(answerLlm.value);
  const localAnswerers = personalWith(localLlm.value);
  const background = inputs.background ?? makeBackgroundTasks({ log });

  return ok({
    contexts: contexts.value,
    precheck,
    calendarEnabled: calendar !== undefined,
    nativeTools: (calendar !== undefined || gmail !== undefined || config.bareMemory) && config.toolCalling,
    ...(calendarConfirm ? { calendarConfirm } : {}),
    classify: makeClassifier({ contexts: contexts.value, llm: classifierLlm.value, log, thinking: config.turn.classifierThinking }),
    stickyContext: config.turn.stickyContext,
    speculativeAnswer: config.turn.speculativeAnswer,
    answer: makeBrainRouter({ claude: makeAnswerRouter(answerers), local: makeAnswerRouter(localAnswerers) }),
    ...(config.bareMode
      ? {
          bare: makeBrainRouter({
            claude: makeBareAnswerer({
              llm: answerLlm.value,
              // Claude decides itself when to read the calendar (#104); the local brain keeps the code-driven path.
              tools: config.toolCalling,
              ...(config.userName ? { userName: config.userName } : {}),
              spokenSentences: config.turn.spokenSentences,
              pauses: config.turn.punctuationStyle,
              ...(config.bareProfile ? { profile } : {}),
              ...(calendar ? { calendar: { ...calendar, ...(pending ? { create: { pending, isEc: isEcText } } : {}) } } : {}),
              // Gmail needs tools (Claude); the local brain doesn't get it.
              ...(gmail && config.toolCalling ? { gmail } : {}),
              // #107: memory across conversations, with tools (Claude); every rule enforced in code.
              ...(config.bareMemory && config.toolCalling
                ? { memory: { store: memoryStore, contexts: contexts.value, ec: makeEcMatchers(contexts.value, neverRemember), timeZone: config.timeZone, log } }
                : {}),
              log,
            }),
            local: makeBareAnswerer({
              llm: localLlm.value,
              ...(config.userName ? { userName: config.userName } : {}),
              spokenSentences: config.turn.spokenSentences,
              pauses: config.turn.punctuationStyle,
              ...(config.bareProfile ? { profile } : {}),
              ...(calendar ? { calendar } : {}),
              log,
            }),
          }),
        }
      : {}),
    isAnswered: (id) => Object.hasOwn(answerers, id),
    afterReply: background.run,
    memory: makeSafeMemoryHooks(
      makeMemoryHooks({
        store: memoryStore,
        // The cheap classifier model decides what to keep; the rules are enforced in code too.
        extract: makeModelExtract({
          llm: classifierLlm.value,
          contexts: contexts.value,
          neverRemember,
          timeZone: config.timeZone,
          log,
        }),
        now,
        log,
      }),
      { log },
    ),
    now,
    log,
  });
};
