// Creating calendar events (Reach 2), only with Renato's explicit OK.
//
// 1. The brain (Claude) asks with the calendar_create tool. Code checks the
//    request (title, a real date, sensible times, never EC work) and keeps it
//    as a pending proposal, under a random id, for a few minutes.
// 2. The page shows the proposal as a card with "Add it" / "Don't add".
//    Nothing is written to the calendar until Renato presses "Add it".
// 3. POST /calendar/confirm creates the event through Google's API (the one
//    non-GET calendar call), and the confirmation is built from Google's
//    answer, never from the model's words.
//
// Logs carry fixed words and counts only: never a title.

import { randomBytes } from "node:crypto";
import { err, ok, type Result } from "../result.js";
import type { LlmTool } from "../llm/types.js";
import { dayLabel, shortRangeLabel } from "./dates.js";
import { addDays, localDate, MAX_DAYS_AHEAD, type CalendarError } from "./read.js";

export const CALENDAR_CREATE_TOOL: LlmTool = {
  name: "calendar_create",
  description:
    "Propose adding one event to their personal Google Calendar. Nothing is added by this call: the app shows them the event and only their explicit yes adds it. Give a date and either a start and end time, or all_day.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The event's title, short, in their words" },
      date: { type: "string", description: "The day, YYYY-MM-DD, in their time zone" },
      start: { type: "string", description: "Start time, HH:MM (24-hour). Leave empty for an all-day event." },
      end: { type: "string", description: "End time, HH:MM (24-hour). Leave empty for one hour after the start." },
      all_day: { type: "boolean", description: "True for an all-day event" },
    },
    required: ["title", "date"],
    additionalProperties: false,
  },
};

