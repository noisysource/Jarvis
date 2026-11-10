// What a turn means for the calendar (#100, #102), decided in code from the
// question and the conversation so far. Pure.
//
// - A calendar question: read for the days it names.
// - A follow-up that names a day ("what about tomorrow?", "and Friday?")
//   while the conversation is about the calendar: read for that day.
// - A bare "yes" after Jarvis offered to check or try again, or a bare
//   "try again": read again for the last calendar question.
// - "Did you check?", "have you tried?": read now, and answer from what
//   really happened before, not from what the model says it did.
//
// Whether an earlier reply came from a real read is known from its opening
// sentence, "Looking at <day>.", which only code writes, and only after a
// read that worked (the honesty guard drops it from a model otherwise).

import { resolveDatePhrase } from "./dates.js";
import { mightBeAboutCalendar } from "./read.js";

export type ChatTurn = { readonly role: "user" | "assistant"; readonly text: string };

export type CalendarIntent = {
  /** The question whose days are read: this one, or the earlier one it refers to. */
  readonly ask: string;
  /** They asked whether Jarvis checked: `before` is whether the last reply came from a real read. */
  readonly didCheck?: { readonly before: boolean };
};

/** The opening of a reply that came from a real read. */
export const READ_MARK = /^Looking at (?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d/;

/** A bare yes, or "try again": nothing else in the message. */
const isBareRetry = (question: string): boolean =>
  /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|go on|do it|do that|again|retry|(?:try|check|look|read)(?: it| that)? again|one more time)[\s,.!]*){1,3}$/i.test(
    question.trim(),
  );

/** "Did you check?", "have you honestly tried to reach the calendar?", "are you sure you looked?" */
export const asksWhatJarvisDid = (question: string): boolean =>
  /\b(?:did|have|had) you (?:(?:really|actually|honestly|even|just|already) )*(?:check(?:ed)?|look(?:ed)?|tr(?:y|ied)|read|access(?:ed)?|reach(?:ed)?|open(?:ed)?)\b/i.test(question) ||
  /\bare you sure (?:that )?you(?:'ve| have)? (?:check|look|read|tr)/i.test(question);

/** The reply talked about the calendar: a real read, an offer to check, or a failure to reach it. */
const aboutCalendar = (reply: string): boolean => READ_MARK.test(reply) || /\b(?:calendar|agenda|diary)\b/i.test(reply);

/** A date to resolve phrases against when only "does it name a day?" matters. */
const ANY_DAY = "2026-01-01";

/** The last question the conversation asked of the calendar, newest first, if any. */
const lastCalendarAsk = (history: readonly ChatTurn[]): string | undefined => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role !== "user") continue;
    const intent = calendarIntent(turn.text, history.slice(0, i));
    if (intent && !intent.didCheck) return intent.ask;
  }
  return undefined;
};

export const calendarIntent = (question: string, history: readonly ChatTurn[]): CalendarIntent | undefined => {
  const lastAssistant = [...history].reverse().find((t) => t.role === "assistant")?.text ?? "";
  const lastUser = [...history].reverse().find((t) => t.role === "user")?.text;

  // "Did you check?": read now for the last calendar question, and say truthfully whether it was read before.
  if (asksWhatJarvisDid(question)) {
    const named = resolveDatePhrase(question, ANY_DAY) !== undefined;
    const ask = named ? question : lastCalendarAsk(history);
    const relevant = /\b(?:calendar|agenda|diary|schedule)\b/i.test(question) || aboutCalendar(lastAssistant) || (lastUser !== undefined && mightBeAboutCalendar(lastUser));
    return ask !== undefined && relevant ? { ask, didCheck: { before: READ_MARK.test(lastAssistant) } } : undefined;
  }

  if (mightBeAboutCalendar(question)) return { ask: question };

  // A follow-up that names a day, while the conversation is about the calendar.
  if (resolveDatePhrase(question, ANY_DAY) !== undefined) {
    const inCalendarTalk = aboutCalendar(lastAssistant) || (lastUser !== undefined && mightBeAboutCalendar(lastUser));
    return inCalendarTalk ? { ask: question } : undefined;
  }

  // A bare "yes" to an offer to check or try again, or a bare "try again".
  if (!isBareRetry(question)) return undefined;
  const offered = /\b(?:try|check|look|read)(?: it| that)? again\b|\bretry\b|\banother (?:go|try|look)\b|\b(?:shall|should|want me to|would you like me to|do you want me to) (?:I )?(?:check|look|read|have a look)\b/i.test(lastAssistant);
  const asksAgain = /\bagain\b|\bretry\b|\bone more time\b/i.test(question);
  if (!offered && !asksAgain) return undefined;
  const ask = lastCalendarAsk(history);
  return ask !== undefined && (aboutCalendar(lastAssistant) || (lastUser !== undefined && mightBeAboutCalendar(lastUser))) ? { ask } : undefined;
};
