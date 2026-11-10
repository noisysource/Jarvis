// Date phrases, resolved in code (#100): "tomorrow", "Friday", "next week",
// "12 November", "12/11"… become days in the person's time zone before any
// model is asked, so a small model never has to count days. Only when
// nothing here matches does the brain's structured request decide.
//
// Pure: everything is worked out from `today` (YYYY-MM-DD where they are).

import { addDays, type DayRange } from "./read.js";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// Short forms only where they aren't also words ("sat", "sun", "wed").
const WEEKDAY_ALT = "sunday|mon(?:day)?|tue(?:s|sday)?|wednesday|thu(?:r|rs|rsday)?|fri(?:day)?|saturday";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

const pad = (n: number): string => String(n).padStart(2, "0");

/** A real date as YYYY-MM-DD, or undefined ("31 February"). */
const realDate = (year: number, month: number, day: number): string | undefined => {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : undefined;
};

/** How far back a date with no year may be before it means next year. */
const RECENT_DAYS = 31;

/** A day and month with no year: this year, unless that's more than a month ago, then next year. */
const withoutYear = (month: number, day: number, today: string): string | undefined => {
  const year = Number(today.slice(0, 4));
  const thisYear = realDate(year, month, day);
  if (thisYear !== undefined && thisYear >= addDays(today, -RECENT_DAYS)) return thisYear;
  return realDate(year + 1, month, day) ?? thisYear;
};

/** The next day that's this weekday: today counts, unless `after` (for "next Friday"). */
const nextWeekday = (weekday: number, today: string, after: boolean): string => {
  const ahead = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, ahead === 0 && after ? 7 : ahead);
};

/** Monday of the week `today` is in. */
const mondayOf = (today: string): string => addDays(today, -((weekdayOf(today) + 6) % 7));

type Rule = { readonly pattern: RegExp; readonly days: (match: RegExpExecArray, today: string) => DayRange | undefined };

const one = (date: string | undefined): DayRange | undefined => (date === undefined ? undefined : { from: date, to: date });
const monthNumber = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const fullYear = (y: string | undefined): number | undefined => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * In order: a phrase is taken out of the text once matched, so "the day
 * after tomorrow" isn't also "tomorrow", and "next week" isn't "week".
 */
const RULES: readonly Rule[] = [
  { pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/, days: (m) => one(realDate(Number(m[1]), Number(m[2]), Number(m[3]))) },
  // 12 to 14 November, 12–14 Nov 2026
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|until|till|through|-|–)\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_ALT})\\b\\.?(?:,?\\s+(\\d{4}))?`, "i"),
    days: (m, today) => {
      const month = monthNumber(m[3] ?? "");
      const year = fullYear(m[4]);
      const to = year ? realDate(year, month, Number(m[2])) : withoutYear(month, Number(m[2]), today);
      const from = to === undefined ? undefined : realDate(Number(to.slice(0, 4)), month, Number(m[1]));
      return from !== undefined && to !== undefined && from <= to ? { from, to } : undefined;
    },
  },
  // Monday to Wednesday: from the next Monday (today included) to the Wednesday after it
  {
    pattern: new RegExp(`\\b(${WEEKDAY_ALT})\\s*(?:to|until|till|through|-|–)\\s*(${WEEKDAY_ALT})\\b`, "i"),
    days: (m, today) => {
      const index = (name: string) => WEEKDAYS.findIndex((w) => w.startsWith(name.slice(0, 3).toLowerCase()));
      const [a, b] = [index(m[1] ?? ""), index(m[2] ?? "")];
      if (a === -1 || b === -1) return undefined;
      const from = nextWeekday(a, today, false);
      return { from, to: nextWeekday(b, from, false) };
    },
  },
  // 12 November, 12th of Nov 2026
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_ALT})\\b\\.?(?:,?\\s+(\\d{4}))?`, "i"),
    days: (m, today) => {
      const year = fullYear(m[3]);
      return one(year ? realDate(year, monthNumber(m[2] ?? ""), Number(m[1])) : withoutYear(monthNumber(m[2] ?? ""), Number(m[1]), today));
    },
  },
  // November 12, Nov 12th, 2026
  {
    pattern: new RegExp(`\\b(${MONTH_ALT})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!:)(?:,?\\s+(\\d{4}))?`, "i"),
    days: (m, today) => {
      const year = fullYear(m[3]);
      return one(year ? realDate(year, monthNumber(m[1] ?? ""), Number(m[2])) : withoutYear(monthNumber(m[1] ?? ""), Number(m[2]), today));
    },
  },
  // 12.11.2026 (with dots, only with a year: "3.5" is a number)
  { pattern: /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/, days: (m) => one(realDate(Number(m[3]), Number(m[2]), Number(m[1]))) },
  // 12/11, 12/11/2026, 12/11/26: day first, as in Portugal
  {
    pattern: /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/,
    days: (m, today) => {
      const year = fullYear(m[3]);
      return one(year ? realDate(year, Number(m[2]), Number(m[1])) : withoutYear(Number(m[2]), Number(m[1]), today));
    },
  },
  { pattern: /\b(?:the\s+)?day\s+after\s+tomorrow\b/i, days: (_m, today) => one(addDays(today, 2)) },
  { pattern: /\b(?:the\s+)?day\s+before\s+yesterday\b/i, days: (_m, today) => one(addDays(today, -2)) },
  { pattern: /\btomorrow\b/i, days: (_m, today) => one(addDays(today, 1)) },
  { pattern: /\byesterday\b/i, days: (_m, today) => one(addDays(today, -1)) },
  { pattern: /\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/i, days: (_m, today) => one(today) },
  // The weekend of next week
  {
    pattern: /\bnext\s+weekend\b/i,
    days: (_m, today) => {
      const saturday = addDays(mondayOf(today), 12);
      return { from: saturday, to: addDays(saturday, 1) };
    },
  },
  // This weekend: the coming Saturday and Sunday (what's left of it, on a Sunday)
  {
    pattern: /\b(?:this\s+|the\s+|at\s+the\s+)?weekend\b/i,
    days: (_m, today) => {
      const sunday = addDays(mondayOf(today), 6);
      const saturday = addDays(sunday, -1);
      return { from: today > saturday ? today : saturday, to: sunday };
    },
  },
  // Next week: Monday to Sunday
  {
    pattern: /\bnext\s+week\b/i,
    days: (_m, today) => {
      const monday = addDays(mondayOf(today), 7);
      return { from: monday, to: addDays(monday, 6) };
    },
  },
  // This week: today to Sunday
  { pattern: /\b(?:this|the\s+rest\s+of\s+(?:this|the))\s+week\b/i, days: (_m, today) => ({ from: today, to: addDays(mondayOf(today), 6) }) },
  // Friday, on Friday, this Friday: the next one, today included. "Next Friday": the next one after today.
  {
    pattern: new RegExp(`\\b(next\\s+)?(${WEEKDAY_ALT})\\b`, "i"),
    days: (m, today) => {
      const weekday = WEEKDAYS.findIndex((w) => w.startsWith((m[2] ?? "").slice(0, 3).toLowerCase()));
      return weekday === -1 ? undefined : one(nextWeekday(weekday, today, m[1] !== undefined));
    },
  },
];

