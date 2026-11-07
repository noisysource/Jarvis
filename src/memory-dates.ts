// Dates for one-off memories (#71): "Remember Diniz has football tomorrow"
// becomes a fact that expires at the start of the day after the event, in
// the configured time zone (Lisbon). The date is worked out here, in code,
// from the words, not by the model. Pure: "now" is passed in.

import { foldWords } from "./memory-rules.js";

/** A calendar day, e.g. { year: 2026, month: 11, day: 8 }. */
export type Day = { readonly year: number; readonly month: number; readonly day: number };

export const formatDayIso = (d: Day): string =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

export const parseDayIso = (s: string): Day | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return check.getUTCMonth() === d.month - 1 && check.getUTCDate() === d.day ? d : undefined;
};

/** The calendar day it is at `now` in `timeZone`. */
export const dayIn = (now: Date, timeZone: string): Day => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
};

export const addDays = (d: Day, n: number): Day => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (d: Day): number => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();

const compare = (a: Day, b: Day): number => formatDayIso(a).localeCompare(formatDayIso(b));

/** The instant `day` starts (00:00) in `timeZone`. Handles summer time. */
export const startOfDay = (d: Day, timeZone: string): Date => {
  const guess = Date.UTC(d.year, d.month - 1, d.day);
  const offsetAt = (t: number): number => {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(t));
    const g = (type: string) => Number(p.find((x) => x.type === type)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - t;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
};

/** When a one-off memory about `event` expires: the start of the next day. */
export const expiryAfter = (event: Day, timeZone: string): Date => startOfDay(addDays(event, 1), timeZone);

// ---- reading a date from words ----

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  // Only abbreviations that aren't everyday words ("set", "mar", "out" are left out).
  jan: 1, feb: 2, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  fev: 2, abr: 4, ago: 8, dez: 12,
};

/** Portuguese weekdays that are also ordinals or nouns ("pela segunda vez", "uma quinta"). */
const AMBIGUOUS_PT_WEEKDAYS = new Set(["segunda", "terca", "quarta", "quinta", "sexta"]);
const PT_DAY_LEAD_INS = new Set(["na", "no", "a", "nesta", "esta", "desta", "proxima", "ate", "de", "para"]);

const NEXT_WORDS = new Set(["next", "proxima", "proximo"]);

/** The next `dayOfMonth` on or after today (this month if it hasn't passed, else next month). */
const nextDayOfMonth = (today: Day, dayOfMonth: number): Day | undefined => {
  for (let k = 0; k < 2; k += 1) {
    const month = ((today.month - 1 + k) % 12) + 1;
    const year = today.year + Math.floor((today.month - 1 + k) / 12);
    const candidate = parseDayIso(formatDayIso({ year, month, day: dayOfMonth }));
    if (candidate && compare(candidate, today) >= 0) return candidate;
  }
  return undefined;
};

/** A day and month: this year, or next year if it has already passed. */
const nextDayMonth = (today: Day, month: number, dayOfMonth: number, year?: number): Day | undefined => {
  const candidate = parseDayIso(formatDayIso({ year: year ?? today.year, month, day: dayOfMonth }));
  if (!candidate) return undefined;
  if (year !== undefined || compare(candidate, today) >= 0) return candidate;
  return parseDayIso(formatDayIso({ year: today.year + 1, month, day: dayOfMonth }));
};

/**
 * Finds the day an event is on, from the words, relative to `today`:
 * "today"/"hoje", "tomorrow"/"amanhã", "the day after tomorrow"/"depois de
 * amanhã", weekdays ("on Friday", "na sexta", "sexta-feira", "next
 * Friday"), and dates ("8 November 2026", "November 8", "12 de dezembro",
 * "on the 12th", "dia 12", "12/11"). The first match wins; undefined if
 * there's no date in the words.
 */
export const resolveEventDay = (text: string, today: Day): Day | undefined => {
  const words = foldWords(text);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? "";
    const next = words[i + 1];
    const prev = words[i - 1];

    if ((w === "day" && next === "after" && words[i + 2] === "tomorrow") || (w === "depois" && next === "de" && words[i + 2] === "amanha")) {
      return addDays(today, 2);
    }
    if (w === "tomorrow" || w === "amanha") return addDays(today, 1);
    if (w === "today" || w === "tonight" || w === "hoje") return today;

    const wd = WEEKDAYS[w];
    const readsAsDay =
      !AMBIGUOUS_PT_WEEKDAYS.has(w) || next === "feira" || (prev !== undefined && PT_DAY_LEAD_INS.has(prev));
    if (wd !== undefined && readsAsDay) {
      // "next Friday" / "próxima sexta" is the one after the coming one if today is Friday; otherwise the coming one.
      const ahead = (wd - weekday(today) + 7) % 7;
      const nextOne = prev !== undefined && NEXT_WORDS.has(prev);
      return addDays(today, ahead === 0 && nextOne ? 7 : ahead);
    }

    // Numbers: "8 November [2026]", "8 de novembro [de 2026]", "12/11[/2026]", "12th", "dia 12".
    const n = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w);
    if (n) {
      const dayNum = Number(n[1]);
      const afterDe = next === "de" ? words[i + 2] : next;
      const month = afterDe !== undefined ? MONTHS[afterDe] : undefined;
      if (month !== undefined) {
        const yearWordIndex = next === "de" ? i + 3 : i + 2;
        const yearWord = words[yearWordIndex] === "de" ? words[yearWordIndex + 1] : words[yearWordIndex];
        const year = yearWord && /^\d{4}$/.test(yearWord) ? Number(yearWord) : undefined;
        const d = nextDayMonth(today, month, dayNum, year);
        if (d) return d;
      }
      // "12/11" appears as "12", "11" after splitting; only take it when written with a slash.
      if (next !== undefined && /^\d{1,2}$/.test(next) && new RegExp(`\\b${dayNum}/${Number(next)}\\b`).test(text)) {
        const d = nextDayMonth(today, Number(next), dayNum);
        if (d) return d;
      }
      if (prev === "dia" || prev === "the" || /(st|nd|rd|th)$/.test(w)) {
        const d = nextDayOfMonth(today, dayNum);
        if (d) return d;
      }
    }

    // "November 8[, 2026]".
    const monthFirst = w === "may" ? undefined : MONTHS[w]; // "may 8" is more likely "I may…"; "8 May" still works
    if (monthFirst !== undefined && next && /^\d{1,2}(st|nd|rd|th)?$/.test(next)) {
      const dayNum = Number(next.replace(/\D/g, ""));
      const yearWord = words[i + 2];
      const d = nextDayMonth(today, monthFirst, dayNum, yearWord && /^\d{4}$/.test(yearWord) ? Number(yearWord) : undefined);
      if (d) return d;
    }
  }
  return undefined;
};

/** Words that make a memory about a particular day, so not a lasting fact. */
export const mentionsRelativeDay = (text: string): boolean => {
  const words = foldWords(text);
  return words.some((w, i) => w === "tomorrow" || w === "amanha" || w === "today" || w === "tonight" || w === "hoje" || (w === "esta" && words[i + 1] === "noite"));
};
