import { describe, expect, it } from "vitest";
import { formatNow } from "../src/time.js";

describe("formatNow", () => {
  it.each([
    ["2026-11-06T17:20:00Z", "Friday, 6 November 2026, 17:20 (Europe/Lisbon, GMT+0)"],
    // Summer time starts 29 March 2026 at 01:00 UTC.
    ["2026-03-29T00:30:00Z", "Sunday, 29 March 2026, 00:30 (Europe/Lisbon, GMT+0)"],
    ["2026-03-29T01:30:00Z", "Sunday, 29 March 2026, 02:30 (Europe/Lisbon, GMT+1)"],
    // Summer time ends 25 October 2026 at 01:00 UTC.
    ["2026-10-25T00:30:00Z", "Sunday, 25 October 2026, 01:30 (Europe/Lisbon, GMT+1)"],
    ["2026-10-25T01:30:00Z", "Sunday, 25 October 2026, 01:30 (Europe/Lisbon, GMT+0)"],
    // Late evening UTC is already the next day further east.
    ["2026-12-31T23:30:00Z", "Thursday, 31 December 2026, 23:30 (Europe/Lisbon, GMT+0)"],
  ])("%s -> %s", (instant, expected) => {
    expect(formatNow(new Date(instant), "Europe/Lisbon")).toBe(expected);
  });

  it("uses the given time zone", () => {
    expect(formatNow(new Date("2026-12-31T23:30:00Z"), "Europe/Madrid")).toBe(
      "Friday, 1 January 2027, 00:30 (Europe/Madrid, GMT+1)",
    );
  });
});
