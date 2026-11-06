// Secrets. In the cloud they come only from Google Secret Manager. For local
// development only, ANTHROPIC_API_KEY may come from a gitignored .env file.
//
// Secret values are never logged and never put in error messages.

import type { Config, Env } from "./config.js";
import { err, ok, type Result } from "./result.js";

/** Reads the payload of one secret version, e.g. "projects/p/secrets/s/versions/latest". */
export type SecretAccess = (versionName: string) => Promise<string>;

export type GetSecret = (name: string) => Promise<Result<string, string>>;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Reads `projects/{project}/secrets/{name}/versions/latest`. Each secret is
 * fetched once per process; a failed fetch isn't cached, so the next call
 * retries.
 */
export const makeSecretGetter = (deps: {
  readonly project: string;
  readonly access: SecretAccess;
}): GetSecret => {
  const cache = new Map<string, Promise<Result<string, string>>>();

  const fetchSecret = async (name: string): Promise<Result<string, string>> => {
    const where = `secret "${name}" in project "${deps.project}"`;
    try {
      const value = (await deps.access(`projects/${deps.project}/secrets/${name}/versions/latest`)).trim();
      return value === "" ? err(`${where} is empty`) : ok(value);
    } catch (e) {
      return err(`Couldn't read ${where}: ${reason(e)}`);
    }
  };

  return (name) => {
    const cached = cache.get(name);
    if (cached) return cached;
    const pending = fetchSecret(name).then((result) => {
      if (!result.ok) cache.delete(name);
      return result;
    });
    cache.set(name, pending);
    return pending;
  };
};

/**
 * Real Secret Manager access. The client library is loaded on first use, so
 * running locally with a key in .env never needs Google credentials.
 */
export const makeGcpSecretAccess = (): SecretAccess => {
  let client: Promise<{ accessSecretVersion: (req: { name: string }) => Promise<unknown> }> | undefined;
  return async (versionName) => {
    client ??= import("@google-cloud/secret-manager").then((m) => new m.SecretManagerServiceClient());
    const [version] = (await (await client).accessSecretVersion({ name: versionName })) as [
      { payload?: { data?: Uint8Array | string | null } | null },
    ];
    const data = version.payload?.data;
    if (data === undefined || data === null) return "";
    return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  };
};

export type KeySource = "env" | "secret-manager";

/**
 * Resolves the Anthropic API key:
 * - production: Secret Manager only; ANTHROPIC_API_KEY is ignored.
 * - elsewhere: ANTHROPIC_API_KEY (from .env) if set, otherwise Secret Manager
 *   when GOOGLE_CLOUD_PROJECT is set.
 * Returns where the key came from (never the key) so startup can log it.
 */
export const resolveAnthropicKey = async (deps: {
  readonly config: Config;
  readonly env: Env;
  readonly getSecret: GetSecret | undefined;
}): Promise<Result<{ key: string; source: KeySource }, string>> => {
  const { config, env, getSecret } = deps;
  const localKey = env.ANTHROPIC_API_KEY?.trim();

  if (config.env !== "production" && localKey) {
    return ok({ key: localKey, source: "env" });
  }

  if (!getSecret || config.secrets.gcpProject === undefined) {
    return err(
      config.env === "production"
        ? "No Secret Manager access: GOOGLE_CLOUD_PROJECT is not set"
        : "No Anthropic API key: copy .env.example to .env and set ANTHROPIC_API_KEY, or set GOOGLE_CLOUD_PROJECT to use Secret Manager",
    );
  }

  const secret = await getSecret(config.secrets.anthropicSecretName);
  return secret.ok ? ok({ key: secret.value, source: "secret-manager" }) : secret;
};
