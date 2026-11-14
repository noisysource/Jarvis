// #177: the morning brief, ready without asking.

import { describe, expect, it } from "vitest";
import { groupsByWords } from "../src/answer/tool-groups.js";
import type { BriefSources } from "../src/brief.js";
import type { CalendarEvent } from "../src/calendar/read.js";
import { msUntil } from "../src/introspection.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makeMorningBriefs, parseBriefAt, startDailyAt, type MorningBrief } from "../src/morning.js";
import { err, ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import type { Deps } from "../src/types.js";
import { dayLabel } from "../src/web/morning.js";

const TZ = "Europe/Lisbon";
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const text = (t: string): LlmResponse => ({ servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" }, kind: "text", text: t });

const sources: BriefSources = {
  calendar: {
    readers: { personal: async () => ok([{ title: "School run", start: "2026-11-16T08:45:00+00:00", end: "2026-11-16T09:15:00+00:00", allDay: false, ec: false } as CalendarEvent]) },
    timeZone: TZ,
  },
};

const setup = (clock: string, reply: LlmResponse | "fail" = text("Good morning. School run at 8:45; nothing failing.")) => {
  const kept = new Map<string, MorningBrief>();
  const requests: LlmRequest[] = [];
  let now = new Date(clock);
  const llm: LlmCall = async (r) => {
    requests.push(r);
    return reply === "fail" ? err({ kind: "network", message: "down", retryable: true }) : ok(reply);
  };
  const briefs = makeMorningBriefs({
    sources: async () => sources,
    llm,
    store: { read: async (day) => kept.get(day), write: async (b) => void kept.set(b.day, b) },
    timeZone: TZ,
    at: { hour: 7, minute: 30 },
    isEc: () => false,
    now: () => now,
    userName: "Renato",
  });
  return { briefs, kept, requests, setNow: (c: string) => (now = new Date(c)) };
};

describe("the morning brief", () => {
  it("is gathered, worded once by Claude, and kept for the day", async () => {
    const { briefs, kept, requests } = setup("2026-11-16T07:30:00Z");
    const made = await briefs.prepare();
    expect(made).toEqual(ok({ day: "2026-11-16", text: "Good morning. School run at 8:45; nothing failing.", summary: "1 event", preparedAt: "2026-11-16T07:30:00.000Z" }));
    expect(kept.get("2026-11-16")?.text).toContain("School run");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toContain("Renato's morning brief");
    expect(requests[0]?.tools).toBeUndefined();
    const asked = requests[0]?.messages[0];
    expect(asked && "text" in asked ? asked.text : "").toContain("School run");
  });

  it("before BRIEF_AT there's none; after it, the first look prepares one, once", async () => {
    const { briefs, requests, setNow } = setup("2026-11-16T06:00:00Z");
    expect(await briefs.today()).toBeUndefined();
    expect(requests).toHaveLength(0);
    setNow("2026-11-16T09:10:00Z");
    const [a, b] = await Promise.all([briefs.today(), briefs.today()]);
    expect(a?.day).toBe("2026-11-16");
    expect(b?.day).toBe("2026-11-16");
    expect(requests).toHaveLength(1);
    expect((await briefs.today())?.text).toContain("School run");
    expect(requests).toHaveLength(1);
  });

  it("if Claude can't word it, nothing is kept and it's tried again later", async () => {
    const { briefs, kept } = setup("2026-11-16T08:00:00Z", "fail");
    expect((await briefs.prepare()).ok).toBe(false);
    expect(await briefs.today()).toBeUndefined();
    expect(kept.size).toBe(0);
  });

  it("BRIEF_AT is a time of day; the schedule runs at it, his time", () => {
    expect(parseBriefAt("07:30")).toEqual({ hour: 7, minute: 30 });
    expect(parseBriefAt("7:05")).toEqual({ hour: 7, minute: 5 });
    expect(parseBriefAt("25:00")).toBeUndefined();
    // Lisbon is UTC in November: 06:00 → 07:30 is 90 minutes.
    expect(msUntil(new Date("2026-11-16T06:00:00Z"), TZ, 7, 30)).toBe(90 * 60_000);
    let asked: [number, number] | undefined;
    const stop = startDailyAt(async () => undefined, { timeZone: TZ, hour: 7, minute: 30, msUntil: (_n, _t, h, m) => ((asked = [h, m]), 60_000) });
    expect(asked).toEqual([7, 30]);
    stop();
  });

  it('"good morning" and "bom dia" ask for the brief', () => {
    expect(groupsByWords("Good morning Jarvis")).toContain("calendar");
    expect(groupsByWords("Bom dia!")).toContain("calendar");
  });
});

describe("on the page", () => {
  it("GET /brief/today gives the kept brief, or null", async () => {
    const brief: MorningBrief = { day: "2026-11-16", text: "Good morning.", summary: "1 event", preparedAt: "2026-11-16T07:30:00.000Z" };
    let have: MorningBrief | undefined = brief;
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const app = makeServer({ log, morningBrief: { prepare: async () => ok(brief), today: async () => have } } as unknown as Deps);
    const res = await app.request("/brief/today");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ brief });
    have = undefined;
    expect(await (await app.request("/brief/today")).json()).toEqual({ brief: null });
  });

  it("the card's title names the day", () => {
    expect(dayLabel("2026-11-16")).toBe("Monday 16 November");
  });
});
