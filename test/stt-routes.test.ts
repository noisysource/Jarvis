import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { makeBackgroundTasks } from "../src/background.js";
import { parseContexts } from "../src/contexts.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import { localHosts, makeServer } from "../src/server.js";
import type { SttProvider } from "../src/stt/types.js";
import { MAX_WAV_BYTES } from "../src/stt/wav.js";
import type { Context, ContextId, Deps } from "../src/types.js";
import { encodeWav } from "../src/web/mic-lib.js";

let contexts: readonly Context[] = [];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

const SAID = "Remember that my passport number ends in 4471.";
const EC_SAID = "Summarise the UTP standup for me.";
const HOST = { host: "127.0.0.1:8080" };
const wav = (seconds = 1) => encodeWav(new Float32Array(16000 * seconds).map((_, i) => Math.sin(i / 7) * 0.25));

const setup = (over: { stt?: Partial<SttProvider>; transcript?: string } = {}) => {
  const lines: string[] = [];
  const calls: string[] = [];
  const heard: { bytes: number; language: string }[] = [];
  const stt: SttProvider = {
    id: "whisper",
    status: async () => ok(true),
    transcribe: async ({ wav: audio, language }) => {
      heard.push({ bytes: audio.length, language });
      return ok({ text: over.transcript ?? SAID });
    },
    ...over.stt,
  };
  const log = makeJsonLogger({ write: (l) => lines.push(l) });
  const background = makeBackgroundTasks({ log });
  const deps: Deps = {
    contexts,
    precheck: makePrecheck(contexts),
    classify: async () => {
      calls.push("classify");
      return { kind: "context", contextId: "personal" as ContextId };
    },
    answer: async () => {
      calls.push("answer");
      return ok({ kind: "answer", text: "Noted." });
    },
    memory: {
      loadMemories: async () => {
        calls.push("loadMemories");
        return [];
      },
      wrapUp: async () => {
        calls.push("wrapUp");
      },
    },
    isAnswered: () => true,
    afterReply: background.run,
    now: () => new Date("2026-11-08T15:00:00Z"),
    log,
  };
  const app = makeServer(deps, { allowedHosts: localHosts(8080), stt });
  const transcribe = (body: Uint8Array | string, headers: Record<string, string> = {}, query = "") =>
    app.request(`/transcribe${query}`, {
      method: "POST",
      headers: { ...HOST, "content-type": "audio/wav", ...headers },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
  return { app, transcribe, lines, calls, heard, background };
};

describe("POST /transcribe (#74)", () => {
  it("returns the text of a 16 kHz mono WAV, and logs only sizes and timings", async () => {
    const { transcribe, lines, heard } = setup();
    const audio = wav(2);
    const res = await transcribe(audio, {}, "?language=en");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ text: SAID });
    expect(heard).toEqual([{ bytes: audio.length, language: "en" }]);
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "transcribe");
    expect(line).toMatchObject({ provider: "whisper", bytes: audio.length, audioMs: 2000, empty: false });
    expect(typeof line?.transcribeMs).toBe("number");
    // Never the transcript, nor any part of it.
    expect(lines.join("\n")).not.toContain("passport");
    expect(lines.join("\n")).not.toContain("4471");
  });

  it("accepts only audio/wav, so a cross-site form can't post here without a preflight", async () => {
    const { app, transcribe, heard } = setup();
    for (const type of ["text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "audio/webm"]) {
      const res = await transcribe(wav(), { "content-type": type });
      expect(res.status, type).toBe(415);
    }
    // The preflight a browser would send first gets no CORS approval.
    const preflight = await app.request("/transcribe", {
      method: "OPTIONS",
      headers: { ...HOST, origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(heard).toEqual([]);
  });

  it("is behind the Host guard", async () => {
    const { transcribe, heard } = setup();
    expect((await transcribe(wav(), { host: "evil.example:8080" })).status).toBe(403);
    expect(heard).toEqual([]);
  });

  it("refuses audio that's too long, the wrong format, or another language, before calling Whisper", async () => {
    const { transcribe, heard } = setup();
    expect((await transcribe(new Uint8Array(MAX_WAV_BYTES + 1))).status).toBe(413);
    expect((await transcribe(encodeWav(new Float32Array(4410), 44100))).status).toBe(400);
    expect((await transcribe("hello")).status).toBe(400);
    const pt = await transcribe(wav(), {}, "?language=pt");
    expect(pt.status).toBe(400);
    expect(await pt.json()).toEqual({ type: "error", message: 'Listening is set up for "en" only.' });
    expect(heard).toEqual([]);
  });

  it("says when Whisper isn't running or is starting", async () => {
    const down = setup({ stt: { transcribe: async () => err({ kind: "unavailable", message: "Whisper isn't running at http://127.0.0.1:8178 (npm run voice:up)" }) } });
    const res = await down.transcribe(wav());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ type: "error", message: "Whisper isn't running at http://127.0.0.1:8178 (npm run voice:up)" });
    const starting = setup({ stt: { transcribe: async () => err({ kind: "starting", message: "Whisper is starting (loading its model)" }) } });
    expect((await starting.transcribe(wav())).status).toBe(503);
  });
});

describe("GET /stt (#74)", () => {
  it("says whether listening works right now", async () => {
    const up = setup();
    expect(await (await up.app.request("/stt", { headers: HOST })).json()).toEqual({ provider: "whisper", language: "en", available: true });
    const starting = setup({ stt: { status: async () => err({ kind: "starting", message: "Whisper is starting (loading its model)" }) } });
    expect(await (await starting.app.request("/stt", { headers: HOST })).json()).toEqual({
      provider: "whisper",
      language: "en",
      available: false,
      problem: "Whisper is starting (loading its model)",
      starting: true,
    });
  });
});

describe("a spoken EC question (#74)", () => {
  it("is handed to Kiro by the local precheck, reaching no model and no memory", async () => {
    const { transcribe, app, calls, lines, background } = setup({ transcript: EC_SAID });
    const heard = (await (await transcribe(wav())).json()) as { text: string };
    expect(heard.text).toBe(EC_SAID);
    // The page sends the transcript to /ask like typed text, even with a context picked.
    for (const context of [undefined, "personal"]) {
      const res = await app.request("/ask", {
        method: "POST",
        headers: { ...HOST, "content-type": "application/json" },
        body: JSON.stringify({ question: heard.text, ...(context ? { context } : {}) }),
      });
      expect(await res.json()).toMatchObject({ type: "handoff", context: "ec-hrt" });
    }
    await background.drain();
    expect(calls).toEqual([]); // no classifier, no answer model, no memories loaded, no wrap-up
    expect(lines.join("\n")).not.toContain("UTP");
  });
});
