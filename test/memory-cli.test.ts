import { describe, expect, it } from "vitest";
import { exportMemories, formatMemoryList, parseMemoryArgs } from "../src/memory-cli.js";
import type { ContextId, Memory } from "../src/types.js";

describe("parseMemoryArgs", () => {
  it.each([
    [[], { command: "help" }],
    [["list"], { command: "list" }],
    [["list", "--context", "kidclub", "--kind", "playbook"], { command: "list", context: "kidclub", kind: "playbook" }],
    [["delete", "m1"], { command: "delete", id: "m1" }],
    [["wipe", "--context", "personal"], { command: "wipe", context: "personal", yes: false }],
    [["wipe", "--context", "personal", "--yes"], { command: "wipe", context: "personal", yes: true }],
    [["export"], { command: "export" }],
    [["export", "--context", "personal"], { command: "export", context: "personal" }],
  ])("%j", (argv, value) => {
    expect(parseMemoryArgs(argv)).toEqual({ ok: true, value });
  });

  it.each([
    [["delete"], "delete needs one memory id (see `list`)"],
    [["wipe"], "wipe needs --context <id>"],
    [["list", "--kind", "secret"], "--kind must be fact, playbook or history"],
    [["list", "--context"], "--context needs a value"],
    [["list", "--colour", "red"], "unknown option --colour"],
    [["forget"], 'unknown command "forget"'],
  ])("%j is refused", (argv, error) => {
    expect(parseMemoryArgs(argv)).toEqual({ ok: false, error });
  });
});

const memory = (over: Partial<Memory>): Memory => ({
  id: "m1",
  contextId: "personal" as ContextId,
  kind: "fact",
  text: "Inês's teacher is Ms Rita",
  origin: "auto",
  createdAt: new Date("2026-11-06T10:00:00Z"),
  updatedAt: new Date("2026-11-07T10:00:00Z"),
  source: "req-1",
  seen: true,
  ...over,
});

describe("formatMemoryList", () => {
  it("shows id, context, kind, date and markers, then the text", () => {
    expect(
      formatMemoryList([
        memory({ origin: "explicit", seen: false }),
        memory({ id: "h1", kind: "history", text: "Talked about school", expiresAt: new Date("2026-12-07T10:00:00Z") }),
      ]),
    ).toBe(
      "m1  personal  fact  2026-11-07  explicit  new\n    Inês's teacher is Ms Rita\n" +
        "h1  personal  history  2026-11-07  expires 2026-12-07\n    Talked about school",
    );
    expect(formatMemoryList([])).toBe("No memories.");
  });
});

describe("exportMemories", () => {
  it("prints JSON with ISO dates", () => {
    const out = JSON.parse(exportMemories([memory({ lastUsedAt: new Date("2026-11-07T11:00:00Z") })])) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ id: "m1", createdAt: "2026-11-06T10:00:00.000Z", lastUsedAt: "2026-11-07T11:00:00.000Z" });
  });
});
