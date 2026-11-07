import { describe, expect, it } from "vitest";
import { loadConfig, parseProfileSource, type Config, type Env } from "../src/config.js";
import { formatModelRef, parseModelRef } from "../src/llm/model-ref.js";

const loadOk = (env: Env): Config => {
  const result = loadConfig(env);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const loadErr = (env: Env): string => {
  const result = loadConfig(env);
  if (result.ok) throw new Error("expected a config error");
  return result.error;
};

describe("loadConfig", () => {
  it("applies defaults for local development", () => {
    expect(loadOk({})).toEqual({
      env: "development",
      host: "127.0.0.1",
      port: 8080,
      models: {
        classifier: { provider: "anthropic", model: "claude-haiku-5-5" },
        answer: { provider: "anthropic", model: "claude-sonnet-5-5" },
      },
      contextsPath: "contexts.md",
      profileSource: { kind: "file", path: "data/profile.md" },
      timeZone: "Europe/Lisbon",
      memoryStore: { kind: "sqlite", path: "data/memory.sqlite" },
      secrets: { gcpProject: undefined, anthropicSecretName: "anthropic-api-key", vendusSecretName: undefined },
    });
  });

  it("chooses where memories live", () => {
    expect(loadOk({ MEMORY_DB: "/var/lib/jarvis/memory.sqlite" }).memoryStore).toEqual({
      kind: "sqlite",
      path: "/var/lib/jarvis/memory.sqlite",
    });
    expect(loadOk({ MEMORY_STORE: "memory" }).memoryStore).toEqual({ kind: "memory" });
    // Production keeps memories in RAM until Firestore (#24), unless told otherwise (e.g. on the Pi).
    expect(loadOk({ NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p" }).memoryStore).toEqual({ kind: "memory" });
    expect(loadOk({ NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p", MEMORY_STORE: "sqlite" }).memoryStore).toEqual({
      kind: "sqlite",
      path: "data/memory.sqlite",
    });
    const bad = loadConfig({ MEMORY_STORE: "redis" });
    expect(!bad.ok && bad.error).toContain('MEMORY_STORE: must be "sqlite" or "memory"');
  });

  it("accepts overrides", () => {
    const config = loadOk({
      HOST: "0.0.0.0",
      PORT: "3000",
      CLASSIFIER_MODEL: "anthropic:claude-haiku-4-5",
      ANSWER_MODEL: " anthropic:claude-opus-5-5 ",
      CONTEXTS_PATH: "config/contexts.md",
      PROFILE_SOURCE: "file:/secrets/profile.md",
      GOOGLE_CLOUD_PROJECT: "jarvis-prod",
      ANTHROPIC_SECRET_NAME: "claude-key",
      VENDUS_SECRET_NAME: "vendus-api-key",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      models: { answer: { provider: "anthropic", model: "claude-opus-5-5" } },
      contextsPath: "config/contexts.md",
      profileSource: { kind: "file", path: "/secrets/profile.md" },
      secrets: { gcpProject: "jarvis-prod", anthropicSecretName: "claude-key", vendusSecretName: "vendus-api-key" },
    });
  });

  it("accepts another IANA time zone", () => {
    expect(loadOk({ TIMEZONE: "Europe/Madrid" }).timeZone).toBe("Europe/Madrid");
  });

  it("treats empty values as unset", () => {
    expect(loadOk({ PORT: "", HOST: " ", NODE_ENV: "" })).toMatchObject({
      env: "development",
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it("listens on all interfaces in production and needs a GCP project there", () => {
    expect(loadErr({ NODE_ENV: "production" })).toBe(
      "GOOGLE_CLOUD_PROJECT: required in production (secrets come from Secret Manager)",
    );
    expect(loadOk({ NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p" })).toMatchObject({
      env: "production",
      host: "0.0.0.0",
    });
  });

  it.each([
    ["PORT", { PORT: "abc" }],
    ["PORT", { PORT: "0" }],
    ["PORT", { PORT: "70000" }],
    ["PORT", { PORT: "80.5" }],
    ["NODE_ENV", { NODE_ENV: "staging" }],
    ["CLASSIFIER_MODEL", { CLASSIFIER_MODEL: "claude-haiku-5-5" }],
    ["ANSWER_MODEL", { ANSWER_MODEL: "openai:gpt-5" }],
    ["PROFILE_SOURCE", { PROFILE_SOURCE: "gs://bucket/profile.md" }],
    ["PROFILE_SOURCE", { PROFILE_SOURCE: "file:" }],
    ["TIMEZONE", { TIMEZONE: "Mars/Olympus_Mons" }],
  ])("rejects a bad %s", (name, env) => {
    expect(loadErr(env)).toMatch(new RegExp(`^${name}: `));
  });

  it("reports every problem at once", () => {
    const error = loadErr({
      NODE_ENV: "production",
      PORT: "abc",
      ANSWER_MODEL: "openai:gpt-5",
      PROFILE_SOURCE: "s3://x",
    });
    const lines = error.split("\n").map((l) => l.split(":")[0]);
    expect(lines.sort()).toEqual(["ANSWER_MODEL", "GOOGLE_CLOUD_PROJECT", "PORT", "PROFILE_SOURCE"]);
    expect(error).toContain("PORT: must be a whole number from 1 to 65535");
  });

  it("never reads secret values", () => {
    const config = loadOk({ ANTHROPIC_API_KEY: "sk-ant-should-not-appear" });
    expect(JSON.stringify(config)).not.toContain("sk-ant");
  });
});

describe("parseModelRef", () => {
  it("parses and formats provider:model", () => {
    const ref = parseModelRef("anthropic:claude-sonnet-5-5");
    expect(ref).toEqual({ ok: true, value: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    expect(ref.ok && formatModelRef(ref.value)).toBe("anthropic:claude-sonnet-5-5");
  });

  it.each([
    ["claude-sonnet-5-5", 'expected "provider:model"'],
    ["anthropic:", 'expected "provider:model"'],
    [":claude", 'expected "provider:model"'],
    ["gemini:gemini-pro", 'unknown provider "gemini"'],
    ["anthropic:claude sonnet", "can't contain spaces"],
  ])("rejects %s", (value, message) => {
    const result = parseModelRef(value);
    expect(!result.ok && result.error).toContain(message);
  });
});

describe("parseProfileSource", () => {
  it("accepts file paths", () => {
    expect(parseProfileSource("file:data/profile.md")).toEqual({
      ok: true,
      value: { kind: "file", path: "data/profile.md" },
    });
  });

  it("rejects other schemes", () => {
    const result = parseProfileSource("secret:profile");
    expect(!result.ok && result.error).toContain("unknown scheme");
  });
});
