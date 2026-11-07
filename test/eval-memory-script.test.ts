// eval:memory must never touch the real memory database. It runs against
// the model with your key, so this is checked here, without running it.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** The script's code without its comments (which do mention data/memory.sqlite, to say it's never used). */
const code = async () =>
  (await readFile("scripts/eval-memory.ts", "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("scripts/eval-memory.ts", () => {
  it("uses a throwaway in-memory store and never opens a file store", async () => {
    const source = await code();
    expect(source).toContain("makeMemoryStoreInMemory");
    expect(source).not.toMatch(/memory-sqlite|openSqliteMemoryStore|MEMORY_DB|memoryStore\b|buildDeps/);
    expect(source).not.toMatch(/\.sqlite/);
  });

  it("follows the live flow: handleAsk with the shared answered-contexts list", async () => {
    const source = await code();
    expect(source).toMatch(/import \{ handleAsk \} from "\.\.\/src\/ask\.js"/);
    expect(source).toContain("makeAnswerRouter(answerers)");
    expect(source).toContain("ANSWERED_CONTEXT_IDS");
  });
});
