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
  /** Latency (#76): a long first sentence is cut at a clause once it's this long (characters). */
  readonly firstChunkChars: number;
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
    readonly answer: ModelRef;
  };
  readonly contextsPath: string;
  readonly profileSource: ProfileSourceRef;
  /** IANA time zone for "now" in prompts, e.g. Europe/Lisbon. */
  readonly timeZone: string;
  readonly memoryStore: MemoryStoreRef;
  readonly tts: TtsConfig;
  readonly stt: SttConfig;
  readonly turn: TurnConfig;
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
  memoryDb: "data/memory.sqlite",
  neverRememberPath: "data/never-remember.txt",
  ttsProvider: "browser",
  kokoroUrl: "http://127.0.0.1:8880",
  piperUrl: "http://127.0.0.1:5001",
  sttProvider: "whisper",
  whisperUrl: "http://127.0.0.1:8178",
  whisperHintsPath: "data/whisper-hints.txt",
  endOfTurnMs: 500,
  // Safari's echo cancellation is weaker than Chrome's (#75): it takes clearer speech to interrupt there.
  bargeInChrome: "vad",
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

  const production = raw("NODE_ENV") === "production";
  if (production && raw("GOOGLE_CLOUD_PROJECT") === undefined) {
    errors.push("GOOGLE_CLOUD_PROJECT: required in production (secrets come from Secret Manager)");
  }

  if (!parsed.success || errors.length > 0 || !classifier || !answer || !profileSource || !timeZone || !kokoroUrl || !piperUrl || !whisperUrl) {
    return err(errors.join("\n"));
  }
  const e = parsed.data;

  return ok({
    env: e.NODE_ENV,
    // Locally the server has no auth, so it only listens on loopback unless told otherwise.
    host: e.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port: e.PORT,
    models: { classifier, answer },
    contextsPath: e.CONTEXTS_PATH ?? DEFAULTS.contextsPath,
    profileSource,
    timeZone,
    // Cloud Run's disk doesn't last, so production keeps memories in RAM until Firestore (#24).
    memoryStore:
      (e.MEMORY_STORE ?? (production ? "memory" : "sqlite")) === "sqlite"
        ? { kind: "sqlite", path: e.MEMORY_DB ?? DEFAULTS.memoryDb }
        : { kind: "memory" },
    neverRememberPath: e.NEVER_REMEMBER_PATH ?? DEFAULTS.neverRememberPath,
    tts: { provider: e.TTS_PROVIDER ?? DEFAULTS.ttsProvider, voice: e.TTS_VOICE ?? "", kokoroUrl, piperUrl },
    stt: { provider: e.STT_PROVIDER ?? DEFAULTS.sttProvider, whisperUrl, hintsPath: e.WHISPER_HINTS_PATH ?? DEFAULTS.whisperHintsPath },
    turn: {
      endOfTurnMs: e.VOICE_END_OF_TURN_MS,
      spokenThinking: e.VOICE_THINKING ?? "off",
      classifierThinking: e.CLASSIFIER_THINKING ?? "off",
      stickyContext: e.STICKY_CONTEXT === "on",
      firstChunkChars: e.VOICE_FIRST_CHUNK_CHARS,
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
