import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive, makeIsStarting } from "../src/service-starting.js";
import { makeTtsProviders } from "../src/tts/registry.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const runDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-run-"));
  dirs.push(dir);
  return dir;
};

describe("makeIsStarting (#80)", () => {
  it("is true only while voice:up's mark names a running process", async () => {
    const dir = await runDir();
    const isStarting = makeIsStarting({ runDir: dir, isAlive: (pid) => pid === 4242 });
    expect(await isStarting("kokoro")).toBe(false); // no mark
    await writeFile(path.join(dir, "kokoro.starting"), "4242\n");
    expect(await isStarting("kokoro")).toBe(true);
    expect(await isStarting("piper")).toBe(false);
    await writeFile(path.join(dir, "piper.starting"), "999999\n"); // voice:up was killed
    expect(await isStarting("piper")).toBe(false);
    for (const junk of ["", "abc", "-1", "0", "1.5"]) {
      await writeFile(path.join(dir, "whisper.starting"), junk);
      expect(await isStarting("whisper")).toBe(false);
    }
  });

  it("checks real processes", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("makes a down provider say it's starting rather than not running", async () => {
    const dir = await runDir();
    await writeFile(path.join(dir, "kokoro.starting"), String(process.pid));
    const providers = makeTtsProviders({
      kokoroUrl: new URL("http://127.0.0.1:9"),
      piperUrl: new URL("http://127.0.0.1:9"),
      isStarting: makeIsStarting({ runDir: dir }),
    });
    expect(await providers.kokoro.listVoices("en")).toEqual({
      ok: false,
      error: { kind: "starting", message: "Kokoro is starting (the first start takes a minute or two)" },
    });
    expect(await providers.kokoro.speak({ text: "x", language: "en", voice: "bm_george" })).toMatchObject({ ok: false, error: { kind: "starting" } });
    expect(await providers.piper.listVoices("en")).toMatchObject({ ok: false, error: { kind: "unavailable", message: "Piper isn't running at http://127.0.0.1:9 (npm run voice:up)" } });
    await writeFile(path.join(dir, "piper.starting"), String(process.pid));
    expect(await providers.piper.speak({ text: "x", language: "en", voice: "en_GB-alan-medium" })).toMatchObject({
      ok: false,
      error: { kind: "starting", message: "Piper is starting (the first start takes a minute or two)" },
    });
  });
});
