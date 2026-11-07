// "What time is it" for prompts, in the configured time zone. Pure: the
// instant is passed in, so tests can fix the clock.

/** e.g. "Friday, 6 November 2026, 17:20 (Europe/Lisbon, GMT+0)". Summer time comes from Intl. */
export const formatNow = (now: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} (${timeZone}, ${get("timeZoneName")})`;
};

/** e.g. "6 Nov 2026", in the configured time zone. */
export const formatDay = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(date);
