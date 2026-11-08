import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import { localHosts, makeServer } from "../src/server.js";
import { browserTts, type TtsProviders } from "../src/tts/registry.js";
import type { TtsProvider } from "../src/tts/types.js";
import type { Context, Deps } from "../src/types.js";

let contexts: readonly Context[] = [];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

const SECRET_TEXT = "Your passport expires on the 10th of January.";

const setup = (over: { kokoro?: Partial<TtsProvider>; voice?: string } = {}) => {
  const lines: string[] = [];
  const spoken: { text: string; voice: string; signal?: AbortSignal }[] = [];
  let cancelled = false;
  const kokoro: TtsProvider = {
    id: "kokoro",
    listVoices: async () => ok([{ id: "bm_george", label: "bm_george (British, male)" }]),
    speak: async ({ text, voice }, signal) => {
      spoken.push({ text, voice, ...(signal ? { signal } : {}) });
      return ok({
        format: "pcm_s16le",
        sampleRate: 24000,
        channels: 1,
        chunks: (async function* () {
          try {
            yield new Uint8Array(4800);
            yield new Uint8Array(4800);
          } finally {
            cancelled = signal?.aborted ?? false;
          }
        })(),
      });
    },
    ...over.kokoro,
  };
  const piper: TtsProvider = {
    id: "piper",
    listVoices: async () => err({ kind: "unavailable", message: "Piper isn't running at http://127.0.0.1:5001 (npm run voice:up)" }),
    speak: async () => err({ kind: "unavailable", message: "Piper isn't running" }),
  };
  const providers: TtsProviders = { kokoro, piper, browser: browserTts };
  const deps = {
    contexts,
    precheck: makePrecheck(contexts),
    log: makeJsonLogger({ write: (l) => lines.push(l) }),
  } as unknown as Deps;
  const app = makeServer(deps, {
    allowedHosts: localHosts(8080),
    tts: {
      providers,
      config: { provider: "kokoro", voice: over.voice ?? "bm_george", kokoroUrl: new URL("http://127.0.0.1:8880"), piperUrl: new URL("http://127.0.0.1:5001") },
    },
  });
  const speak = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/speak", {
      method: "POST",
      headers: { host: "127.0.0.1:8080", "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, speak, spoken, lines, wasCancelled: () => cancelled };
};

describe("GET /tts", () => {
  it("lists the configured voice and each provider's voices, saying which aren't running", async () => {
    const { app } = setup();
    const res = await app.request("/tts", { headers: { host: "127.0.0.1:8080" } });
    expect(await res.json()).toEqual({
      language: "en",
      provider: "kokoro",
      voice: "bm_george",
      providers: [
        { id: "kokoro", available: true, voices: [{ id: "bm_george", label: "bm_george (British, male)" }] },
        { id: "piper", available: false, voices: [], problem: "Piper isn't running at http://127.0.0.1:5001 (npm run voice:up)" },
        { id: "browser", available: true, voices: [] },
      ],
    });
  });
});

describe("POST /speak", () => {
  it("streams the configured voice's PCM with its format headers", async () => {
    const { speak, spoken } = setup();
    const res = await speak({ text: SECRET_TEXT });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-audio-format")).toBe("pcm_s16le");
    expect(res.headers.get("x-sample-rate")).toBe("24000");
    expect(res.headers.get("x-channels")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(9600);
    expect(spoken[0]).toMatchObject({ text: SECRET_TEXT, voice: "bm_george" });
  });

  it("lets /voices pick any provider and voice", async () => {
    const { speak, spoken } = setup();
    await (await speak({ text: "Hi.", provider: "kokoro", voice: "af_heart" })).arrayBuffer();
    expect(spoken[0]?.voice).toBe("af_heart");
  });

  it.each([
    [{ text: "" }, 400],
    [{ text: "x".repeat(1001) }, 400],
    [{ text: "Hi.", voice: "../../etc" }, 400],
    [{ text: "Hi.", provider: "elevenlabs" }, 400],
    [{ text: "Hi.", extra: true }, 400],
    [{ text: "Hi.", provider: "piper", voice: "en_GB-alan-medium" }, 503],
  ])("refuses %j with %i", async (body, status) => {
    const { speak } = setup();
    expect((await speak(body)).status).toBe(status);
  });

  it("refuses non-JSON and other hosts, like /ask", async () => {
    const { speak } = setup();
    expect((await speak("text=hi", { "content-type": "text/plain" })).status).toBe(415);
    expect((await speak({ text: "Hi." }, { host: "evil.example:8080" })).status).toBe(403);
  });

  it("says when no voice is configured, and that the browser voice plays in the page", async () => {
    expect((await setup({ voice: "" }).speak({ text: "Hi." })).status).toBe(400);
    const { app } = setup();
    expect(await (await app.request("/speak", { method: "POST", headers: { host: "127.0.0.1:8080", "content-type": "application/json" }, body: "{" })).json()).toMatchObject({ type: "error" });
  });

  it("cancels the synthesis when the page stops listening (barge-in)", async () => {
    const { speak, spoken, wasCancelled } = setup();
    const res = await speak({ text: SECRET_TEXT });
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(spoken[0]?.signal?.aborted).toBe(true);
    expect(wasCancelled()).toBe(true);
  });

  it("logs provider, voice, length and timings, never the text", async () => {
    const { speak, lines } = setup();
    await (await speak({ text: SECRET_TEXT })).arrayBuffer();
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "speak");
    expect(line).toMatchObject({ provider: "kokoro", voice: "bm_george", chars: SECRET_TEXT.length, outcome: "done", bytes: 9600 });
    expect(typeof line?.firstByteMs).toBe("number");
    expect(lines.join("\n")).not.toContain("passport");
  });
});
