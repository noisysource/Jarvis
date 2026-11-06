import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFileProfileSource, makeProfileSource, type ProfileFileSystem } from "../src/profile.js";

const PRIVATE = "Allergic to penicillin";
const fixedNow = () => new Date("2026-11-06T17:00:00Z");

/** In-memory file system whose file can be changed between calls. */
const memoryFs = (initial: { text: string; mtimeMs: number } | undefined) => {
  let file = initial;
  const fs: ProfileFileSystem = {
    stat: vi.fn(async () => {
      if (!file) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      return { mtimeMs: file.mtimeMs, size: Buffer.byteLength(file.text) };
    }),
    readFile: vi.fn(async () => {
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return file.text;
    }),
  };
  return { fs, set: (next: typeof file) => (file = next) };
};

describe("makeFileProfileSource", () => {
  it("loads and trims the profile", async () => {
    const { fs } = memoryFs({ text: `\uFEFF\n# Me\n- ${PRIVATE}\n\n`, mtimeMs: 1 });
    const load = makeFileProfileSource({ path: "data/profile.md", fs, now: fixedNow });
    expect(await load()).toEqual({ ok: true, value: { text: `# Me\n- ${PRIVATE}`, loadedAt: fixedNow() } });
  });

  it("only re-reads the file when it changes", async () => {
    const mem = memoryFs({ text: "v1", mtimeMs: 1 });
    const load = makeFileProfileSource({ path: "p.md", fs: mem.fs, now: fixedNow });

    await load();
    await load();
    expect(mem.fs.readFile).toHaveBeenCalledTimes(1);

    mem.set({ text: "v2 longer", mtimeMs: 2 });
    const changed = await load();
    expect(changed.ok && changed.value.text).toBe("v2 longer");
    expect(mem.fs.readFile).toHaveBeenCalledTimes(2);
  });

  it("explains how to create a missing profile", async () => {
    const load = makeFileProfileSource({ path: "data/profile.md", fs: memoryFs(undefined).fs });
    expect(await load()).toEqual({
      ok: false,
      error: {
        code: "missing",
        message: "No profile at data/profile.md. Copy data/profile.example.md to data/profile.md and fill it in.",
      },
    });
  });

  it("reports a profile that disappears after loading", async () => {
    const mem = memoryFs({ text: "v1", mtimeMs: 1 });
    const load = makeFileProfileSource({ path: "p.md", fs: mem.fs });
    expect((await load()).ok).toBe(true);
    mem.set(undefined);
    const result = await load();
    expect(!result.ok && result.error.code).toBe("missing");
  });

  it("rejects a profile over the size limit without reading it", async () => {
    const mem = memoryFs({ text: "x".repeat(101), mtimeMs: 1 });
    const load = makeFileProfileSource({ path: "p.md", fs: mem.fs, maxBytes: 100 });
    expect(await load()).toEqual({
      ok: false,
      error: { code: "too_large", message: "The profile at p.md is 101 bytes; the limit is 100" },
    });
    expect(mem.fs.readFile).not.toHaveBeenCalled();
  });

  it("rejects an empty profile", async () => {
    const load = makeFileProfileSource({ path: "p.md", fs: memoryFs({ text: " \n\n", mtimeMs: 1 }).fs });
    const result = await load();
    expect(!result.ok && result.error.code).toBe("empty");
  });

  it("reports other read errors by code only", async () => {
    const fs: ProfileFileSystem = {
      stat: async () => {
        throw Object.assign(new Error(`EACCES reading ${PRIVATE}`), { code: "EACCES" });
      },
      readFile: async () => "",
    };
    const result = await makeFileProfileSource({ path: "p.md", fs })();
    expect(result).toEqual({
      ok: false,
      error: { code: "unreadable", message: "Couldn't read the profile at p.md (EACCES)" },
    });
  });

  it("never puts profile text in an error", async () => {
    const mem = memoryFs({ text: `- ${PRIVATE}`, mtimeMs: 1 });
    const load = makeFileProfileSource({ path: "p.md", fs: mem.fs, maxBytes: 5 });
    expect(JSON.stringify(await load())).not.toContain(PRIVATE);
  });
});

describe("with the real file system", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("picks up edits to the file", async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-profile-"));
    const path = join(dir, "profile.md");
    await writeFile(path, "first");
    await utimes(path, 1_000, 1_000);

    const load = makeProfileSource({ kind: "file", path });
    const first = await load();
    expect(first.ok && first.value.text).toBe("first");

    await writeFile(path, "second version");
    await utimes(path, 2_000, 2_000);
    const result = await load();
    expect(result.ok && result.value.text).toBe("second version");
  });

  it("loads the committed example profile", async () => {
    const result = await makeProfileSource({ kind: "file", path: "data/profile.example.md" })();
    expect(result.ok && result.value.text).toContain("## Family");
  });
});
