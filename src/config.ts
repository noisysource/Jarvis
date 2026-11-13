// Configuration from environment variables. Pure: loadConfig takes the
// environment as an argument and returns every problem at once.
//
// No secret values are read here. ANTHROPIC_API_KEY (local dev only) is
// handled by the secrets module (#6); this module only knows secret *names*.

import { z } from "zod";
import { parseModelRef, type ModelRef } from "./llm/model-ref.js";
import { parseLocalUrl } from "./local-url.js";
import type { SttProviderId } from "./stt/types.js";
import type { TtsProviderId } from "./tts/types.js";
import { err, ok, type Result } from "./result.js";

export type RuntimeEnv = "production" | "development" | "test";

/** Where the personal profile comes from. Only files for now; Secret Manager or a bucket later (#25). */
export type ProfileSourceRef = { readonly kind: "file"; readonly path: string };

/**
 * Where memories live: "sqlite" (a local file, the default outside
 * production) or "memory" (RAM only, lost on restart; the production default
 * until the Firestore store, #24).
 */
export type MemoryStoreRef = { readonly kind: "sqlite"; readonly path: string } | { readonly kind: "memory" };

/** Jarvis's spoken voice (#73). Service URLs are always on this machine. */
export type TtsConfig = {
  readonly provider: TtsProviderId;
  /** The voice id for that provider; "" = the provider's default (the browser picks its best voice). */
  readonly voice: string;
  readonly kokoroUrl: URL;
  readonly piperUrl: URL;
};

/** How the page runs a spoken turn (#75). */
export type BargeInMode = "vad" | "strict" | "push";
export type TurnConfig = {
  /** Silence after speech that ends your turn. */
  readonly endOfTurnMs: number;
  /** Latency (#76): spoken answers without thinking first (VOICE_THINKING=off, the default). */
  readonly spokenThinking: "on" | "off";
  /** Latency (#76): the classifier without thinking (CLASSIFIER_THINKING=off, the default). */
  readonly classifierThinking: "on" | "off";
  /** Latency (#76, opt-in): spoken follow-ups stay in the last answered context, skipping the classifier. */
  readonly stickyContext: boolean;
  /** Latency (#76, opt-in): the personal answer starts while the classifier runs, and is thrown away if it disagrees. */
  readonly speculativeAnswer: boolean;
  /** Latency (#76): a long first sentence is cut at a clause once it's this long (characters). */
  readonly firstChunkChars: number;
  /** Spoken bare replies (#92): sentences allowed after the opening reaction, unless detail is asked for. */
  readonly spokenSentences: number;
  /** Spoken bare replies (#94, opt-in): ellipses and dashes for pauses (VOICE_PUNCTUATION_STYLE=on). */
  readonly punctuationStyle: boolean;
  /** Interrupting Jarvis, per browser: "vad" (just talk), "strict" (talk clearly, for weaker echo cancellation) or "push" (tap Interrupt). */
  readonly bargeIn: { readonly chrome: BargeInMode; readonly safari: BargeInMode; readonly other: BargeInMode };
};

/** Jarvis's ears (#74). The service URL is always on this machine. */
export type SttConfig = {
  readonly provider: SttProviderId;
  readonly whisperUrl: URL;
  /** Expected names for Whisper, one per line (#83). Gitignored; missing is fine. */
  readonly hintsPath: string;
};

