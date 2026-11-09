// Times the local voice services as they're running now (#76), so settings
// can be compared quickly: Kokoro's time to first audio for a typical first
// chunk (MPS or CPU: restart voice:up with KOKORO_DEVICE=cpu), and Whisper's
// time to transcribe a short utterance (small.en or base.en: restart with
// WHISPER_MODEL=base.en after `WHISPER_MODEL=base.en npm run voice:setup`).
//
//   npm run voice:bench
//
// Uses fixed sentences and the synthetic test clip in test/fixtures/audio,
// never anything of yours. Nothing is sent off this machine.

import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";

const RUNS = 7;
const FIRST_CHUNKS = [
  "Your passport expires in January,",
  "Sure, I can help with that.",
  "Today you have three things on,",
  "The meeting starts at ten,",
];

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const configResult = loadConfig(process.env);
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
};
const ms = (n: number) => `${Math.round(n)} ms`;

const benchKokoro = async () => {
  const voice = config.tts.provider === "kokoro" && config.tts.voice ? config.tts.voice : "bm_daniel";
  const first: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const input = FIRST_CHUNKS[i % FIRST_CHUNKS.length] ?? "";
    const started = performance.now();
    const res = await fetch(new URL("/v1/audio/speech", config.tts.kokoroUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input, voice, response_format: "pcm", stream: true, speed: 1 }),
    }).catch(() => undefined);
    if (!res?.ok || !res.body) return console.log(`Kokoro: not answering at ${config.tts.kokoroUrl.origin} (npm run voice:up)`);
    const reader = res.body.getReader();
    let firstAt: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > 0) firstAt ??= performance.now();
    }
    if (i === 0) continue; // the first request can include loading; it's shown separately
    first.push((firstAt ?? performance.now()) - started);
    total.push(performance.now() - started);
  }
  console.log(`Kokoro (${voice}): first audio median ${ms(median(first))} (min ${ms(Math.min(...first))}, max ${ms(Math.max(...first))}); whole chunk ${ms(median(total))}`);
};

const benchWhisper = async () => {
  const wav = await readFile("test/fixtures/audio/speech-16k.wav");
  const seconds = (wav.length - 44) / 32000;
  const times: number[] = [];
  let text = "";
  for (let i = 0; i < RUNS; i += 1) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    form.append("language", "en");
    const started = performance.now();
    const res = await fetch(new URL("/inference", config.stt.whisperUrl), { method: "POST", body: form }).catch(() => undefined);
    if (!res?.ok) return console.log(`Whisper: not answering at ${config.stt.whisperUrl.origin} (npm run voice:up)`);
    text = String(((await res.json()) as { text?: unknown }).text ?? "").trim();
    if (i > 0) times.push(performance.now() - started);
  }
  console.log(`Whisper: ${seconds.toFixed(1)} s clip in median ${ms(median(times))} (min ${ms(Math.min(...times))}); heard "${text}"`);
};

console.log(`${RUNS - 1} timed runs each, after one warm-up.\n`);
await benchKokoro();
await benchWhisper();
console.log("\nCompare: KOKORO_DEVICE=cpu npm run voice:up, and WHISPER_MODEL=base.en (after setting it up). The chat page's timing line shows the rest.");
