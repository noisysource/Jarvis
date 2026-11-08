import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { SILERO_FRAME, makeSilero, type OrtLike } from "../src/web/silero.js";
import { makeTurnDetector } from "../src/web/turn-lib.js";

// The real Silero v5 model and ONNX runtime the page uses, on a recording of
// synthesised speech (test/fixtures/audio).
let vad: Awaited<ReturnType<typeof makeSilero>>;
let speech: Float32Array;
beforeAll(async () => {
  ort.env.wasm.numThreads = 1;
  vad = await makeSilero(ort as unknown as OrtLike, new Uint8Array(await readFile("node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx")));
  const wav = await readFile("test/fixtures/audio/speech-16k.wav");
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
  speech = Float32Array.from(pcm, (s) => s / 32768);
});

const probabilities = async (samples: Float32Array) => {
  const out: number[] = [];
  for (let i = 0; i + SILERO_FRAME <= samples.length; i += SILERO_FRAME) out.push(await vad.probability(samples.subarray(i, i + SILERO_FRAME)));
  return out;
};

describe("Silero VAD (#75)", () => {
  it("hears speech, and not silence or a steady tone", async () => {
    vad.reset();
    const quiet = await probabilities(new Float32Array(16000));
    const voice = await probabilities(speech);
    const tone = await probabilities(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.3));
    expect(Math.max(...quiet)).toBeLessThan(0.2);
    expect(voice.filter((p) => p > 0.5).length / voice.length).toBeGreaterThan(0.5);
    expect(Math.max(...tone)).toBeLessThan(0.5);
  });

  it("drives the turn detector: one utterance, ended after the pause", async () => {
    vad.reset();
    const audio = new Float32Array(16000 + speech.length + 16000);
    audio.set(speech, 16000);
    const d = makeTurnDetector();
    const events = (await probabilities(audio)).map((p) => d.feed(p, false));
    expect(events.filter((e) => e === "start")).toHaveLength(1);
    expect(events.filter((e) => e === "end")).toHaveLength(1);
    const { from, to } = d.span();
    const seconds = ((to - from) * SILERO_FRAME) / 16000;
    expect(seconds).toBeGreaterThan(speech.length / 16000 - 0.3);
    expect(seconds).toBeLessThan(speech.length / 16000 + 1);
  });

  it("only takes 512-sample frames", async () => {
    await expect(vad.probability(new Float32Array(100))).rejects.toThrow("512-sample");
  });
});
