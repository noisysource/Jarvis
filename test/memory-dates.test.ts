import { describe, expect, it } from "vitest";
import { dayIn, expiryAfter, formatDayIso, mentionsRelativeDay, parseDayIso, resolveEventDay, type Day } from "../src/memory-dates.js";

const SATURDAY: Day = { year: 2026, month: 11, day: 7 }; // Saturday 7 November 2026
const SUNDAY: Day = { year: 2026, month: 11, day: 8 };
const on = (text: string, today = SATURDAY) => {
  const d = resolveEventDay(text, today);
  return d ? formatDayIso(d) : undefined;
};

describe("resolveEventDay (from Saturday 7 November 2026)", () => {
  it.each([
    ["Remember Diniz has football tomorrow", "2026-11-08"],
    ["O Diniz tem futebol amanhã", "2026-11-08"],
    ["the day after tomorrow", "2026-11-09"],
    ["depois de amanhã", "2026-11-09"],
    ["dinner tonight", "2026-11-07"],
    ["hoje à noite", "2026-11-07"],
    ["on Friday", "2026-11-13"],
    ["Lembra-te que tenho dentista na sexta", "2026-11-13"],
    ["sexta-feira às 10h", "2026-11-13"],
    ["on Saturday", "2026-11-07"],
    ["next Saturday", "2026-11-14"],
    ["na próxima segunda", "2026-11-09"],
    ["Diniz has football on Sunday 8 November 2026", "2026-11-08"],
    ["8 November", "2026-11-08"],
    ["November 20", "2026-11-20"],
    ["a 12 de dezembro", "2026-12-12"],
    ["12 de dezembro de 2027", "2027-12-12"],
    ["no dia 12", "2026-11-12"],
    ["on the 3rd", "2026-12-03"],
    ["12/11", "2026-11-12"],
    ["1 January", "2027-01-01"],
  ])("%j → %s", (text, expected) => expect(on(text)).toBe(expected));

  it.each(["pela segunda vez", "uma quinta no Alentejo", "set 5 alarms", "I may 8 hours", "Inês swims", "às segundas"])(
    "%j has no date",
    (text) => expect(on(text)).toBeUndefined(),
  );

  it("works across a week boundary (Sunday → Monday)", () => {
    expect(on("tomorrow", SUNDAY)).toBe("2026-11-09");
    expect(on("on Monday", SUNDAY)).toBe("2026-11-09");
    expect(on("on Sunday", SUNDAY)).toBe("2026-11-08");
    expect(on("on Saturday", SUNDAY)).toBe("2026-11-14");
  });

  it("works across a month and a year boundary", () => {
    expect(on("tomorrow", { year: 2026, month: 12, day: 31 })).toBe("2027-01-01");
    expect(on("dia 31", { year: 2026, month: 11, day: 7 })).toBe("2026-12-31"); // November has no 31st
  });
});

describe("dates and expiries in Lisbon", () => {
  it("knows the Lisbon day, which can differ from UTC's", () => {
    expect(formatDayIso(dayIn(new Date("2026-11-07T10:00:00Z"), "Europe/Lisbon"))).toBe("2026-11-07");
    expect(formatDayIso(dayIn(new Date("2026-07-07T23:30:00Z"), "Europe/Lisbon"))).toBe("2026-07-08"); // 00:30 in summer
  });

  it("expires at the start of the day after the event, in winter and summer time", () => {
    expect(expiryAfter({ year: 2026, month: 11, day: 8 }, "Europe/Lisbon").toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(expiryAfter({ year: 2026, month: 11, day: 13 }, "Europe/Lisbon").toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(expiryAfter({ year: 2026, month: 7, day: 10 }, "Europe/Lisbon").toISOString()).toBe("2026-07-10T23:00:00.000Z");
    // The night summer time starts (29 March 2026): midnight is still GMT+0.
    expect(expiryAfter({ year: 2026, month: 3, day: 28 }, "Europe/Lisbon").toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });

  it("parses YYYY-MM-DD strictly", () => {
    expect(parseDayIso("2026-11-08")).toEqual({ year: 2026, month: 11, day: 8 });
    expect(parseDayIso("2026-02-30")).toBeUndefined();
    expect(parseDayIso("8/11/2026")).toBeUndefined();
  });

  it("spots words that tie a memory to a particular day", () => {
    for (const t of ["football tomorrow", "futebol amanhã", "today", "hoje", "esta noite"]) expect(mentionsRelativeDay(t)).toBe(true);
    for (const t of ["swims on Tuesdays", "nada às segundas"]) expect(mentionsRelativeDay(t)).toBe(false);
  });
});