export type Config = {
  readonly env: RuntimeEnv;
  readonly host: string;
  readonly port: number;
  readonly models: {
    readonly classifier: ModelRef;
    /** The "Claude" brain. */
    readonly answer: ModelRef;
    /** The "Local" brain (#88): OLLAMA_MODEL on Ollama. */
    readonly local: ModelRef;
  };
  readonly contextsPath: string;
  readonly profileSource: ProfileSourceRef;
  /** IANA time zone for "now" in prompts, e.g. Europe/Lisbon. */
  readonly timeZone: string;
  readonly memoryStore: MemoryStoreRef;
  readonly tts: TtsConfig;
  readonly stt: SttConfig;
  readonly turn: TurnConfig;
  /** Ollama on this machine (#88). */
  readonly ollamaUrl: URL;
  /** OLLAMA_THINK (default off): whether the local model thinks before answering; off answers sooner. */
  readonly ollamaThink: boolean;
  /** BARE_MODE=on (#88): every turn gets only the local EC precheck, then the brain with the history and a short persona. */
  readonly bareMode: boolean;
  /** PROFILE=on (#98): in bare mode, the brain also gets data/profile.md. Otherwise still bare. */
  readonly bareProfile: boolean;
  /**
   * CALENDAR=on (#100, bare mode, this Mac only): reading your personal
   * Google Calendar. The OAuth client and tokens are gitignored files here.
   */
  readonly calendar: {
    readonly enabled: boolean;
    /** CALENDAR_WRITE=on (Reach 2): Claude may propose new events; only your OK adds them. Needs calendar:connect with write access. */
    readonly write: boolean;
    readonly clientPath: string;
    readonly tokensPath: string;
  };
  /**
   * GMAIL=on (Reach 3): Claude can search and read the "personal" and
   * "noisysource" Gmail accounts, read-only. Each is connected separately
   * (npm run gmail:connect -- <account>); its token file is under data/.
   */
  /** `write` (GMAIL_WRITE=on, #120): drafts, and sending after "Send it". Needs gmail:connect with write access. */
  readonly gmail: { readonly enabled: boolean; readonly write: boolean; readonly tokensPath: (account: string) => string };
  /**
   * GITHUB=on (#125): Claude can read Renato's repos, read-only (GET calls
   * only): list repos, read files, issues and PRs, CI status. Tokens are
   * fine-grained, read-only, one per owner (npm run github:connect -- <owner>),
   * in a file under data/. Local only for now.
   */
  readonly github: { readonly enabled: boolean; readonly tokensPath: string };
  /**
   * GCLOUD=on (#161): Claude can read errors and logs in Renato's Google Cloud
   * environments, read-only. One service account key per environment
   * (npm run gcloud:connect -- <env> <key.json>) in a folder under data/.
   * Local only for now.
   */
  readonly gcloud: { readonly enabled: boolean; readonly keysPath: string };
  /**
   * CODE_AGENT=on (#126): Claude can ask a code agent (Claude Code, read-only,
   * on a local copy in data/repos/) about one of the repos GITHUB=on reaches.
   * Each question is capped: CODE_AGENT_MAX_USD (default 0.50) and
   * CODE_AGENT_MAX_TURNS (default 25).
   */
  readonly codeAgent: {
    readonly enabled: boolean;
    readonly maxUsd: number;
    readonly maxTurns: number;
    readonly reposPath: string;
    /** #150: CODE_AGENT_AUTH: "auto" (default: his Claude login, else the API key), "subscription" or "api-key". */
    readonly auth: "auto" | "subscription" | "api-key";
    /**
     * #127: the ceiling for one study (a repo, or one app in a monorepo):
     * CODE_STUDY_MAX_USD (default 5) and CODE_STUDY_MAX_TURNS (default 150).
     * High on purpose: a study reads a lot, once. Notes go to `notesPath`.
     */
    readonly study: { readonly maxUsd: number; readonly maxTurns: number; readonly notesPath: string };
  };
  /**
   * MEMORY=on (#107), with BARE_MODE=on and Claude's tools: Jarvis remembers
   * across conversations like a person (short-term that fades, long-term that
   * lasts), saving and recalling with tools. Memories live in MEMORY_DB.
   */
  readonly bareMemory: boolean;
  /** INTROSPECTION=on (#108), with MEMORY=on: every night at 03:30, Jarvis reviews his short-term memory. Report in data/introspection/. */
  readonly introspection: boolean;
  /** TOOL_CALLING (#104, default on): Claude decides itself when to use a tool; code validates each call. Off: code decides, as for the local brain. */
  readonly toolCalling: boolean;
  /** Your name for the persona (JARVIS_USER_NAME, in the gitignored .env); none: "the person you're talking to". */
  readonly userName: string | undefined;
  /** Names and phrases memories must never contain (colleagues and the like). Gitignored; missing is fine. */
  readonly neverRememberPath: string;
  readonly secrets: {
    /** Required in production; optional locally, where the key may come from .env. */
    readonly gcpProject: string | undefined;
    readonly anthropicSecretName: string;
    /** Not needed in M0. */
    readonly vendusSecretName: string | undefined;
  };
};

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULTS = {
  port: 8080,
  classifierModel: "anthropic:claude-haiku-5-5",
  answerModel: "anthropic:claude-sonnet-5-5",
  contextsPath: "contexts.md",
  profileSource: "file:data/profile.md",
  anthropicSecretName: "anthropic-api-key",
  timeZone: "Europe/Lisbon",
  googleOAuthClientPath: "data/google-oauth-client.json",
  googleTokensPath: "data/google-tokens.json",
  memoryDb: "data/memory.sqlite",
  neverRememberPath: "data/never-remember.txt",
  ttsProvider: "browser",
  kokoroUrl: "http://127.0.0.1:8880",
  piperUrl: "http://127.0.0.1:5001",
  sttProvider: "whisper",
  whisperUrl: "http://127.0.0.1:8178",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen3:8b",
  whisperHintsPath: "data/whisper-hints.txt",
  endOfTurnMs: 500,
  // Through laptop speakers both browsers can hear Jarvis himself (#75, #76):
  // Chrome's echo cancellation let "Sure" interrupt itself, so both take
  // clearer speech to interrupt. With headphones, "vad" is fine everywhere.
  bargeInChrome: "strict",
  bargeInSafari: "strict",
  bargeInOther: "vad",
} as const;

