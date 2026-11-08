import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseLocalUrl } from "../src/local-url.js";
import { isKokoroVoiceFor, kokoroVoiceLabel, makeKokoroTts } from "../src/tts/kokoro.js";
import { alignPcm16, parseWavHeader } from "../src/tts/pcm.js";
import { isPiperVoiceFor, makePiperTts } from "../src/tts/piper.js";
import type { TtsAudio } from "../src/tts/types.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A fake local service on 127.0.0.1, on a free port. */
const fakeService = async (handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<URL> => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
};

const collect = async (audio: TtsAudio) => {
  const parts: Uint8Array[] = [];
  for await (const c of audio.chunks) parts.push(c);
  return parts;
};
const total = (parts: Uint8Array[]) => parts.reduce((n, p) => n + p.length, 0);

/** n samples of 16-bit PCM: 0, 1, 2, … */
const pcm = (n: number) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(i, i * 2);
  return b;
};

const wav = (samples: Buffer, sampleRate = 22050, extraChunk = true) => {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.from("LIST\u0004\u0000\u0000\u0000INFO", "latin1");
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0);
  dataHead.writeUInt32LE(samples.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, ...(extraChunk ? [list] : []), dataHead, samples]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
};

describe("parseLocalUrl (local services only)", () => {
  it.each(["http://127.0.0.1:8880", "http://localhost:5001/", "http://[::1]:8178"])("accepts %s", (u) => expect(parseLocalUrl(u).ok).toBe(true));
  it.each(["http://192.168.1.2:8880", "http://example.com", "https://127.0.0.1:8880", "http://a:b@127.0.0.1:1", "nope", "http://127.0.0.1.evil.com"])(
    "refuses %s",
    (u) => expect(parseLocalUrl(u).ok).toBe(false),
  );
});

describe("PCM helpers", () => {
  it("re-chunks into whole 16-bit samples", async () => {
    const out: number[] = [];
    for await (const c of alignPcm16((async function* () {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4]);
      yield new Uint8Array([5, 6, 7]);
    })())) out.push(c.length);
    expect(out).toEqual([2, 2, 2]); // the last odd byte is dropped
  });

  it("reads a WAV header, skipping other chunks, and asks for more when it's cut", () => {
    const file = new Uint8Array(wav(pcm(4)));
    expect(parseWavHeader(file)).toEqual({ channels: 1, sampleRate: 22050, bitsPerSample: 16, dataOffset: file.length - 8 });
    expect(parseWavHeader(file.subarray(0, 30))).toBe("more");
    expect(parseWavHeader(new TextEncoder().encode("ID3 not a wav at all"))).toEqual({ error: "not a WAV file" });
  });
});

describe("Kokoro provider", () => {
  it("lists only the language's voices, labelled", async () => {
    const base = await fakeService((req, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ voices: [{ id: "bm_george" }, { id: "af_heart" }, { id: "ef_dora" }, { id: "jf_alpha" }, { id: "pm_alex" }], default_voice: "af_heart" }));
    });
    const voices = await makeKokoroTts({ baseUrl: base }).listVoices("en");
    expect(voices).toEqual({
      ok: true,
      value: [
        { id: "af_heart", label: "af_heart (American, female)" },
        { id: "bm_george", label: "bm_george (British, male)" },
      ],
    });
  });

  it("streams PCM for a sentence, in whole samples, asking for raw streamed PCM", async () => {
    let request: Record<string, unknown> = {};
    const base = await fakeService((req, body, res) => {
      request = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "audio/pcm" });
      const audio = pcm(1000);
      res.write(audio.subarray(0, 3)); // an odd split
      setTimeout(() => res.end(audio.subarray(3)), 10);
    });
    const result = await makeKokoroTts({ baseUrl: base }).speak({ text: "Hello there.", language: "en", voice: "bm_george" });
    expect(result.ok && result.value.sampleRate).toBe(24000);
    const parts = result.ok ? await collect(result.value) : [];
    expect(total(parts)).toBe(2000);
    expect(parts.every((p) => p.length % 2 === 0)).toBe(true);
    expect(request).toEqual({ model: "kokoro", input: "Hello there.", voice: "bm_george", response_format: "pcm", stream: true, speed: 1 });
  });

  it("refuses a voice from another language before calling, and reports a service that's down", async () => {
    const tts = makeKokoroTts({ baseUrl: new URL("http://127.0.0.1:9") });
    expect(await tts.speak({ text: "x", language: "en", voice: "ef_dora" })).toMatchObject({ ok: false, error: { kind: "bad_voice" } });
    expect(await tts.speak({ text: "x", language: "en", voice: "bm_george" })).toMatchObject({
      ok: false,
      error: { kind: "unavailable", message: "Kokoro isn't running at http://127.0.0.1:9 (npm run voice:up)" },
    });
    expect(await tts.listVoices("en")).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  });

  it("maps Kokoro's errors", async () => {
    const base = await fakeService((_req, _b, res) => {
      res.statusCode = 400;
      res.end("{}");
    });
    expect(await makeKokoroTts({ baseUrl: base }).speak({ text: "x", language: "en", voice: "bm_nobody" })).toMatchObject({ ok: false, error: { kind: "bad_voice" } });
  });

  it("knows its voice names", () => {
    expect(isKokoroVoiceFor("bf_emma", "en")).toBe(true);
    expect(isKokoroVoiceFor("pf_dora", "en")).toBe(false);
    expect(isKokoroVoiceFor("../etc/passwd", "en")).toBe(false);
    expect(kokoroVoiceLabel("am_michael")).toBe("am_michael (American, male)");
  });
});

