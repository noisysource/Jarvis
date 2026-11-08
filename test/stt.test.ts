import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildWhisperPrompt, MAX_HINTS, MAX_PROMPT_CHARS, makeWhisperHints, parseHintsFile, profileNames } from "../src/stt/hints.js";
import { makeSttProvider } from "../src/stt/registry.js";
import { checkSpeechWav, MAX_WAV_BYTES } from "../src/stt/wav.js";
import { cleanTranscript, makeWhisperStt } from "../src/stt/whisper.js";
import { encodeWav } from "../src/web/mic-lib.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A stand-in whisper.cpp server on 127.0.0.1, on a free port. */
const fakeWhisper = async (handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void): Promise<URL> => {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => handler(req, Buffer.concat(parts), res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
};

const speech = (seconds = 1) => encodeWav(new Float32Array(16000 * seconds).map((_, i) => Math.sin(i / 8) * 0.3));

describe("whisper.cpp provider", () => {
  it("uploads the WAV to /inference as a multipart form, in the given language, and cleans the text", async () => {
    let seen: { url?: string; type?: string; body?: Buffer } = {};
    const base = await fakeWhisper((req, body, res) => {
      seen = { url: req.url ?? "", type: req.headers["content-type"] ?? "", body };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: " What's on my plate\n today? [BLANK_AUDIO]\n" }));
    });
    const wav = speech();
    const result = await makeWhisperStt({ baseUrl: base }).transcribe({ wav, language: "en" });
    expect(result).toEqual({ ok: true, value: { text: "What's on my plate today?" } });
    expect(seen.url).toBe("/inference");
    expect(seen.type).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(new Uint8Array(seen.body ?? Buffer.alloc(0)), { headers: { "content-type": seen.type ?? "" } }).formData();
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav);
    expect(form.get("language")).toBe("en");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
  });

  it("reports a service that's down, starting (voice:up waiting, or loading its model) or failing", async () => {
    const down = makeWhisperStt({ baseUrl: new URL("http://127.0.0.1:9") });
    expect(await down.transcribe({ wav: speech(), language: "en" })).toEqual({
      ok: false,
      error: { kind: "unavailable", message: "Whisper isn't running at http://127.0.0.1:9 (npm run voice:up)" },
    });
    expect(await down.status()).toMatchObject({ ok: false, error: { kind: "unavailable" } });

    const waiting = makeSttProvider({ provider: "whisper", whisperUrl: new URL("http://127.0.0.1:9"), hintsPath: "data/whisper-hints.txt" }, { isStarting: async (s) => s === "whisper" });
    expect(await waiting.status()).toEqual({ ok: false, error: { kind: "starting", message: "Whisper is starting (loading its model)" } });

    const loading = await fakeWhisper((req, _b, res) => {
      res.statusCode = 503;
      res.end(JSON.stringify({ status: "loading model" }));
    });
    const w = makeWhisperStt({ baseUrl: loading });
    expect(await w.status()).toMatchObject({ ok: false, error: { kind: "starting" } });
    expect(await w.transcribe({ wav: speech(), language: "en" })).toMatchObject({ ok: false, error: { kind: "starting" } });

    const broken = await fakeWhisper((_req, _b, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    expect(await makeWhisperStt({ baseUrl: broken }).transcribe({ wav: speech(), language: "en" })).toEqual({
      ok: false,
      error: { kind: "failed", message: "Whisper answered 500" },
    });
    const noText = await fakeWhisper((_req, _b, res) => res.end(JSON.stringify({ error: "x" })));
    expect(await makeWhisperStt({ baseUrl: noText }).transcribe({ wav: speech(), language: "en" })).toMatchObject({ ok: false, error: { kind: "failed" } });
  });

  it("is ready when /health says ok", async () => {
    const base = await fakeWhisper((req, _b, res) => res.end(req.url === "/health" ? '{"status":"ok"}' : ""));
    expect(await makeWhisperStt({ baseUrl: base }).status()).toEqual({ ok: true, value: true });
  });

  it("cancels the request when asked", async () => {
    const base = await fakeWhisper(() => undefined); // never answers
    const controller = new AbortController();
    const pending = makeWhisperStt({ baseUrl: base }).transcribe({ wav: speech(), language: "en" }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted", message: "Cancelled" } });
  });

  it("cleans Whisper's text", () => {
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript(" (silence) ")).toBe("");
    expect(cleanTranscript(" Remember that\n the boiler is serviced in March. [Music]")).toBe("Remember that the boiler is serviced in March.");
    expect(cleanTranscript("I said (quietly) hello")).toBe("I said (quietly) hello");
  });
});

