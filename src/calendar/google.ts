// The Google Calendar API, read-only (#100): the events of your primary
// (personal) calendar between two days. GET only. Only the fields Jarvis
// uses are asked for; the organiser's and invitees' addresses are used to
// spot EC work and never go further.

import { err, ok, type Result } from "../result.js";
import { startOfDay, addDays, toCalendarEvents, type CalendarError, type CalendarEvent, type DayRange, type GoogleEvent } from "./read.js";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const FIELDS = "items(summary,location,status,start,end,organizer/email,attendees(email,self,responseStatus))";
const MAX_EVENTS = 100;

export type CalendarReader = (range: DayRange, signal?: AbortSignal) => Promise<Result<CalendarEvent[], CalendarError>>;

export const eventsUrl = (range: DayRange, timeZone: string): string => {
  const url = new URL(EVENTS_URL);
  url.search = new URLSearchParams({
    timeMin: startOfDay(range.from, timeZone),
    timeMax: startOfDay(addDays(range.to, 1), timeZone),
    timeZone,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(MAX_EVENTS),
    fields: FIELDS,
  }).toString();
  return url.toString();
};

export const makeGoogleCalendarReader = (deps: {
  readonly accessToken: () => Promise<Result<string, CalendarError>>;
  readonly timeZone: string;
  readonly isEc: (event: GoogleEvent) => boolean;
  readonly fetch?: typeof fetch;
}): CalendarReader => {
  const doFetch = deps.fetch ?? fetch;
  return async (range, signal) => {
    const token = await deps.accessToken();
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await doFetch(eventsUrl(range, deps.timeZone), {
        method: "GET",
        headers: { authorization: `Bearer ${token.value}`, accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
    } catch {
      return err({ code: "network", message: "Couldn't reach Google Calendar" });
    }
    if (res.status === 401 || res.status === 403) return err({ code: "auth", message: `Google Calendar refused access (${res.status}): run npm run calendar:connect again` });
    if (!res.ok) return err({ code: "api", message: `Google Calendar answered ${res.status}` });
    const body = (await res.json().catch(() => ({}))) as { items?: unknown };
    const items = Array.isArray(body.items) ? (body.items as GoogleEvent[]) : [];
    return ok(toCalendarEvents(items, deps.isEc));
  };
};