const END_OF_TURN_ERROR = "must be a whole number of milliseconds from 200 to 3000";
const FIRST_CHUNK_ERROR = "must be a whole number of characters from 30 to 300";
const onOff = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.enum(["on", "off"], { error: 'must be "on" or "off"' }).optional(),
);
const bargeInMode = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.enum(["vad", "strict", "push"], { error: 'must be "vad", "strict" or "push"' }).optional(),
);

const PORT_ERROR = "must be a whole number from 1 to 65535";

// Empty strings (e.g. "PORT=") count as unset.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["production", "development", "test"]).default("development"),
  ),
  HOST: optionalString,
  PORT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: PORT_ERROR })
      .int({ error: PORT_ERROR })
      .min(1, { error: PORT_ERROR })
      .max(65535, { error: PORT_ERROR })
      .default(DEFAULTS.port),
  ),
  CLASSIFIER_MODEL: optionalString,
  ANSWER_MODEL: optionalString,
  CONTEXTS_PATH: optionalString,
  PROFILE_SOURCE: optionalString,
  TIMEZONE: optionalString,
  MEMORY_STORE: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["sqlite", "memory"], { error: 'must be "sqlite" or "memory"' }).optional(),
  ),
  MEMORY_DB: optionalString,
  NEVER_REMEMBER_PATH: optionalString,
  TTS_PROVIDER: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["kokoro", "piper", "browser"], { error: 'must be "kokoro", "piper" or "browser"' }).optional(),
  ),
  TTS_VOICE: optionalString,
  KOKORO_URL: optionalString,
  PIPER_URL: optionalString,
  STT_PROVIDER: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["whisper"], { error: 'must be "whisper"' }).optional(),
  ),
  WHISPER_URL: optionalString,
  OLLAMA_URL: optionalString,
  OLLAMA_MODEL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:/-]{1,100}$/, { error: "must be an Ollama model name, e.g. qwen3:8b" })
      .optional(),
  ),
  JARVIS_USER_NAME: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^[\p{L}][\p{L}' .-]{0,39}$/u, { error: "must be a name (letters, up to 40 characters)" })
      .optional(),
  ),
  OLLAMA_THINK: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["on", "off"], { error: 'must be "on" or "off"' }).optional(),
  ),
  BARE_MODE: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["on", "off"], { error: 'must be "on" or "off"' }).optional(),
  ),
  PROFILE: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["on", "off"], { error: 'must be "on" or "off"' }).optional(),
  ),
  CALENDAR: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["on", "off"], { error: 'must be "on" or "off"' }).optional(),
  ),
  TOOL_CALLING: onOff,
  CALENDAR_WRITE: onOff,
  GMAIL: onOff,
  GITHUB: onOff,
  GCLOUD: onOff,
  CODE_AGENT: onOff,
  CODE_AGENT_AUTH: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["auto", "subscription", "api-key"], { error: 'must be "auto", "subscription" or "api-key"' }).default("auto"),
  ),
  CODE_STUDY_MAX_USD: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number({ error: "must be a number from 0.5 to 50" }).min(0.5, { error: "must be a number from 0.5 to 50" }).max(50, { error: "must be a number from 0.5 to 50" }).default(5),
  ),
  CODE_STUDY_MAX_TURNS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: "must be a whole number from 10 to 400" })
      .int({ error: "must be a whole number from 10 to 400" })
      .min(10, { error: "must be a whole number from 10 to 400" })
      .max(400, { error: "must be a whole number from 10 to 400" })
      .default(150),
  ),
  CODE_AGENT_MAX_USD: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number({ error: "must be a number from 0.05 to 5" }).min(0.05, { error: "must be a number from 0.05 to 5" }).max(5, { error: "must be a number from 0.05 to 5" }).default(0.5),
  ),
  CODE_AGENT_MAX_TURNS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: "must be a whole number from 3 to 60" })
      .int({ error: "must be a whole number from 3 to 60" })
      .min(3, { error: "must be a whole number from 3 to 60" })
      .max(60, { error: "must be a whole number from 3 to 60" })
      .default(25),
  ),
  GMAIL_WRITE: onOff,
  MEMORY: onOff,
  INTROSPECTION: onOff,
  GOOGLE_OAUTH_CLIENT_PATH: optionalString,
  GOOGLE_TOKENS_PATH: optionalString,
  WHISPER_HINTS_PATH: optionalString,
  VOICE_END_OF_TURN_MS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: END_OF_TURN_ERROR })
      .int({ error: END_OF_TURN_ERROR })
      .min(200, { error: END_OF_TURN_ERROR })
      .max(3000, { error: END_OF_TURN_ERROR })
      .default(DEFAULTS.endOfTurnMs),
  ),
  VOICE_THINKING: onOff,
  CLASSIFIER_THINKING: onOff,
  STICKY_CONTEXT: onOff,
  SPECULATIVE_ANSWER: onOff,
  VOICE_PUNCTUATION_STYLE: onOff,
  VOICE_MAX_SENTENCES: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: "must be a whole number from 1 to 10" })
      .int({ error: "must be a whole number from 1 to 10" })
      .min(1, { error: "must be a whole number from 1 to 10" })
      .max(10, { error: "must be a whole number from 1 to 10" })
      .default(2),
  ),
  VOICE_FIRST_CHUNK_CHARS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ error: FIRST_CHUNK_ERROR })
      .int({ error: FIRST_CHUNK_ERROR })
      .min(30, { error: FIRST_CHUNK_ERROR })
      .max(300, { error: FIRST_CHUNK_ERROR })
      .default(60),
  ),
  BARGE_IN_CHROME: bargeInMode,
  BARGE_IN_SAFARI: bargeInMode,
  BARGE_IN_OTHER: bargeInMode,
  GOOGLE_CLOUD_PROJECT: optionalString,
  ANTHROPIC_SECRET_NAME: optionalString,
  VENDUS_SECRET_NAME: optionalString,
});