describe("Whisper name hints (#83)", () => {
  const PROFILE = [
    "# My profile",
    "## About me",
    "- Name: Alex Example",
    "- Lives in: Lisbon",
    "## Family",
    "- Partner: Sam, works as an architect",
    "- Daughter: Inês, born 2 September 2017",
    "- Mother: Teresa (lives in Porto)",
    "## Work",
    "- Runs: Example Corp, a consultancy",
  ].join("\n");

  it("takes your name and the Family section's names from the profile", () => {
    expect(profileNames(PROFILE)).toEqual(["Alex Example", "Sam", "Inês", "Teresa"]);
    expect(profileNames("no headings here\n- Partner: Sam")).toEqual([]);
  });

  it("reads one hint per line, skipping comments, and builds a capped, deduplicated prompt", () => {
    expect(parseHintsFile("# a comment\nExampleville\n\n  Example Corp  \n")).toEqual(["Exampleville", "Example Corp"]);
    expect(buildWhisperPrompt(["Inês", "inês", "Exampleville", " "])).toBe("Inês, Exampleville.");
    expect(buildWhisperPrompt([])).toBe("");
    const many = Array.from({ length: 100 }, (_, i) => `Name${i}`);
    expect(buildWhisperPrompt(many).split(", ")).toHaveLength(MAX_HINTS);
    expect(buildWhisperPrompt(Array.from({ length: 30 }, (_, i) => `${"x".repeat(50)}${i}`)).length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("combines profile and file, and a missing file or profile is fine", async () => {
    const both = makeWhisperHints({ readProfile: async () => PROFILE, readHintsFile: async () => "Exampleville\nSam\n" });
    expect(await both()).toEqual({ prompt: "Alex Example, Sam, Inês, Teresa, Exampleville.", count: 5 });
    const none = makeWhisperHints({ readProfile: async () => undefined, readHintsFile: async () => Promise.reject(new Error("ENOENT")) });
    expect(await none()).toEqual({ prompt: "", count: 0 });
  });

  it("sends them to Whisper as its prompt", async () => {
    let prompt: string | File | null = null;
    const base = await fakeWhisper(async (req, body, res) => {
      const form = await new Response(new Uint8Array(body), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      prompt = form.get("prompt");
      res.end(JSON.stringify({ text: "Inês" }));
    });
    const withHints = makeWhisperStt({ baseUrl: base, hints: async () => ({ prompt: "Inês, Exampleville." }) });
    await withHints.transcribe({ wav: speech(), language: "en" });
    expect(prompt).toBe("Inês, Exampleville.");
    await makeWhisperStt({ baseUrl: base, hints: async () => ({ prompt: "" }) }).transcribe({ wav: speech(), language: "en" });
    expect(prompt).toBeNull(); // no hints, no prompt field
  });
});

describe("checkSpeechWav", () => {
  it("accepts 16 kHz mono 16-bit WAV and measures it", () => {
    expect(checkSpeechWav(speech(2))).toEqual({ ok: true, value: { audioMs: 2000 } });
  });

  it("refuses anything else", () => {
    const wrongRate = encodeWav(new Float32Array(100), 44100);
    expect(checkSpeechWav(wrongRate)).toEqual({ ok: false, error: "Send 16 kHz mono 16-bit WAV." });
    const stereo = speech();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(checkSpeechWav(stereo).ok).toBe(false);
    expect(checkSpeechWav(new TextEncoder().encode("not audio at all")).ok).toBe(false);
    expect(checkSpeechWav(new Uint8Array(4))).toEqual({ ok: false, error: "The audio is incomplete." });
    expect(checkSpeechWav(encodeWav(new Float32Array(0)))).toEqual({ ok: false, error: "The audio is empty." });
    expect(MAX_WAV_BYTES).toBe(2 * 1024 * 1024);
  });
});