/** An event waiting for Renato's OK. Times are local, in the configured time zone. */
export type Proposal = {
  readonly title: string;
  /** YYYY-MM-DD */
  readonly date: string;
  /** "HH:MM", both or neither (all day). */
  readonly start?: string;
  readonly end?: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TITLE = 120;

const minutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Checks the brain's calendar_create request. `isEc`: the local EC precheck,
 * so EC work is never put on the calendar by Jarvis (it's Kiro's).
 */
export const checkCreateRequest = (value: unknown, today: string, isEc: (text: string) => boolean): Result<Proposal, string> => {
  if (typeof value !== "object" || value === null) return err("not an object");
  const { title, date, start, end, all_day: allDay } = value as Record<string, unknown>;
  if (typeof title !== "string") return err("no title");
  const cleanTitle = [...title]
    .map((c) => (c.charCodeAt(0) < 32 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (cleanTitle === "") return err("no title");
  if (cleanTitle.length > MAX_TITLE) return err("title too long");
  if (isEc(cleanTitle)) return err("EC work is for Kiro");
  if (typeof date !== "string" || !DATE.test(date) || addDays(date, 0) !== date) return err("date isn't a real YYYY-MM-DD");
  if (date < today) return err("date is in the past");
  if (date > addDays(today, MAX_DAYS_AHEAD)) return err("date is too far ahead");
  const startText = typeof start === "string" ? start.trim() : "";
  const endText = typeof end === "string" ? end.trim() : "";
  if (allDay === true || (startText === "" && endText === "")) {
    if (allDay !== true) return err("give a start time, or all_day");
    return ok({ title: cleanTitle, date });
  }
  if (!TIME.test(startText)) return err("start isn't HH:MM");
  if (endText !== "" && !TIME.test(endText)) return err("end isn't HH:MM");
  const endTime = endText === "" ? hhmm(Math.min(minutes(startText) + 60, 23 * 60 + 59)) : endText;
  if (minutes(endTime) <= minutes(startText)) return err("end isn't after start");
  return ok({ title: cleanTitle, date, start: startText, end: endTime });
};

/** For the card and the brain: "“Work”, Wednesday 11 November, 21:00–22:00". */
export const proposalLabel = (p: Proposal, today: string): string =>
  `“${p.title}”, ${dayLabel(p.date, today)}, ${p.start && p.end ? `${p.start}–${p.end}` : "all day"}`;

/** For the path line: dates and times only, never the title. */
export const proposalPathLabel = (p: Proposal): string => `${shortRangeLabel({ from: p.date, to: p.date })}${p.start && p.end ? ` ${p.start}–${p.end}` : " all day"}`;

/** Google's event body. Local times with the time zone, so Google works out the offset (summer and winter). */
export const googleEventBody = (p: Proposal, timeZone: string): Record<string, unknown> =>
  p.start && p.end
    ? { summary: p.title, start: { dateTime: `${p.date}T${p.start}:00`, timeZone }, end: { dateTime: `${p.date}T${p.end}:00`, timeZone } }
    : { summary: p.title, start: { date: p.date }, end: { date: addDays(p.date, 1) } };

/** What Google says it created. */
export type CreatedEvent = { readonly title: string; readonly start: string; readonly end: string; readonly allDay: boolean };

export type EventCreator = (p: Proposal) => Promise<Result<CreatedEvent, CalendarError>>;

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Creates one event in the primary calendar: the only non-GET calendar call, and only after the OK. */
export const makeGoogleEventCreator = (deps: {
  readonly accessToken: () => Promise<Result<string, CalendarError>>;
  readonly timeZone: string;
  readonly fetch?: typeof fetch;
}): EventCreator => {
  const doFetch = deps.fetch ?? fetch;
  return async (p) => {
    const token = await deps.accessToken();
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await doFetch(`${EVENTS_URL}?fields=summary,start,end`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(googleEventBody(p, deps.timeZone)),
      });
    } catch {
      return err({ code: "network", message: "Couldn't reach Google Calendar" });
    }
    if (res.status === 401 || res.status === 403)
      return err({ code: "auth", message: `Google Calendar refused to add it (${res.status}): connect again with write access (CALENDAR_WRITE=on npm run calendar:connect), then restart Jarvis` });
    if (!res.ok) return err({ code: "api", message: `Google Calendar answered ${res.status}` });
    const body = (await res.json().catch(() => ({}))) as { summary?: unknown; start?: { date?: unknown; dateTime?: unknown }; end?: { date?: unknown; dateTime?: unknown } };
    const start = typeof body.start?.dateTime === "string" ? body.start.dateTime : typeof body.start?.date === "string" ? body.start.date : "";
    const end = typeof body.end?.dateTime === "string" ? body.end.dateTime : typeof body.end?.date === "string" ? body.end.date : "";
    if (start === "" || end === "") return err({ code: "api", message: "Google Calendar's answer had no start or end" });
    return ok({ title: typeof body.summary === "string" ? body.summary : p.title, start, end, allDay: typeof body.start?.dateTime !== "string" });
  };
};

const time = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** The confirmation, built from Google's answer: "Added “Work” on Wednesday 11 November, 21:00–22:00." */
export const addedSentence = (e: CreatedEvent, timeZone: string, today: string): string => {
  const day = e.allDay ? e.start : localDate(new Date(e.start), timeZone);
  return `Added “${e.title}” on ${dayLabel(day, today)}, ${e.allDay ? "all day" : `${time(e.start, timeZone)}–${time(e.end, timeZone)}`}.`;
};

/** Proposals waiting for an answer: in memory only, single use, gone after `ttlMs`. */
export type PendingProposals = {
  readonly add: (p: Proposal) => string;
  /** The proposal, removed so it can't be used twice; undefined if unknown or expired. */
  readonly take: (id: string) => Proposal | undefined;
};

export const makePendingProposals = (deps: { readonly now?: () => number; readonly ttlMs?: number; readonly newId?: () => string } = {}): PendingProposals => {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 15 * 60_000;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const waiting = new Map<string, { readonly proposal: Proposal; readonly until: number }>();
  const sweep = (): void => {
    for (const [id, w] of waiting) if (w.until <= now()) waiting.delete(id);
  };
  return {
    add: (proposal) => {
      sweep();
      const id = newId();
      waiting.set(id, { proposal, until: now() + ttl });
      return id;
    },
    take: (id) => {
      sweep();
      const w = waiting.get(id);
      waiting.delete(id);
      return w?.proposal;
    },
  };
};
