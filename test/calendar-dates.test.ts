import { describe, expect, it } from "vitest";
import { dayLabel, rangeLabel, readSentence, resolveDatePhrase, shortRangeLabel } from "../src/calendar/dates.js";
import { calendarQuestion, localDate } from "../src/calendar/read.js";

const TZ = "Europe/Lisbon";
// Tuesday 10 November 2026.
const TUE = "2026-11-10";
const day = (d: string) => ({ from: d, to: d });

describe("date phrases resolved in code (#100)", () => {
  it.each([
    ["What's on today?", day("2026-11-10")],
    ["Anything on tonight?", day("2026-11-10")],
    ["What do I have this afternoon?", day("2026-11-10")],
    ["What's on tomorrow?", day("2026-11-11")], // the bug: a model read Thursday 12
    ["what's on tomorrow morning", day("2026-11-11")],
    ["What's on the day after tomorrow?", day("2026-11-12")],
    ["What did I have yesterday?", day("2026-11-09")],
    ["What was on the day before yesterday?", day("2026-11-08")],
    // Weekday names: the next one, today included
    ["What's on Tuesday?", day("2026-11-10")],
    ["Am I free on Wednesday?", day("2026-11-11")],
    ["Am I free Friday afternoon?", day("2026-11-13")],
    ["What's on this Sunday?", day("2026-11-15")],
    ["Anything on Monday?", day("2026-11-16")],
    ["Do I have plans on Thurs?", day("2026-11-12")],
    // "Next <weekday>": the next one after today
    ["What's on next Tuesday?", day("2026-11-17")],
    ["What's on next Friday?", day("2026-11-13")],
    // Weeks and weekends
    ["What's on this week?", { from: "2026-11-10", to: "2026-11-15" }],
    ["Any meetings next week?", { from: "2026-11-16", to: "2026-11-22" }],
    ["What's on this weekend?", { from: "2026-11-14", to: "2026-11-15" }],
    ["Am I free at the weekend?", { from: "2026-11-14", to: "2026-11-15" }],
    ["Anything next weekend?", { from: "2026-11-21", to: "2026-11-22" }],
    // Explicit dates
    ["What's on 12 November?", day("2026-11-12")],
    ["What's on the 12th of November?", day("2026-11-12")],
    ["What's on November 12?", day("2026-11-12")],
    ["What's on Nov 12th, 2027?", day("2027-11-12")],
    ["What's on 12/11?", day("2026-11-12")], // day first
    ["What's on 12/11/2026?", day("2026-11-12")],
    ["What's on 1/12/26?", day("2026-12-01")],
    ["What's on 12.11.2026?", day("2026-11-12")],
    ["What's on 2026-11-12?", day("2026-11-12")],
    ["What's on 3 January?", day("2027-01-03")], // already past this year: next year
    ["What was on 2 November?", day("2026-11-02")], // within the last month: this year
    // Several phrases: from the first to the last
    ["What's on today and tomorrow?", { from: "2026-11-10", to: "2026-11-11" }],
    ["What's on from Monday to Wednesday?", { from: "2026-11-16", to: "2026-11-18" }],
    ["What's on Friday to Sunday?", { from: "2026-11-13", to: "2026-11-15" }],
    ["What's on 12 to 14 November?", { from: "2026-11-12", to: "2026-11-14" }],
    ["What's on 12–14 Nov?", { from: "2026-11-12", to: "2026-11-14" }],
  ] as const)("%j", (question, expected) => expect(resolveDatePhrase(question, TUE)).toEqual(expected));

  it.each(["What's in my calendar?", "Do I have any meetings?", "What's a black hole?", "It's about 3.5 km", "I sat in the sun", "What's on 31 February?"])(
    "leaves %j to the brain's request",
    (question) => expect(resolveDatePhrase(question, TUE)).toBeUndefined(),
  );

  it("counts from the day it is in Lisbon, around midnight", () => {
    // 23:30 on Tuesday in Lisbon (winter, UTC+0): still Tuesday.
    const lateTuesday = localDate(new Date("2026-11-10T23:30:00Z"), TZ);
    expect(resolveDatePhrase("What's on tomorrow?", lateTuesday)).toEqual(day("2026-11-11"));
    // Half an hour later it's Wednesday: tomorrow is Thursday.
    const earlyWednesday = localDate(new Date("2026-11-11T00:00:30Z"), TZ);
    expect(resolveDatePhrase("What's on tomorrow?", earlyWednesday)).toEqual(day("2026-11-12"));
    expect(resolveDatePhrase("What's on today?", earlyWednesday)).toEqual(day("2026-11-11"));
    // Summer (UTC+1): 23:30 UTC on 10 July is already 11 July in Lisbon.
    const summer = localDate(new Date("2026-07-10T23:30:00Z"), TZ);
    expect(summer).toBe("2026-07-11");
    expect(resolveDatePhrase("What's on tomorrow?", summer)).toEqual(day("2026-07-12"));
    expect(resolveDatePhrase("What's on Saturday?", summer)).toEqual(day("2026-07-11"));
  });

  it("gets the days right across the clock changes (23- and 25-hour days)", () => {
    // Clocks go forward on Sunday 29 March 2026.
    expect(resolveDatePhrase("tomorrow", "2026-03-28")).toEqual(day("2026-03-29"));
    expect(resolveDatePhrase("tomorrow", "2026-03-29")).toEqual(day("2026-03-30"));
    expect(resolveDatePhrase("this weekend", "2026-03-27")).toEqual({ from: "2026-03-28", to: "2026-03-29" });
    expect(resolveDatePhrase("next week", "2026-03-27")).toEqual({ from: "2026-03-30", to: "2026-04-05" });
    expect(localDate(new Date("2026-03-29T00:30:00Z"), TZ)).toBe("2026-03-29"); // 00:30, before the change
    expect(localDate(new Date("2026-03-29T23:30:00Z"), TZ)).toBe("2026-03-30"); // 00:30 summer time
    // Clocks go back on Sunday 25 October 2026.
    expect(resolveDatePhrase("tomorrow", "2026-10-24")).toEqual(day("2026-10-25"));
    expect(resolveDatePhrase("tomorrow", "2026-10-25")).toEqual(day("2026-10-26"));
    expect(resolveDatePhrase("Monday", "2026-10-25")).toEqual(day("2026-10-26"));
    expect(localDate(new Date("2026-10-25T23:30:00Z"), TZ)).toBe("2026-10-25"); // 23:30 winter time
    expect(localDate(new Date("2026-10-24T23:30:00Z"), TZ)).toBe("2026-10-25"); // 00:30 summer time
  });

  it("handles the ends of the week, month and year", () => {
    expect(resolveDatePhrase("this weekend", "2026-11-14")).toEqual({ from: "2026-11-14", to: "2026-11-15" }); // on Saturday
    expect(resolveDatePhrase("this weekend", "2026-11-15")).toEqual(day("2026-11-15")); // on Sunday: what's left
    expect(resolveDatePhrase("this week", "2026-11-15")).toEqual(day("2026-11-15"));
    expect(resolveDatePhrase("next week", "2026-11-15")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(resolveDatePhrase("tomorrow", "2026-12-31")).toEqual(day("2027-01-01"));
    expect(resolveDatePhrase("tomorrow", "2028-02-28")).toEqual(day("2028-02-29")); // a leap year
  });
});

describe("the date read, worded by code (#100)", () => {
  it("names the day, with the year only when it isn't this one", () => {
    expect(dayLabel("2026-11-11", TUE)).toBe("Wednesday 11 November");
    expect(dayLabel("2027-01-03", TUE)).toBe("Sunday 3 January 2027");
    expect(rangeLabel({ from: "2026-11-16", to: "2026-11-22" }, TUE)).toBe("Monday 16 to Sunday 22 November");
    expect(rangeLabel({ from: "2026-11-28", to: "2026-12-01" }, TUE)).toBe("Saturday 28 November to Tuesday 1 December");
    expect(readSentence(day("2026-11-11"), TUE)).toBe("Looking at Wednesday 11 November.");
    expect(shortRangeLabel(day("2026-11-11"))).toBe("Wed 11 Nov");
    expect(shortRangeLabel({ from: "2026-11-16", to: "2026-11-22" })).toBe("Mon 16 – Sun 22 Nov");
    expect(shortRangeLabel({ from: "2026-11-28", to: "2026-12-01" })).toBe("Sat 28 Nov – Tue 1 Dec");
  });
});

describe("a bare yes after an offer to try again (#100)", () => {
  const failed = [
    { role: "user" as const, text: "What's on tomorrow?" },
    { role: "assistant" as const, text: "I couldn't reach your calendar right now. Shall I try again?" },
  ];
  it("repeats the last calendar question", () => {
    for (const yes of ["yes", "Yes please.", "ok", "Sure, go ahead", "try again", "Yes, try again!"]) {
      expect(calendarQuestion(yes, failed), yes).toBe("What's on tomorrow?");
    }
    // "Try again" needs no offer.
    const noOffer = [{ role: "user" as const, text: "What's on tomorrow?" }, { role: "assistant" as const, text: "I couldn't reach your calendar right now." }];
    expect(calendarQuestion("try again", noOffer)).toBe("What's on tomorrow?");
    expect(calendarQuestion("yes", noOffer)).toBeUndefined();
  });
  it("isn't a calendar turn otherwise", () => {
    expect(calendarQuestion("yes", [])).toBeUndefined();
    expect(calendarQuestion("yes, and tell me a joke", failed)).toBeUndefined();
    const other = [
      { role: "user" as const, text: "Explain black holes" },
      { role: "assistant" as const, text: "That got cut off. Shall I try again?" },
    ];
    expect(calendarQuestion("yes", other)).toBeUndefined();
    expect(calendarQuestion("What's on Friday?", [])).toBe("What's on Friday?");
  });
});
