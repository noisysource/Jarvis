import { describe, expect, it } from "vitest";
import { checkSpeechWav } from "../src/stt/wav.js";
import { parseWavHeader } from "../src/tts/pcm.js";
import { downsample, ENDPOINT, encodeWav, makeEndpointer, rms, sliceRecording, STT_SAMPLE_RATE } from "../src/web/mic-lib.js";

describe("mic-lib (#74)", () => {
  it("downsamples 48 kHz and 44.1 kHz to 16 kHz, averaging", () => {
    const fortyEight = new Float32Array(48000).fill(0.5);
    const out = downsample(fortyEight, 48000);
    expect(out).toHaveLength(16000);
    expect(out.every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
    expect([...downsample(new Float32Array([0, 0.3, 0.6, 1, 1, 1]), 48000)].map((s) => Number(s.toFixed(2)))).toEqual([0.3, 1]);
    expect(downsample(new Float32Array(44100), 44100)).toHaveLength(16000);
    expect(downsample(new Float32Array([0.1, 0.2]), 16000)).toEqual(new Float32Array([0.1, 0.2]));
    expect(() => downsample(new Float32Array(8), 8000)).toThrow();
  });

  it("encodes a 16-bit mono WAV that /transcribe accepts", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 1, 2]));
    expect(parseWavHeader(wav)).toEqual({ channels: 1, sampleRate: 16000, bitsPerSample: 16, dataOffset: 44 });
    const samples = new Int16Array(wav.buffer.slice(44));
    expect([...samples]).toEqual([0, 16384, -32768, 32767, 32767]); // clipped above 1
    expect(checkSpeechWav(encodeWav(new Float32Array(STT_SAMPLE_RATE)))).toEqual({ ok: true, value: { audioMs: 1000 } });
  });

  it("measures a frame's level", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBe(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  const feedAll = (levels: readonly number[], options = {}) => {
    const e = makeEndpointer(options);
    return { events: levels.map((l) => e.feed(l, 20)), e };
  };
  const repeat = (level: number, ms: number) => Array.from({ length: ms / 20 }, () => level);

  it("finds speech after background noise and ends after a pause", () => {
    const noise = repeat(0.005, 400);
    const talk = repeat(0.1, 1000);
    const pause = repeat(0.005, ENDPOINT.endSilenceMs);
    const { events, e } = feedAll([...noise, ...talk, ...pause]);
    expect(events.filter((x) => x === "speech")).toHaveLength(1);
    expect(events.indexOf("speech")).toBe(noise.length + Math.ceil(ENDPOINT.speechStartMs / 20) - 1);
    expect(events.at(-1)).toBe("end");
    expect(e.heard()).toBe(true);
    // From 300 ms before speech to 200 ms into the pause.
    expect(e.span()).toEqual({ fromMs: 100, toMs: 400 + 1000 + 200 });
  });

  it("isn't ended by short gaps between words, nor started by a click", () => {
    const word = repeat(0.1, 300);
    const gap = repeat(0.005, 400);
    const click = repeat(0.3, 40);
    const { events } = feedAll([...repeat(0.005, 200), ...click, ...repeat(0.005, 200), ...word, ...gap, ...word, ...gap, ...word]);
    expect(events.filter((x) => x === "speech")).toHaveLength(1);
    expect(events.indexOf("speech")).toBeGreaterThan(20); // not at the click
    expect(events).not.toContain("end");
  });

  it("learns a louder room and needs speech above it", () => {
    const hum = repeat(0.02, 600); // above minThreshold, but steady
    const { events } = feedAll([...hum, ...repeat(0.025, 400)]);
    expect(events).not.toContain("speech");
    expect(feedAll([...hum, ...repeat(0.2, 400)]).events).toContain("speech");
  });

  it("gives up when nothing is said, and stops an utterance that runs too long", () => {
    const quiet = feedAll(repeat(0.003, 8000));
    expect(quiet.events.at(-1)).toBe("no-speech");
    expect(quiet.e.heard()).toBe(false);
    expect(feedAll(repeat(0.003, 2000), { noSpeechMs: 2000 }).events.at(-1)).toBe("no-speech");
    const long = feedAll([...repeat(0.003, 200), ...repeat(0.2, 3000)], { maxMs: 2000 });
    const firstMax = long.events.indexOf("max");
    expect(firstMax).toBe(10 + 2000 / 20 - 1); // 2 s after speech began
    expect(long.events.slice(firstMax).every((x) => x === "max")).toBe(true); // stays ended
  });

  it("cuts the recording to the span, across chunks", () => {
    const chunks = [new Float32Array([0, 1, 2, 3]), new Float32Array([4, 5, 6]), new Float32Array([7, 8, 9])];
    // 10 samples at 10 Hz: 100 ms each.
    expect([...sliceRecording(chunks, 10, { fromMs: 200, toMs: 800 })]).toEqual([2, 3, 4, 5, 6, 7]);
    expect([...sliceRecording(chunks, 10, { fromMs: 0, toMs: 5000 })]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sliceRecording(chunks, 10, { fromMs: 900, toMs: 100 })).toHaveLength(0);
  });
});
