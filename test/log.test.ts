import { describe, expect, it } from "vitest";
import { makeJsonLogger, withLogFields } from "../src/log.js";

const NOW = new Date("2026-11-06T17:20:00Z");

describe("makeJsonLogger", () => {
  it("writes one JSON object per line with a Cloud Logging severity", () => {
    const lines: string[] = [];
    const log = makeJsonLogger({ write: (l) => lines.push(l), now: () => NOW, fields: { service: "jarvis" } });

    log.info("listening", { port: 8080 });
    log.warn("slow");
    log.error("failed", { errorName: "TypeError" });

    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { severity: "INFO", time: "2026-11-06T17:20:00.000Z", message: "listening", service: "jarvis", port: 8080 },
      { severity: "WARNING", time: "2026-11-06T17:20:00.000Z", message: "slow", service: "jarvis" },
      { severity: "ERROR", time: "2026-11-06T17:20:00.000Z", message: "failed", service: "jarvis", errorName: "TypeError" },
    ]);
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });
});

describe("withLogFields", () => {
  it("adds fields to every entry", () => {
    const lines: string[] = [];
    const log = withLogFields(makeJsonLogger({ write: (l) => lines.push(l), now: () => NOW }), { requestId: "r1" });
    log.info("ask", { outcome: "answer" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ message: "ask", requestId: "r1", outcome: "answer" });
  });
});
