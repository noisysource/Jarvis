// Configuration from environment variables. Pure: loadConfig takes the
// environment as an argument and returns every problem at once.
//
// No secret values are read here. ANTHROPIC_API_KEY (local dev only) is
// handled by the secrets module (#6); this module only knows secret *names*.

import { z } from "zod";
import { parseModelRef, type ModelRef } from "./llm/model-ref.js";
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
} as const;

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

  const production = raw("NODE_ENV") === "production";
  if (production && raw("GOOGLE_CLOUD_PROJECT") === undefined) {
    errors.push("GOOGLE_CLOUD_PROJECT: required in production (secrets come from Secret Manager)");
  }

  if (!parsed.success || errors.length > 0 || !classifier || !answer || !profileSource || !timeZone) {
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
    secrets: {
      gcpProject: e.GOOGLE_CLOUD_PROJECT,
      anthropicSecretName: e.ANTHROPIC_SECRET_NAME ?? DEFAULTS.anthropicSecretName,
      vendusSecretName: e.VENDUS_SECRET_NAME,
    },
  });
};
