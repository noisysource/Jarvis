import { describe, expect, it } from "vitest";
import { checkSpeechWav } from "../src/stt/wav.js";
import { parseWavHeader } from "../src/tts/pcm.js";
import { encodeWav, makeFrameStore, makeFramer, makeResampler, STT_SAMPLE_RATE } from "../src/web/mic-lib.js";

describe("mic-lib (#74)", () => {
  it("encodes a 16-bit mono WAV that /transcribe accepts", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 1, 2]));
    expect(parseWavHeader(wav)).toEqual({ channels: 1, sampleRate: 16000, bitsPerSample: 16, dataOffset: 44 });
    const samples = new Int16Array(wav.buffer.slice(44));
    expect([...samples]).toEqual([0, 16384, -32768, 32767, 32767]); // clipped above 1
    expect(checkSpeechWav(encodeWav(new Float32Array(STT_SAMPLE_RATE)))).toEqual({ ok: true, value: { audioMs: 1000 } });
  });

  it("resamples a stream to 16 kHz without losing samples at chunk boundaries", () => {
    for (const rate of [48000, 44100, 16000]) {
      const resample = makeResampler(rate);
      let out = 0;
      // About 2 s in 128-sample chunks, as an AudioWorklet delivers them.
      const chunks = Math.ceil((rate * 2) / 128);
      for (let i = 0; i < chunks; i += 1) out += resample(new Float32Array(128).fill(0.25)).length;
      expect(Math.abs(out - (chunks * 128 * 16000) / rate), `${rate} Hz`).toBeLessThanOrEqual(1);
    }
    const r = makeResampler(48000);
    expect([...r(new Float32Array([0, 0.3])), ...r(new Float32Array([0.6, 1, 1, 1]))].map((s) => Number(s.toFixed(2)))).toEqual([0.3, 1]);
    expect(() => makeResampler(8000)).toThrow();
  });

  it("cuts samples into frames, carrying the rest", () => {
    const framer = makeFramer(4);
    expect(framer(new Float32Array([1, 2, 3]))).toEqual([]);
    expect(framer(new Float32Array([4, 5, 6, 7, 8, 9]))).toEqual([new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])]);
    expect(framer(new Float32Array([10, 11, 12]))).toEqual([new Float32Array([9, 10, 11, 12])]);
  });

  it("keeps the last frames, numbered from 1, and joins a span of them", () => {
    const store = makeFrameStore(3);
    for (let n = 1; n <= 5; n += 1) store.push(new Float32Array([n, n]));
    expect([...store.slice(3, 6)]).toEqual([3, 3, 4, 4, 5, 5]);
    expect([...store.slice(1, 4)]).toEqual([3, 3]); // 1 and 2 are gone
    expect([...store.slice(5, 5)]).toEqual([]);
    store.clear();
    expect([...store.slice(1, 9)]).toEqual([]);
    store.push(new Float32Array([6]));
    expect([...store.slice(6, 7)]).toEqual([6]);
  });

});
