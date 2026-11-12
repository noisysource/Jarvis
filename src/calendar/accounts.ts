// Calendar accounts (#137): like Gmail, two Google accounts, "personal" and
// "noisysource", each connected separately (npm run calendar:connect -- <account>).
// A read covers every account asked for (all of them by default); each event
// says which calendar it's from. An account that can't be read is reported,
// never silently skipped, so Jarvis can say so.

import { err, ok, type Result } from "../result.js";
import type { CalendarReader } from "./google.js";
import type { CalendarError, CalendarEvent, DayRange } from "./read.js";

export const CALENDAR_ACCOUNTS = ["personal", "noisysource"] as const;
export type CalendarAccount = (typeof CALENDAR_ACCOUNTS)[number];
export const isCalendarAccount = (v: unknown): v is CalendarAccount => typeof v === "string" && (CALENDAR_ACCOUNTS as readonly string[]).includes(v);

/** Where an account's refresh token lives. "personal" keeps the original file, so the first connection still works. */
export const calendarTokensPath = (personalPath: string, account: CalendarAccount): string =>
  account === "personal" ? personalPath : `data/google-calendar-${account}.json`;

export type CalendarReaders = Readonly<Partial<Record<CalendarAccount, CalendarReader>>>;

export type AccountsRead = {
  readonly events: readonly CalendarEvent[];
  /** The accounts read, in order. */
  readonly read: readonly CalendarAccount[];
  /** The accounts that couldn't be read, and why (a code, safe to show). */
  readonly unread: readonly { readonly account: CalendarAccount; readonly code: CalendarError["code"] }[];
};

/**
 * Reads the days from each account asked for (all of them when `which` is
 * undefined), in parallel. Fails only when no account could be read: then
 * with the most useful error (a real failure over "not connected").
 */
export const readAccounts = async (readers: CalendarReaders, range: DayRange, which: CalendarAccount | undefined, signal?: AbortSignal): Promise<Result<AccountsRead, CalendarError>> => {
  const accounts = CALENDAR_ACCOUNTS.filter((a) => (which === undefined || a === which) && readers[a] !== undefined);
  if (accounts.length === 0)
    return err({ code: "not_connected", message: which ? `The ${which} calendar isn't connected: run npm run calendar:connect -- ${which}` : "No calendar is connected" });
  const results = await Promise.all(
    accounts.map(async (account) => {
      const reader = readers[account];
      return { account, result: reader ? await reader(range, signal) : err<CalendarError>({ code: "not_connected", message: "not connected" }) };
    }),
  );
  const read = results.filter((r) => r.result.ok).map((r) => r.account);
  const failed = results.flatMap((r) => (r.result.ok ? [] : [{ account: r.account, error: r.result.error }]));
  if (read.length === 0) {
    const worst = failed.find((f) => f.error.code !== "not_connected") ?? failed[0];
    return err(worst?.error ?? { code: "not_connected", message: "No calendar is connected" });
  }
  const events = results
    .flatMap((r) => (r.result.ok ? r.result.value.map((e) => ({ ...e, account: r.account })) : []))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return ok({ events, read, unread: failed.map((f) => ({ account: f.account, code: f.error.code })) });
};