export const parseProfileSource = (value: string): Result<ProfileSourceRef, string> => {
  const separator = value.indexOf(":");
  const scheme = separator === -1 ? "" : value.slice(0, separator);
  const rest = separator === -1 ? "" : value.slice(separator + 1).trim();
  if (scheme === "file" && rest !== "") return ok({ kind: "file", path: rest });
  if (scheme === "file") return err(`"file:" needs a path, e.g. "file:data/profile.md"`);
  return err(`unknown scheme in "${value}" (supported: file:<path>)`);
};

export const parseTimeZone = (value: string): Result<string, string> => {
  try {
    return ok(new Intl.DateTimeFormat("en-GB", { timeZone: value }).resolvedOptions().timeZone);
  } catch {
    return err(`unknown time zone "${value}" (use an IANA name such as Europe/Lisbon)`);
  }
};

export const loadConfig = (env: Env): Result<Config, string> => {
  const parsed = EnvSchema.safeParse(env);
  const errors: string[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`);

  // The remaining checks only need the raw strings, so they run even when the
  // schema failed, and every problem is reported in one go.
  const raw = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const field = <T>(name: string, result: Result<T, string>): T | undefined => {
    if (result.ok) return result.value;
    errors.push(`${name}: ${result.error}`);
    return undefined;
  };

  const classifier = field("CLASSIFIER_MODEL", parseModelRef(raw("CLASSIFIER_MODEL") ?? DEFAULTS.classifierModel));
  const answer = field("ANSWER_MODEL", parseModelRef(raw("ANSWER_MODEL") ?? DEFAULTS.answerModel));
  const profileSource = field("PROFILE_SOURCE", parseProfileSource(raw("PROFILE_SOURCE") ?? DEFAULTS.profileSource));
  const timeZone = field("TIMEZONE", parseTimeZone(raw("TIMEZONE") ?? DEFAULTS.timeZone));
  const kokoroUrl = field("KOKORO_URL", parseLocalUrl(raw("KOKORO_URL") ?? DEFAULTS.kokoroUrl));
  const piperUrl = field("PIPER_URL", parseLocalUrl(raw("PIPER_URL") ?? DEFAULTS.piperUrl));
  const whisperUrl = field("WHISPER_URL", parseLocalUrl(raw("WHISPER_URL") ?? DEFAULTS.whisperUrl));
  const ollamaUrl = field("OLLAMA_URL", parseLocalUrl(raw("OLLAMA_URL") ?? DEFAULTS.ollamaUrl));

  const production = raw("NODE_ENV") === "production";
  if (production && raw("GOOGLE_CLOUD_PROJECT") === undefined) {
    errors.push("GOOGLE_CLOUD_PROJECT: required in production (secrets come from Secret Manager)");
  }
  if (raw("CALENDAR") === "on") {
    // The calendar's tokens are files on this Mac; in the cloud, secrets come only from Secret Manager.
    if (production) errors.push("CALENDAR: local only for now (its tokens are files on this Mac, not in Secret Manager)");
    if (raw("BARE_MODE") !== "on") errors.push("CALENDAR: needs BARE_MODE=on for now");
  }
  if (raw("CALENDAR_WRITE") === "on" && raw("CALENDAR") !== "on") errors.push("CALENDAR_WRITE: needs CALENDAR=on");
  if (raw("INTROSPECTION") === "on" && raw("MEMORY") !== "on") errors.push("INTROSPECTION: needs MEMORY=on");
  if (raw("MEMORY") === "on" && raw("BARE_MODE") !== "on") errors.push("MEMORY: needs BARE_MODE=on (without it, the older memory runs on its own)");
  if (raw("GMAIL_WRITE") === "on" && raw("GMAIL") !== "on") errors.push("GMAIL_WRITE: needs GMAIL=on");
  if (raw("GMAIL") === "on") {
    if (production) errors.push("GMAIL: local only for now");
    if (raw("BARE_MODE") !== "on") errors.push("GMAIL: needs BARE_MODE=on for now");
  }
  if (raw("CODE_AGENT") === "on" && raw("GITHUB") !== "on") errors.push("CODE_AGENT: needs GITHUB=on (it reads the repos GitHub reaches)");
  if (raw("GCLOUD") === "on") {
    if (production) errors.push("GCLOUD: local only for now (its keys are files on this Mac, not in Secret Manager)");
    if (raw("BARE_MODE") !== "on") errors.push("GCLOUD: needs BARE_MODE=on");
  }
  if (raw("GITHUB") === "on") {
    if (production) errors.push("GITHUB: local only for now (its tokens are a file on this Mac, not in Secret Manager)");
    if (raw("BARE_MODE") !== "on") errors.push("GITHUB: needs BARE_MODE=on");
  }

  if (!parsed.success || errors.length > 0 || !classifier || !answer || !profileSource || !timeZone || !kokoroUrl || !piperUrl || !whisperUrl || !ollamaUrl) {
    return err(errors.join("\n"));
  }
  const e = parsed.data;

  return ok({
    env: e.NODE_ENV,
    // Locally the server has no auth, so it only listens on loopback unless told otherwise.
    host: e.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port: e.PORT,
    models: { classifier, answer, local: { provider: "ollama", model: e.OLLAMA_MODEL ?? DEFAULTS.ollamaModel } },
    contextsPath: e.CONTEXTS_PATH ?? DEFAULTS.contextsPath,
    profileSource,
    timeZone,
    // Cloud Run's disk doesn't last, so production keeps memories in RAM until Firestore (#24).
    memoryStore:
      (e.MEMORY_STORE ?? (production ? "memory" : "sqlite")) === "sqlite"
        ? { kind: "sqlite", path: e.MEMORY_DB ?? DEFAULTS.memoryDb }
        : { kind: "memory" },
    neverRememberPath: e.NEVER_REMEMBER_PATH ?? DEFAULTS.neverRememberPath,
    ollamaUrl,
    bareMode: e.BARE_MODE === "on",
    bareProfile: e.PROFILE === "on",
    calendar: {
      enabled: e.CALENDAR === "on",
      write: e.CALENDAR === "on" && e.CALENDAR_WRITE === "on",
      clientPath: e.GOOGLE_OAUTH_CLIENT_PATH ?? DEFAULTS.googleOAuthClientPath,
      tokensPath: e.GOOGLE_TOKENS_PATH ?? DEFAULTS.googleTokensPath,
    },
    toolCalling: e.TOOL_CALLING !== "off",
    bareMemory: e.MEMORY === "on",
    introspection: e.MEMORY === "on" && e.INTROSPECTION === "on",
    gmail: { enabled: e.GMAIL === "on", write: e.GMAIL === "on" && e.GMAIL_WRITE === "on", tokensPath: (account: string) => `data/google-gmail-${account}.json` },
    github: { enabled: e.GITHUB === "on", tokensPath: "data/github-tokens.json" },
    gcloud: { enabled: e.GCLOUD === "on", keysPath: "data/gcloud" },
    codeAgent: { enabled: e.GITHUB === "on" && e.CODE_AGENT === "on", maxUsd: e.CODE_AGENT_MAX_USD, maxTurns: e.CODE_AGENT_MAX_TURNS, reposPath: "data/repos", auth: e.CODE_AGENT_AUTH, study: { maxUsd: e.CODE_STUDY_MAX_USD, maxTurns: e.CODE_STUDY_MAX_TURNS, notesPath: "data/code" } },
    ollamaThink: e.OLLAMA_THINK === "on",
    userName: e.JARVIS_USER_NAME,
    tts: { provider: e.TTS_PROVIDER ?? DEFAULTS.ttsProvider, voice: e.TTS_VOICE ?? "", kokoroUrl, piperUrl },
    stt: { provider: e.STT_PROVIDER ?? DEFAULTS.sttProvider, whisperUrl, hintsPath: e.WHISPER_HINTS_PATH ?? DEFAULTS.whisperHintsPath },
    turn: {
      endOfTurnMs: e.VOICE_END_OF_TURN_MS,
      spokenThinking: e.VOICE_THINKING ?? "off",
      classifierThinking: e.CLASSIFIER_THINKING ?? "off",
      stickyContext: e.STICKY_CONTEXT === "on",
      speculativeAnswer: e.SPECULATIVE_ANSWER === "on",
      firstChunkChars: e.VOICE_FIRST_CHUNK_CHARS,
      spokenSentences: e.VOICE_MAX_SENTENCES,
      punctuationStyle: e.VOICE_PUNCTUATION_STYLE === "on",
      bargeIn: {
        chrome: e.BARGE_IN_CHROME ?? DEFAULTS.bargeInChrome,
        safari: e.BARGE_IN_SAFARI ?? DEFAULTS.bargeInSafari,
        other: e.BARGE_IN_OTHER ?? DEFAULTS.bargeInOther,
      },
    },
    secrets: {
      gcpProject: e.GOOGLE_CLOUD_PROJECT,
      anthropicSecretName: e.ANTHROPIC_SECRET_NAME ?? DEFAULTS.anthropicSecretName,
      vendusSecretName: e.VENDUS_SECRET_NAME,
    },
  });
};