/**
 * The days a question names, or undefined when it names none this can
 * read. Several phrases ("Monday to Wednesday", "today and tomorrow") give
 * the span from the first to the last.
 * @param today YYYY-MM-DD where the person is
 */
export const resolveDatePhrase = (question: string, today: string): DayRange | undefined => {
  let text = question;
  const found: DayRange[] = [];
  for (const rule of RULES) {
    for (let guard = 0; guard < 4; guard += 1) {
      const match = rule.pattern.exec(text);
      if (!match) break;
      const days = rule.days(match, today);
      if (days) found.push(days);
      text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
    }
  }
  if (found.length === 0) return undefined;
  return { from: found.map((d) => d.from).sort()[0] ?? today, to: found.map((d) => d.to).sort().at(-1) ?? today };
};

const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LONG_MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Wednesday 11 November", with the year only when it isn't this year. */
export const dayLabel = (date: string, today: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  const year = date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${y}`;
  return `${LONG_DAY[weekdayOf(date)]} ${d} ${LONG_MONTH[(m ?? 1) - 1]}${year}`;
};

/** The days read, worded by code: "Wednesday 11 November", "Monday 16 to Sunday 22 November". */
export const rangeLabel = (range: DayRange, today: string): string => {
  if (range.from === range.to) return dayLabel(range.from, today);
  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  const from = sameMonth ? `${LONG_DAY[weekdayOf(range.from)]} ${Number(range.from.slice(8))}` : dayLabel(range.from, today);
  return `${from} to ${dayLabel(range.to, today)}`;
};

/** Short, for the answer's path line: "Wed 11 Nov", "Mon 16 – Sun 22 Nov". */
export const shortRangeLabel = (range: DayRange): string => {
  const short = (date: string, month = true): string =>
    `${SHORT_DAY[weekdayOf(date)]} ${Number(date.slice(8))}${month ? ` ${(LONG_MONTH[Number(date.slice(5, 7)) - 1] ?? "").slice(0, 3)}` : ""}`;
  if (range.from === range.to) return short(range.from);
  return `${short(range.from, range.from.slice(0, 7) !== range.to.slice(0, 7))} – ${short(range.to)}`;
};

/** The sentence the answer opens with, so the day that was read is always visible. */
export const readSentence = (range: DayRange, today: string): string => `Looking at ${rangeLabel(range, today)}.`;
