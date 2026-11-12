// Builds the real dependencies for the ask handler from config. Used by the
// server (#15) and the end-to-end tests. Refuses to start (returns an error)
// if contexts.md, the profile or the API key is missing or invalid.

import { readFile } from "node:fs/promises";
import { makeBareAnswerer } from "./answer/bare.js";
import { makePersonalAnswerer } from "./answer/personal.js";
import { makeAnswerRouter, makeBrainRouter } from "./answer/router.js";
import { makeGoogleCalendarReader, type CalendarReader } from "./calendar/google.js";
import { makeAccessTokens } from "./calendar/oauth.js";
import { isEcEvent, localDate, type CalendarError } from "./calendar/read.js";
import { CALENDAR_ACCOUNTS, calendarTokensPath, type CalendarAccount, type CalendarReaders } from "./calendar/accounts.js";
import { makeGithubReader, makeGithubTokens, type GithubReader } from "./github/github.js";
import { GMAIL_ACCOUNTS, makeGmailReader, type GmailAccount, type GmailReader } from "./gmail/gmail.js";
import { makeDraftBook, makeGmailWriter, makePendingDrafts, type GmailWriter } from "./gmail/send.js";
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
import { runIntrospection } from "./introspection.js";
import { makeSkillStore, type SkillStore } from "./skills.js";
import { access, chmod, mkdir, readFile as readFileFs, writeFile } from "node:fs/promises";
import { reachView } from "./reach.js";
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
  /** Tests: skills without a file (#116). */
  readonly skillStore?: SkillStore;
  /** Tests: where the introspection report goes (#108). */
  readonly writeIntrospectionReport?: (date: string, markdown: string) => Promise<void>;
  /** Tests: writes drafts and sends instead of Gmail (#120). */
  readonly gmailWriter?: GmailWriter;
  /** Tests: a GitHub reader instead of the real one (#125). */
  readonly githubReader?: GithubReader;
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
  // Your calendars (#100, #137: personal and noisysource, each its own connection), read-only, for both brains.
  // EC-looking events reach a brain only as "EC work, handled by Kiro".
  const precheck = makePrecheck(contexts.value);
  const calendarTokens = new Map(
    CALENDAR_ACCOUNTS.map((account) => [
      account,
      makeAccessTokens({
        clientPath: config.calendar.clientPath,
        tokensPath: calendarTokensPath(config.calendar.tokensPath, account),
        ...(account === "personal" ? {} : { what: { name: `The ${account} calendar`, connect: `npm run calendar:connect -- ${account}` } }),
      }),
    ]),
  );
  const calendarToken = (account: CalendarAccount) => calendarTokens.get(account)?.() ?? Promise.resolve(err<CalendarError>({ code: "not_connected", message: "not connected" }));
  // Reach 2 (CALENDAR_WRITE=on): Claude proposes, the page asks, and only "yes" creates.
  const pending = config.calendar.write ? makePendingProposals() : undefined;
  const creator = config.calendar.write ? (inputs.eventCreator ?? makeGoogleEventCreator({ accessToken: calendarToken, timeZone: config.timeZone })) : undefined;
  const isEcText = (text: string): boolean => precheck(text).kind === "handoff";
  // #116: skills, with memory. data/skills.json, gitignored, readable only by him.
  const skillStore = config.bareMemory
    ? (inputs.skillStore ??
      makeSkillStore({
        read: () => readFileFs("data/skills.json", "utf8").catch(() => undefined),
        write: async (text) => {
          await writeFile("data/skills.json", text, { mode: 0o600 });
          await chmod("data/skills.json", 0o600);
        },
        now,
      }))
    : undefined;
  const memoryEc = makeEcMatchers(contexts.value, neverRemember);
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
  // #120 (GMAIL_WRITE=on): drafts are saved in Gmail; sending waits for "Send it".
  const drafts = config.gmail.write
    ? { write: inputs.gmailWriter ?? makeGmailWriter({ accessToken: gmailToken }), pending: makePendingDrafts(), book: makeDraftBook(), deletions: makePendingDrafts() }
    : undefined;
  const gmail = config.gmail.enabled
    ? { reader: inputs.gmailReader ?? makeGmailReader({ accessToken: gmailToken }), isEc: isEcText, ...(drafts ? { writer: drafts } : {}) }
    : undefined;
  const gmailSend = drafts
    ? async (id: string, decision: "yes" | "no") => {
        const draft = drafts.pending.take(id);
        if (!draft) return { ok: false, text: "That draft's card has expired or was already answered. It's still in your Gmail Drafts if you want to send it there." };
        if (decision === "no") {
          log.info("gmail send", { outcome: "kept as draft" });
          return { ok: true, text: `Okay, it stays in your ${draft.account} Gmail Drafts.` };
        }
        const sent = await drafts.write.send(draft.account, draft.draftId);
        if (!sent.ok) {
          log.warn("gmail send failed", { code: sent.error.code, reason: sent.error.message });
          return {
            ok: false,
            text:
              sent.error.code === "auth"
                ? `I couldn't send it: Gmail didn't allow it. Connect ${draft.account} again with write access (GMAIL_WRITE=on npm run gmail:connect -- ${draft.account}), then restart Jarvis. It's still in Drafts.`
                : "I couldn't send it: Gmail didn't answer properly. It's still in your Drafts.",
          };
        }
        log.info("gmail send", { outcome: "sent", recipients: draft.to.length });
        return { ok: true, text: `Sent “${draft.subject}” to ${draft.to.join(", ")}.`, tool: `gmail_send ${draft.account} → sent` };
      }
    : undefined;
  // #124: his answer to "delete this draft?". Only "yes" deletes, and only a draft Jarvis wrote.
  const discard = drafts?.write.discard;
  const gmailDelete =
    drafts && discard
      ? async (id: string, decision: "yes" | "no") => {
          const draft = drafts.deletions.take(id);
          if (!draft) return { ok: false, text: "That card has expired or was already answered. The draft is still in your Gmail Drafts if you want to delete it there." };
          if (decision === "no") {
            log.info("gmail draft delete", { outcome: "kept" });
            return { ok: true, text: `Okay, I kept the draft “${draft.subject}”.` };
          }
          const done = await discard(draft.account, draft.draftId);
          if (!done.ok) {
            log.warn("gmail draft delete failed", { code: done.error.code, reason: done.error.message });
            return {
              ok: false,
              text:
                done.error.code === "auth"
                  ? `I couldn't delete it: Gmail didn't allow it. Connect ${draft.account} again with write access (GMAIL_WRITE=on npm run gmail:connect -- ${draft.account}), then restart Jarvis.`
                  : `I couldn't delete it: ${done.error.message}.`,
            };
          }
          if (draft.ref) drafts.book.remove(draft.ref);
          log.info("gmail draft delete", { outcome: "deleted" });
          return { ok: true, text: `Deleted the draft “${draft.subject}”.`, tool: `gmail_draft_delete ${draft.account} → deleted` };
        }
      : undefined;
  // #125: GitHub, read-only, one fine-grained token per owner in data/github-tokens.json (mode 600).
  const githubTokens = makeGithubTokens({ readFile: () => readFileFs(config.github.tokensPath, "utf8") });
  const github = config.github.enabled ? { reader: inputs.githubReader ?? makeGithubReader({ tokens: githubTokens }), isEc: isEcText } : undefined;
  // #146: which accounts are connected, checked each turn (does the token file exist), for the brain's prompt.
  const fileExists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const connected = async () => ({
    ...(config.calendar.enabled
      ? { calendar: await Promise.all(CALENDAR_ACCOUNTS.map(async (name) => ({ name, connected: await fileExists(calendarTokensPath(config.calendar.tokensPath, name)) }))) }
      : {}),
    ...(config.gmail.enabled ? { gmail: await Promise.all(GMAIL_ACCOUNTS.map(async (name) => ({ name, connected: await fileExists(config.gmail.tokensPath(name)) }))) } : {}),
  });
  const calendarReader = (account: CalendarAccount) =>
    makeGoogleCalendarReader({
      accessToken: () => calendarToken(account),
      timeZone: config.timeZone,
      isEc: (event) => isEcEvent(event, precheck),
      account,
    });
  const calendar = config.calendar.enabled
    ? {
        read: inputs.calendarReader ?? calendarReader("personal"),
        // Tests give one reader (personal); the real app reads every account.
        ...(inputs.calendarReader ? {} : { accounts: Object.fromEntries(CALENDAR_ACCOUNTS.map((a) => [a, calendarReader(a)])) as CalendarReaders }),
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
    // #108: the nightly review, with the answer model (Claude): it runs once a night, so quality over cost.
    ...(config.bareMemory
      ? {
          introspect: () =>
            runIntrospection({
              store: memoryStore,
              llm: answerLlm.value,
              contexts: contexts.value,
              ec: memoryEc,
              timeZone: config.timeZone,
              now,
              log,
              ...(skillStore ? { skills: skillStore } : {}),
              writeReport:
                inputs.writeIntrospectionReport ??
                (async (date, markdown) => {
                  await mkdir("data/introspection", { recursive: true, mode: 0o700 });
                  const path = `data/introspection/${date}.md`;
                  await writeFile(path, markdown, { mode: 0o600 });
                  await chmod(path, 0o600);
                }),
            }),
        }
      : {}),
    ...(skillStore ? { skills: skillStore } : {}),
    nativeTools: (calendar !== undefined || gmail !== undefined || config.bareMemory) && config.toolCalling,
    ...(calendarConfirm ? { calendarConfirm } : {}),
    reach: () =>
      reachView({
        config,
        exists: fileExists,
        githubOwners: githubTokens.owners,
        ...(skillStore ? { draftSkills: async () => (await skillStore.list()).filter((s) => s.status === "draft").length } : {}),
      }),
    ...(gmailSend ? { gmailSend } : {}),
    ...(gmailDelete ? { gmailDelete } : {}),
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
                ? { memory: { store: memoryStore, contexts: contexts.value, ec: memoryEc, timeZone: config.timeZone, log } }
                : {}),
              ...(skillStore && config.toolCalling ? { skills: { store: skillStore, ec: memoryEc } } : {}),
              // #125: his GitHub repos, read-only, with tools (Claude).
              ...(github && config.toolCalling ? { github } : {}),
              // Tests give their own calendar reader: no token files to check then.
              ...(inputs.calendarReader || inputs.gmailReader ? {} : { connected }),
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