describe("Piper provider", () => {
  it("lists only the language's installed voices", async () => {
    const base = await fakeService((_req, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ "en_US-lessac-medium": {}, "en_GB-alan-medium": {}, "pt_PT-tugão-medium": {}, "de_DE-thorsten-high": {} }));
    });
    expect(await makePiperTts({ baseUrl: base }).listVoices("en")).toEqual({
      ok: true,
      value: [
        { id: "en_GB-alan-medium", label: "en_GB-alan-medium" },
        { id: "en_US-lessac-medium", label: "en_US-lessac-medium" },
      ],
    });
  });

  it("reads the WAV header, even split across chunks, and streams the PCM after it", async () => {
    let request: Record<string, unknown> = {};
    const base = await fakeService((_req, body, res) => {
      request = JSON.parse(body) as Record<string, unknown>;
      const file = wav(pcm(500), 22050);
      res.writeHead(200, { "content-type": "audio/wav" });
      res.write(file.subarray(0, 20)); // the header arrives in pieces
      setTimeout(() => res.write(file.subarray(20, 51)), 5);
      setTimeout(() => res.end(file.subarray(51)), 10);
    });
    const result = await makePiperTts({ baseUrl: base }).speak({ text: "Hello there.", language: "en", voice: "en_GB-alan-medium" });
    expect(result.ok && result.value.sampleRate).toBe(22050);
    const parts = result.ok ? await collect(result.value) : [];
    expect(total(parts)).toBe(1000);
    expect(Buffer.concat(parts).readInt16LE(998)).toBe(499);
    expect(request).toEqual({ text: "Hello there.", voice: "en_GB-alan-medium" });
  });

  it("refuses non-PCM or stereo audio, other languages, and a service that's down", async () => {
    const stereo = wav(pcm(10));
    stereo.writeUInt16LE(2, 22); // channels = 2
    const base = await fakeService((_req, _b, res) => res.end(stereo));
    expect(await makePiperTts({ baseUrl: base }).speak({ text: "x", language: "en", voice: "en_GB-alan-medium" })).toMatchObject({
      ok: false,
      error: { kind: "failed", message: "Piper sent expected 16-bit mono audio" },
    });
    const down = makePiperTts({ baseUrl: new URL("http://127.0.0.1:9") });
    expect(await down.speak({ text: "x", language: "en", voice: "de_DE-thorsten-high" })).toMatchObject({ ok: false, error: { kind: "bad_voice" } });
    expect(await down.speak({ text: "x", language: "en", voice: "en_GB-alan-medium" })).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    expect(isPiperVoiceFor("en_US-lessac-high", "en")).toBe(true);
    expect(isPiperVoiceFor("en_US-../../x-high", "en")).toBe(false);
  });
});
