// #137: two calendar accounts, personal and noisysource, like Gmail.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { calendarTokensPath, readAccounts, type CalendarReaders } from "../src/calendar/accounts.js";
import { checkCreateRequest, makeGoogleEventCreator, proposalLabel, proposalPathLabel } from "../src/calendar/create.js";
import type { CalendarReader } from "../src/calendar/google.js";
import { calendarForBrain, type CalendarEvent } from "../src/calendar/read.js";
import type { LlmCall, LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const TZ = "Europe/Lisbon";
const NOW = new Date("2026-11-12T09:00:00Z");
const DAY = { from: "2026-11-12", to: "2026-11-12" };
const personal = { id: "personal", name: "Personal" } as unknown as Context;

const ev = (title: string, hour: number): CalendarEvent => ({
  title,
  start: `2026-11-12T${String(hour).padStart(2, "0")}:00:00Z`,
  end: `2026-11-12T${String(hour + 1).padStart(2, "0")}:00:00Z`,
  allDay: false,
  ec: false,
});
const reader = (events: CalendarEvent[]): CalendarReader => async () => ok(events);
const notConnected: CalendarReader = async () => err({ code: "not_connected", message: "not connected" });
const down: CalendarReader = async () => err({ code: "network", message: "Couldn't reach Google Calendar" });

describe("reading several calendars (#137)", () => {
  it("reads every account, tags each event with its calendar, in time order", async () => {
    const r = await readAccounts({ personal: reader([ev("Dentist", 15)]), noisysource: reader([ev("Client call", 10)]) }, DAY, undefined);
    expect(r.ok && r.value.read).toEqual(["personal", "noisysource"]);
    expect(r.ok && r.value.events.map((e) => [e.title, e.account])).toEqual([
      ["Client call", "noisysource"],
      ["Dentist", "personal"],
    ]);
    expect(r.ok && r.value.unread).toEqual([]);
  });

  it("reports an account it couldn't read, instead of skipping it", async () => {
    const r = await readAccounts({ personal: reader([ev("Dentist", 15)]), noisysource: notConnected }, DAY, undefined);
    expect(r.ok && r.value.unread).toEqual([{ account: "noisysource", code: "not_connected" }]);
    expect(r.ok && r.value.events).toHaveLength(1);
  });

  it("only the account asked for", async () => {
    const r = await readAccounts({ personal: reader([ev("Dentist", 15)]), noisysource: reader([ev("Client call", 10)]) }, DAY, "noisysource");
    expect(r.ok && r.value.events.map((e) => e.title)).toEqual(["Client call"]);
  });

  it("fails when nothing could be read, with a real failure over not connected", async () => {
    expect(await readAccounts({ personal: notConnected, noisysource: down }, DAY, undefined)).toEqual(err({ code: "network", message: "Couldn't reach Google Calendar" }));
    const none = await readAccounts({}, DAY, "noisysource");
    expect(!none.ok && none.error.message).toContain("npm run calendar:connect -- noisysource");
  });

  it("keeps the first connection's file for personal", () => {
    expect(calendarTokensPath("data/google-tokens.json", "personal")).toBe("data/google-tokens.json");
    expect(calendarTokensPath("data/google-tokens.json", "noisysource")).toBe("data/google-calendar-noisysource.json");
  });
});

describe("what the brain is told (#137)", () => {
  it("names both calendars and tags each event", () => {
    const text = calendarForBrain(DAY, [{ ...ev("Client call", 10), account: "noisysource" }, { ...ev("Dentist", 15), account: "personal" }], TZ, { read: ["personal", "noisysource"], unread: [] });
    expect(text).toContain("Their Google Calendars (personal and noisysource) for Thursday 12 November 2026");
    expect(text).toContain("- [noisysource] Thursday 12 November 2026, 10:00–11:00: Client call");
    expect(text).toContain("- [personal] Thursday 12 November 2026, 15:00–16:00: Dentist");
  });

  it("says plainly which calendar it couldn't see", () => {
    const text = calendarForBrain(DAY, [ev("Dentist", 15)], TZ, { read: ["personal"], unread: [{ account: "noisysource", code: "not_connected" }] });
    expect(text).toContain("Their personal Google Calendar for");
    expect(text).toContain("The noisysource calendar isn't connected to Jarvis yet");
    expect(text).not.toContain("[personal]");
  });

  it("one calendar, as before", () => {
    expect(calendarForBrain(DAY, [], TZ)).toContain("Their personal Google Calendar for Thursday 12 November 2026");
  });
});

describe("adding to a chosen calendar (#137)", () => {
  const isEc = () => false;

  it("personal by default; noisysource when asked; nothing else", () => {
    expect(checkCreateRequest({ title: "Lunch", date: "2026-11-13", start: "13:00" }, "2026-11-12", isEc)).toEqual(ok({ title: "Lunch", date: "2026-11-13", start: "13:00", end: "14:00" }));
    expect(checkCreateRequest({ title: "Client call", date: "2026-11-13", start: "10:00", account: "noisysource" }, "2026-11-12", isEc)).toEqual(
      ok({ title: "Client call", date: "2026-11-13", start: "10:00", end: "11:00", account: "noisysource" }),
    );
    expect(checkCreateRequest({ title: "X", date: "2026-11-13", start: "10:00", account: "work" }, "2026-11-12", isEc)).toEqual(err("unknown calendar"));
  });

  it("the card and the path say which calendar", () => {
    const p = { title: "Client call", date: "2026-11-13", start: "10:00", end: "11:00", account: "noisysource" as const };
    expect(proposalLabel(p, "2026-11-12")).toBe("“Client call”, Friday 13 November, 10:00–11:00, on the noisysource calendar");
    expect(proposalPathLabel(p)).toMatch(/^noisysource · /);
  });

  it("adds it with that account's connection", async () => {
    const asked: string[] = [];
    const create = makeGoogleEventCreator({
      accessToken: async (account) => {
        asked.push(account);
        return ok("tok");
      },
      timeZone: TZ,
      fetch: (async () => new Response(JSON.stringify({ summary: "Client call", start: { dateTime: "2026-11-13T10:00:00Z" }, end: { dateTime: "2026-11-13T11:00:00Z" } }), { status: 200 })) as unknown as typeof fetch,
    });
    await create({ title: "Client call", date: "2026-11-13", start: "10:00", end: "11:00", account: "noisysource" });
    await create({ title: "Lunch", date: "2026-11-13", start: "13:00", end: "14:00" });
    expect(asked).toEqual(["noisysource", "personal"]);
  });
});

describe("the calendar_read tool across accounts (#137)", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "opaque" } };
  const scripted = (responses: LlmResponse[]) => {
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      const response = responses[Math.min(i++, responses.length - 1)];
      if (!response) throw new Error("no response");
      return ok(response);
    };
    return { llm, requests };
  };
  const call = (input: Record<string, unknown>): LlmToolCall => ({ id: "t1", name: "calendar_read", input: { from: "2026-11-12", to: "2026-11-12", ...input } });
  const run = async (input: Record<string, unknown>, accounts: CalendarReaders) => {
    const { llm, requests } = scripted([{ ...common, kind: "tool_calls", text: "", calls: [call(input)] }, { ...common, kind: "text", text: "Done." }]);
    const steps: PathStep[] = [];
    const read = accounts.personal ?? notConnected;
    await makeBareAnswerer({ llm, tools: true, calendar: { read, accounts, timeZone: TZ, now: () => NOW } })({
      context: personal,
      question: "What's on today?",
      history: [],
      memories: [],
      now: NOW,
      onStep: (s) => steps.push(s),
    });
    const second = requests[1]?.messages.at(-1);
    const content = JSON.stringify(second);
    return { steps, content };
  };

  it("reads both by default and the step says what it couldn't see", async () => {
    const { steps, content } = await run({}, { personal: reader([ev("Dentist", 15)]), noisysource: notConnected });
    expect(steps[0]).toMatchObject({ name: "calendar_read", ok: true, result: "1 event (noisysource: not connected)" });
    expect(content).toContain("noisysource calendar isn't connected");
  });

  it("reads just the one asked for, and names it in the path", async () => {
    const { steps, content } = await run({ account: "noisysource" }, { personal: reader([ev("Dentist", 15)]), noisysource: reader([ev("Client call", 10)]) });
    expect(steps[0]).toMatchObject({ ok: true, args: "noisysource · Thu 12 Nov" });
    expect(content).toContain("Client call");
    expect(content).not.toContain("Dentist");
  });

  it("an account that isn't connected, asked for by name, is said plainly", async () => {
    const { steps, content } = await run({ account: "noisysource" }, { personal: reader([]) });
    expect(steps[0]).toMatchObject({ ok: false, error: "not_connected" });
    expect(content).toContain("npm run calendar:connect -- noisysource");
  });

  it("refuses an unknown calendar", async () => {
    const { steps } = await run({ account: "work" }, { personal: reader([]) });
    expect(steps[0]).toMatchObject({ ok: false, error: "refused: unknown calendar" });
  });
});
