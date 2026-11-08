import { describe, expect, it } from "vitest";
import { pcm16ToFloat32, readAudioFormat } from "../src/web/pcm-lib.js";
import { AUDITION_SENTENCES, browserEnglishVoices, envLines, formatMs, median } from "../src/web/voices-lib.js";

describe("pcm-lib", () => {
  it("turns 16-bit samples into floats", () => {
    const bytes = new Uint8Array(new Int16Array([0, 16384, -32768, 32767]).buffer);
    expect([...pcm16ToFloat32(bytes)]).toEqual([0, 0.5, -1, 32767 / 32768]);
    expect(pcm16ToFloat32(new Uint8Array(3))).toHaveLength(1); // an odd byte is ignored
  });

  it("reads the /speak audio format, refusing anything else", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(readAudioFormat(h({ "x-audio-format": "pcm_s16le", "x-sample-rate": "24000", "x-channels": "1" }))).toEqual({ sampleRate: 24000 });
    expect(readAudioFormat(h({ "x-audio-format": "mp3", "x-sample-rate": "24000", "x-channels": "1" }))).toBeNull();
    expect(readAudioFormat(h({ "x-audio-format": "pcm_s16le", "x-sample-rate": "24000", "x-channels": "2" }))).toBeNull();
    expect(readAudioFormat(h({ "x-audio-format": "pcm_s16le", "x-sample-rate": "lots", "x-channels": "1" }))).toBeNull();
  });
});

describe("voices-lib", () => {
  it("has the five audition sentences", () => {
    expect(AUDITION_SENTENCES.map((s) => s.id)).toEqual(["greeting", "fact", "unavailable", "explanation", "question"]);
    const explanation = AUDITION_SENTENCES.find((s) => s.id === "explanation")?.text ?? "";
    expect(explanation.split(". ")).toHaveLength(3);
  });

  it("shows the .env lines for a choice", () => {
    expect(envLines("kokoro", "bm_george")).toBe("TTS_PROVIDER=kokoro\nTTS_VOICE=bm_george");
  });

  it("works out medians and formats times", () => {
    expect(median([])).toBeNull();
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(formatMs(312.4)).toBe("312 ms");
    expect(formatMs(null)).toBe("—");
  });

  it("lists English system voices once each, British first", () => {
    const voices = [
      { name: "Samantha", lang: "en-US" },
      { name: "Daniel", lang: "en-GB" },
      { name: "Joana", lang: "pt-PT" },
    ];
    const rank = (vs: readonly { name: string; lang: string }[], lang: string) => vs.filter((v) => v.lang.startsWith(lang.slice(0, 2))).sort((a) => (a.lang === lang ? -1 : 1));
    expect(browserEnglishVoices(voices, rank).map((v) => v.name)).toEqual(["Daniel", "Samantha"]);
  });
});
