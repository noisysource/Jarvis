import { describe, expect, it, vi } from "vitest";
import { loadConfig, type Config, type Env } from "../src/config.js";
import { makeSecretGetter, resolveAnthropicKey, type GetSecret } from "../src/secrets.js";

const SECRET = "sk-ant-super-secret-value";

const config = (env: Env): Config => {
  const result = loadConfig(env);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("makeSecretGetter", () => {
  it("reads the latest version of the named secret", async () => {
    const access = vi.fn(async () => `${SECRET}\n`);
    const getSecret = makeSecretGetter({ project: "jarvis-prod", access });

    expect(await getSecret("anthropic-api-key")).toEqual({ ok: true, value: SECRET });
    expect(access).toHaveBeenCalledWith("projects/jarvis-prod/secrets/anthropic-api-key/versions/latest");
  });

  it("fetches each secret once per process", async () => {
    const access = vi.fn(async () => SECRET);
    const getSecret = makeSecretGetter({ project: "p", access });

    await Promise.all([getSecret("a"), getSecret("a"), getSecret("a")]);
    await getSecret("a");
    await getSecret("b");

    expect(access).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache failures, so the next call retries", async () => {
    const access = vi
      .fn<(name: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("PERMISSION_DENIED"))
      .mockResolvedValueOnce(SECRET);
    const getSecret = makeSecretGetter({ project: "p", access });

    expect(await getSecret("a")).toEqual({
      ok: false,
      error: 'Couldn\'t read secret "a" in project "p": PERMISSION_DENIED',
    });
    expect(await getSecret("a")).toEqual({ ok: true, value: SECRET });
    expect(access).toHaveBeenCalledTimes(2);
  });

  it("treats an empty secret as an error", async () => {
    const getSecret = makeSecretGetter({ project: "p", access: async () => "  \n" });
    expect(await getSecret("a")).toEqual({ ok: false, error: 'secret "a" in project "p" is empty' });
  });
});

describe("resolveAnthropicKey", () => {
  const secretManager = (value = SECRET): GetSecret => vi.fn(async () => ({ ok: true as const, value }));

  it("uses ANTHROPIC_API_KEY from .env in local development", async () => {
    const getSecret = secretManager("from-secret-manager");
    const result = await resolveAnthropicKey({
      config: config({ GOOGLE_CLOUD_PROJECT: "p" }),
      env: { ANTHROPIC_API_KEY: ` ${SECRET} ` },
      getSecret,
    });
    expect(result).toEqual({ ok: true, value: { key: SECRET, source: "env" } });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("falls back to Secret Manager locally when there's no .env key", async () => {
    const result = await resolveAnthropicKey({
      config: config({ GOOGLE_CLOUD_PROJECT: "p" }),
      env: {},
      getSecret: secretManager(),
    });
    expect(result).toEqual({ ok: true, value: { key: SECRET, source: "secret-manager" } });
  });

  it("ignores ANTHROPIC_API_KEY in production", async () => {
    const getSecret = secretManager("from-secret-manager");
    const result = await resolveAnthropicKey({
      config: config({ NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p", ANTHROPIC_SECRET_NAME: "claude-key" }),
      env: { ANTHROPIC_API_KEY: SECRET },
      getSecret,
    });
    expect(result).toEqual({ ok: true, value: { key: "from-secret-manager", source: "secret-manager" } });
    expect(getSecret).toHaveBeenCalledWith("claude-key");
  });

  it("explains what to do locally when there's no key at all", async () => {
    const result = await resolveAnthropicKey({ config: config({}), env: {}, getSecret: undefined });
    expect(!result.ok && result.error).toContain("copy .env.example to .env and set ANTHROPIC_API_KEY");
  });

  it("passes Secret Manager errors through", async () => {
    const result = await resolveAnthropicKey({
      config: config({ NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p" }),
      env: {},
      getSecret: async () => ({ ok: false, error: 'Couldn\'t read secret "anthropic-api-key": NOT_FOUND' }),
    });
    expect(result).toEqual({ ok: false, error: 'Couldn\'t read secret "anthropic-api-key": NOT_FOUND' });
  });

  it("never puts the key in an error message", async () => {
    const results = await Promise.all([
      resolveAnthropicKey({ config: config({}), env: { ANTHROPIC_API_KEY: "" }, getSecret: undefined }),
      resolveAnthropicKey({
        config: config({ NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p" }),
        env: { ANTHROPIC_API_KEY: SECRET },
        getSecret: makeSecretGetter({ project: "p", access: async () => "" }),
      }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });
});
