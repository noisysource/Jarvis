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
        local: { provider: "ollama", model: "qwen3:8b" },
      },
      ollamaUrl: new URL("http://127.0.0.1:11434"),
      bareMode: false,
      bareProfile: false,
      calendar: { enabled: false, write: false, clientPath: "data/google-oauth-client.json", tokensPath: "data/google-tokens.json" },
      toolCalling: true,
      gmail: { enabled: false, write: false, tokensPath: expect.any(Function) },
      github: { enabled: false, tokensPath: "data/github-tokens.json" },
      bareMemory: false,
      introspection: false,
      ollamaThink: false,
      userName: undefined,
      contextsPath: "contexts.md",
      profileSource: { kind: "file", path: "data/profile.md" },
      timeZone: "Europe/Lisbon",
      memoryStore: { kind: "sqlite", path: "data/memory.sqlite" },
      neverRememberPath: "data/never-remember.txt",
      tts: {
        provider: "browser",
        voice: "",
        kokoroUrl: new URL("http://127.0.0.1:8880"),
        piperUrl: new URL("http://127.0.0.1:5001"),
      },
      stt: { provider: "whisper", whisperUrl: new URL("http://127.0.0.1:8178"), hintsPath: "data/whisper-hints.txt" },
      turn: {
        endOfTurnMs: 500,
        bargeIn: { chrome: "strict", safari: "strict", other: "vad" },
        spokenThinking: "off",
        classifierThinking: "off",
        stickyContext: false,
        speculativeAnswer: false,
        firstChunkChars: 60,
        spokenSentences: 2,
        punctuationStyle: false,
      },
      secrets: { gcpProject: undefined, anthropicSecretName: "anthropic-api-key", vendusSecretName: undefined },
    });
  });

  it("chooses Jarvis's voice, with its services on this machine only", () => {
    expect(loadOk({ TTS_PROVIDER: "kokoro", TTS_VOICE: "bm_george", KOKORO_URL: "http://localhost:9000" }).tts).toMatchObject({
      provider: "kokoro",
      voice: "bm_george",
      kokoroUrl: new URL("http://localhost:9000"),
    });
    for (const [name, value] of [
      ["KOKORO_URL", "http://192.168.1.20:8880"],
      ["PIPER_URL", "https://example.com/tts"],
      ["KOKORO_URL", "http://user:pw@127.0.0.1:8880"],
      ["PIPER_URL", "not a url"],
    ] as const) {
      const bad = loadConfig({ [name]: value });
      expect(!bad.ok && bad.error, `${name}=${value}`).toContain(`${name}: `);
    }
    expect(!loadConfig({ TTS_PROVIDER: "elevenlabs" }).ok).toBe(true);
  });

  it("sets the end of turn and barge-in per browser (#75)", () => {
    expect(loadOk({ VOICE_END_OF_TURN_MS: "700", BARGE_IN_SAFARI: "push" }).turn).toMatchObject({
      endOfTurnMs: 700,
      bargeIn: { chrome: "strict", safari: "push", other: "vad" },
    });
    expect(
      loadOk({ VOICE_THINKING: "on", CLASSIFIER_THINKING: "on", STICKY_CONTEXT: "on", VOICE_FIRST_CHUNK_CHARS: "90", VOICE_MAX_SENTENCES: "3", VOICE_PUNCTUATION_STYLE: "on" }).turn,
    ).toMatchObject({ spokenThinking: "on", classifierThinking: "on", stickyContext: true, firstChunkChars: 90, spokenSentences: 3, punctuationStyle: true });
    for (const [name, value] of [
      ["VOICE_END_OF_TURN_MS", "100"],
      ["VOICE_END_OF_TURN_MS", "half a second"],
      ["BARGE_IN_CHROME", "always"],
      ["STICKY_CONTEXT", "yes"],
      ["VOICE_FIRST_CHUNK_CHARS", "10"],
      ["VOICE_MAX_SENTENCES", "0"],
      ["VOICE_MAX_SENTENCES", "eleven"],
      ["VOICE_PUNCTUATION_STYLE", "yes"],
    ] as const) {
      const bad = loadConfig({ [name]: value });
      expect(!bad.ok && bad.error, `${name}=${value}`).toContain(`${name}: `);
    }
  });

  it("reads the calendar only locally and in bare mode, with its files under data/ (#100)", () => {
    expect(loadOk({ CALENDAR: "on", BARE_MODE: "on" }).calendar).toEqual({
      enabled: true,
      write: false,
      clientPath: "data/google-oauth-client.json",
      tokensPath: "data/google-tokens.json",
    });
    const noBare = loadConfig({ CALENDAR: "on" });
    expect(!noBare.ok && noBare.error).toContain("CALENDAR: needs BARE_MODE=on for now");
    const production = loadConfig({ CALENDAR: "on", BARE_MODE: "on", NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: "p" });
    expect(!production.ok && production.error).toContain("CALENDAR: local only for now");
    const bad = loadConfig({ CALENDAR: "yes" });
    expect(!bad.ok && bad.error).toContain("CALENDAR: ");
  });

  it("CALENDAR_WRITE=on lets Claude propose events; it needs the calendar on (Reach 2)", () => {
    expect(loadOk({ CALENDAR: "on", CALENDAR_WRITE: "on", BARE_MODE: "on" }).calendar.write).toBe(true);
    const alone = loadConfig({ CALENDAR_WRITE: "on" });
    expect(!alone.ok && alone.error).toContain("CALENDAR_WRITE: needs CALENDAR=on");
  });

  it("runs the local brain on Ollama on this machine only (#88)", () => {
    const c = loadOk({ OLLAMA_MODEL: "qwen3:8b", OLLAMA_URL: "http://localhost:11500", BARE_MODE: "on", PROFILE: "on", JARVIS_USER_NAME: "Alex" });
    expect(c.models.local).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(c.ollamaUrl).toEqual(new URL("http://localhost:11500"));
    expect(c.bareMode).toBe(true);
    expect(c.bareProfile).toBe(true); // the profile back in bare mode (#98)
    expect(c.userName).toBe("Alex");
    for (const [name, value] of [
      ["OLLAMA_URL", "http://192.168.1.5:11434"],
      ["OLLAMA_URL", "https://ollama.example.com"],
      ["OLLAMA_MODEL", "llama 3"],
      ["BARE_MODE", "yes"],
      ["PROFILE", "yes"],
      ["JARVIS_USER_NAME", "<script>"],
    ] as const) {
      const bad = loadConfig({ [name]: value });
      expect(!bad.ok && bad.error, `${name}=${value}`).toContain(`${name}: `);
    }
  });

  it("listens through Whisper on this machine only (#74)", () => {
    expect(loadOk({ WHISPER_URL: "http://localhost:9178" }).stt).toEqual({
      provider: "whisper",
      whisperUrl: new URL("http://localhost:9178"),
      hintsPath: "data/whisper-hints.txt",
    });
    for (const value of ["http://10.0.0.5:8178", "https://api.openai.com/v1/audio", "http://a:b@127.0.0.1:8178"]) {
      const bad = loadConfig({ WHISPER_URL: value });
      expect(!bad.ok && bad.error, value).toContain("WHISPER_URL: ");
    }
    expect(!loadConfig({ STT_PROVIDER: "google" }).ok).toBe(true);
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
