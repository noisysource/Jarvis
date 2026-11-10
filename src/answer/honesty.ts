// The honesty guard (#96): every sentence is checked in code before it's
// shown or spoken, whatever brain wrote it. Sentences that claim an action
// ("I've added it", "Done"), promise one ("I'll remind you", "I'll
// remember"), or claim to perceive the person ("you look tired") are
// dropped, unless a tool actually ran and succeeded in this turn. If
// nothing useful is left, the reply is "I can't do that yet."
//
// Pure apart from the callbacks it's given. Only categories and counts are
// ever logged, never text.

import { makeSentenceSplitter } from "../sentences.js";
import type { Logger } from "../types.js";

export type HonestyCategory = "claimed_action" | "promise" | "perception" | "tool_result";

/** What's said when the guard leaves nothing useful. */
export const CANT_YET = "I can't do that yet.";

/** The same, after an opening reaction: it flows on from it, and never as yes-then-no (#98). */
export const ACTUALLY_CANT_YET = "Actually, I can't do that yet.";

/** An opening that sounds like yes ("Sure.", "Okay.", "Of course."). */
const AFFIRMATIVE = /^(?:sure|okay|ok|of course|absolutely|certainly|got it|will do|no problem|right|alright|all right|yes|yeah|yep|definitely|on it|happy to|consider it)\b/i;

/**
 * The question asks Jarvis to do something (#98): an affirmative opening is
 * then held until the next sentence passes, so it's never "Sure." followed
 * by "I can't". Other questions keep the opening's speed.
 */
export const asksForAction = (question: string): boolean =>
  /\b(?:remind|remember|add|put|schedule|book|set|create|make|send|email|e-mail|text|message|call|ring|note|jot|write (?:down|it|that)|save|cancel|delete|remove|move|reschedule|order|buy|pay|track|keep track|let me know|tell me when|wake me|alarm|timer|calendar|reminder|invite|reply|forward|turn (?:on|off)|switch (?:on|off)|play)\b/i.test(question);

const ACTION_VERBS =
  "scheduled|created|sent|added|set(?: up)?|booked|saved|noted|written(?: (?:it|that) )?down|jotted|put|emailed|messaged|texted|reminded|cancell?ed|updated|deleted|removed|moved|ordered|paid|called|logged|recorded|stored|filed|shared|forwarded|replied|turned (?:on|off)|switched (?:on|off)|started|stopped|blocked|reserved|registered|signed (?:you )?up|made (?:a note|an? (?:event|appointment|reminder|note))|taken (?:a )?note|noted (?:it|that) down|got (?:it|that) (?:down|noted)";

const PATTERNS: readonly (readonly [HonestyCategory, RegExp])[] = [
  // "I've added it", "I have sent the email", "I just booked a table", "I went ahead and scheduled it"
  ["claimed_action", new RegExp(`\\bI(?:'ve| have|'ve just| have just| just| already| went ahead and)\\s+(?:also\\s+|now\\s+|just\\s+|already\\s+|gone ahead and\\s+)?(?:${ACTION_VERBS})\\b`, "i")],
  // "Done.", "All set!", "Noted: buy milk.", "Consider it done."
  ["claimed_action", /^(?:(?:okay|ok|sure|great|right|alright|perfect)[,!.]?\s+)?(?:done|all done|all set|noted|consider it done|you're all set|that's done|it's done)(?:\s*[.!]*$|\s*[:,—-])/i],
  // "It's done.", "That's booked for you." (only at the end: "it's done in ten minutes" is fine)
  [
    "claimed_action",
    /\b(?:it's|it is|that's|that is|it has been|that has been|it's all|that's all)\s+(?:now\s+)?(?:done|set|sorted|scheduled|booked|created|sent|added|saved|noted|confirmed|taken care of)(?:\s+(?:for you|now|then))?\s*[.!]*$/i,
  ],
  // "Your reminder is set for five", "The event has been created"
  [
    "claimed_action",
    /\b(?:your|the) (?:reminder|alarm|event|meeting|appointment|note|email|message|booking|reservation|invite|invitation)(?: is| has been|'s)\s+(?:now\s+|all\s+)?(?:set|scheduled|booked|created|sent|added|saved|noted|confirmed|in your calendar|on your calendar)\b(?![^.!?]*\?)/i,
  ],
  // "I'll remind you", "I will remember", "I'm going to keep track", "I'll let you know when", "I'll make sure to remind you"
  [
    "promise",
    /\bI(?:'ll| will|'m going to| am going to| shall)\s+(?:also\s+|definitely\s+|be sure to\s+|make sure to\s+|try to\s+|always\s+)?(?:remind|remember|keep track|keep an eye|keep (?:it|that|this|them) in mind|keep (?:a )?note|note (?:it|that|this) down|make a note|jot|let you know(?: (?:when|if|later|tomorrow|once|as soon)|(?=\s*[.!]*$))|tell you (?:when|if|later|tomorrow|once|as soon|at)|get back to you|follow up|check (?:back|in|on)|ping you|notify you|alert you|send|schedule|book|set (?:up |a |an |the |it|that|you)|add (?:it|that|this|the|a|an|to)|save|email|text you|message you|call you|look (?:it|that|into)|track)\b/i,
  ],
  // "I can remember that for you", "I can keep track of that", "I'll have it ready"
  ["promise", /\bI can (?:remember|keep track|remind you|keep (?:it|that|this) in mind|hold on to (?:it|that))\b/i],
  ["promise", /\b(?:remind|remember) (?:it|that|this)? ?for you\b|\bI'll have (?:it|that) (?:ready|done|sorted)\b/i],
  // "You look tired", "you sound stressed", "I can see you're busy", "from your voice"
  ["perception", /\byou(?:'re| are)?\s+(?:look|looking|sound|sounding)\b/i],
  ["perception", /\bI (?:can )?(?:see|hear|tell from your (?:voice|face|tone)|notice|noticed) (?:that )?you(?:'re| are| look| seem|r (?:face|voice|eyes|tone))\b/i],
  ["perception", /\b(?:in|from) your (?:voice|face|eyes|tone of voice|expression)\b/i],
];

// ---- claimed tool results (#102) ----
// What's on the calendar, or that it was checked, can only be said in a turn
// where calendar_read ran and worked.

/** Said when a claim about the calendar was dropped and the calendar can be read. */
export const NOT_CHECKED = "I haven't checked your calendar for that. Which day shall I look at?";
/** The same, when a read was tried this turn and failed. */
export const READ_FAILED = "I couldn't check your calendar just now.";
/** The same, when there's no calendar to read. */
export const NO_CALENDAR = "I can't see your calendar yet.";

const DAY = "(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day";
const CAL = "(?:calendar|schedule|diary|agenda)";
const CLOCK = "(?:\\d{1,2}(?::\\d\\d)?|noon|midnight|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|quarter)";

/** Honest ways to talk about the calendar: not a claim about what's on it. */
const HONEST_ABOUT_CALENDAR =
  /\b(?:can't|cannot|can not|couldn't|could not|unable|not able|haven't (?:checked|looked|read)|have not (?:checked|looked|read)|hadn't (?:checked|looked|read)|didn't (?:check|look|read)|isn't connected|not connected|don't know|not sure)\b/i;

/** Claims that name the calendar, events or a check: dropped in any turn. */
const TOOL_RESULT: readonly RegExp[] = [
  // "Your calendar is clear", "your schedule shows…", "your calendar has nothing"
  new RegExp(`\\byour ${CAL}\\b[^.!?]{0,40}\\b(?:is|looks|seems|appears|shows|has|says)\\b`, "i"),
  // "There's nothing on your calendar", "…in your diary"
  new RegExp(`\\b(?:on|in) your ${CAL}\\b`, "i"),
  // "No events", "you don't have any meetings"
  /\b(?:no|any|zero) (?:events?|meetings?|appointments?)\b/i,
  /\bnothing (?:is |else )?(?:scheduled|planned|booked)\b/i,
  // "You have one event from eight to nine", "a meeting at ten", "two appointments tomorrow"
  /\b(?:one|two|three|four|five|six|\d+|an?|a few|several|some) (?:events?|meetings?|appointments?)\b/i,
  // "I checked your calendar", "I did check", "I've checked"
  new RegExp(`\\bI(?:'ve| have| did|'ve just| have just| just)? ?(?:check(?:ed)?|looked (?:at|in|through)|had a look (?:at|in)|read|went through)\\b[^.!?]{0,30}\\b${CAL}\\b`, "i"),
  /\bI (?:did check|checked)\b|\bI(?:'ve| have)(?: just| already)? checked\b/i,
  // The sentence only code writes after a read that worked.
  new RegExp(`^Looking at ${DAY} \\d`),
];

/** Claims that only mean the calendar when the turn is about it: "you have X at ten", "you're free". */
const TOOL_RESULT_IN_CALENDAR_TALK: readonly RegExp[] = [
  new RegExp(`\\byou(?:'ve| have)(?: got)?\\b[^.!?]{1,60}\\b(?:at|from|until|till) ${CLOCK}\\b`, "i"),
  /\byou(?:'re| are)(?: completely| totally| all| pretty)? (?:free|busy|booked|available|clear)\b/i,
  new RegExp(`\\b(?:your|the) (?:day|morning|afternoon|evening|week|weekend|${DAY})\\b[^.!?]{0,20}\\b(?:is|looks|seems)\\b[^.!?]{0,20}\\b(?:clear|free|empty|open|busy|full|packed|quiet)\\b`, "i"),
  /\b(?:you(?:'ve| have)(?: got)?|there(?:'s| is)) nothing\b/i,
];

/** A statement about what's on the calendar, or about having checked it. Questions and honest "I can't" lines aren't. */
export const claimsToolResult = (sentence: string, calendarTalk = false): boolean => {
  const text = sentence.trim();
  if (text.endsWith("?") || HONEST_ABOUT_CALENDAR.test(text)) return false;
  return TOOL_RESULT.some((p) => p.test(text)) || (calendarTalk && TOOL_RESULT_IN_CALENDAR_TALK.some((p) => p.test(text)));
};

/** Which rule a sentence breaks, if any. `calendarTalk`: the turn is about the calendar. */
export const honestyCategory = (sentence: string, calendarTalk = false): HonestyCategory | undefined => {
  for (const [category, pattern] of PATTERNS) if (pattern.test(sentence)) return category;
  return claimsToolResult(sentence, calendarTalk) ? "tool_result" : undefined;
};

/** A reaction of one to three words ("Sure.", "Good question."): not something useful on its own. */
const isOnlyReaction = (sentence: string): boolean => sentence.trim().split(/\s+/).filter(Boolean).length <= 3;

export type HonestyResult = {
  /** The text to show, speak and remember. */
  readonly text: string;
  readonly dropped: Readonly<Record<HonestyCategory, number>>;
  /** Nothing useful was left, so it says {@link CANT_YET}. */
  readonly replaced: boolean;
};

/**
 * One turn's guard. Streamed text goes through `onText` (sentences that
 * pass come out of `onSentence`, in order); the answer's full text goes
 * through `finish`, which returns what's left. Without streaming, `finish`
 * alone checks the whole text.
 */
export const makeHonestyGuard = (deps: {
  /** Each sentence that passes, as soon as it's known (streaming). */
  readonly onSentence?: (sentence: string) => void;
  /** Cut a long first sentence at a clause once it's this long, as the voice does. */
  readonly firstClauseAfter?: number;
  /** The question: if it asks for an action, an affirmative opening waits for the next sentence (#98). */
  readonly question?: string;
  /** The turn is about the calendar: "you have X at ten" then counts as a claim about it (#102). */
  readonly calendarTalk?: boolean;
  /** The calendar can be read (CALENDAR=on): decides what's said when a claim about it is dropped. */
  readonly calendar?: boolean;
  readonly log?: Logger;
}) => {
  const holdYes = deps.question !== undefined && asksForAction(deps.question);
  const splitter = makeSentenceSplitter({ language: "en", ...(deps.firstClauseAfter !== undefined ? { firstClauseAfter: deps.firstClauseAfter } : {}) });
  const dropped: Record<HonestyCategory, number> = { claimed_action: 0, promise: 0, perception: 0, tool_result: 0 };
  /** calendar_read worked this turn: what's on the calendar may be said. */
  let resultsKnown = false;
  let readFailed = false;
  const droppedText: string[] = [];
  let kept = 0;
  let seen = 0;
  let useful = false;
  let pushed = false;
  let toolSucceeded = false;
  /** An affirmative opening, held until something useful passes (#98). */
  let held: string | undefined;
  /** The reply opened with a reaction (held or said). */
  let reacted = false;

  const release = (): void => {
    if (held === undefined) return;
    kept += 1;
    deps.onSentence?.(held);
    held = undefined;
  };

  const check = (sentences: readonly string[]): void => {
    for (const sentence of sentences) {
      const first = seen === 0;
      seen += 1;
      const found = toolSucceeded ? undefined : honestyCategory(sentence, deps.calendarTalk === true);
      const category = found === "tool_result" && resultsKnown ? undefined : found;
      if (category) {
        dropped[category] += 1;
        droppedText.push(sentence);
        continue;
      }
      if (first && isOnlyReaction(sentence)) {
        reacted = true;
        // Not streamed, holding costs nothing, so it's always held; streamed, only when asked to do something.
        if ((holdYes || !pushed) && !toolSucceeded && AFFIRMATIVE.test(sentence.trim())) {
          held = sentence;
          continue;
        }
      }
      if (!isOnlyReaction(sentence)) {
        useful = true;
        release();
      }
      kept += 1;
      deps.onSentence?.(sentence);
    }
  };

  return {
    /** A tool ran and succeeded this turn: its claims are true, so nothing is dropped from here on. */
    toolSucceeded: (): void => {
      toolSucceeded = true;
    },
    /** calendar_read ran and worked this turn (#102): what's on the calendar may be said. Promises and other claims are still dropped. */
    resultsKnown: (): void => {
      resultsKnown = true;
    },
    /** calendar_read was tried this turn and failed. */
    readFailed: (): void => {
      readFailed = true;
    },
    /** A streamed piece of the answer. */
    onText: (delta: string): void => {
      pushed = true;
      check(splitter.push(delta));
    },
    /** The answer is complete: checks what's left and returns the text to keep. */
    finish: (fullText: string): HonestyResult => {
      check(pushed ? splitter.flush() : [...splitter.push(fullText), ...splitter.flush()]);
      const total = dropped.claimed_action + dropped.promise + dropped.perception + dropped.tool_result;
      const replaced = total > 0 && !useful;
      // A held "Sure." is said after all, unless the reply turned into "I can't" (#98).
      if (replaced && held !== undefined) {
        droppedText.unshift(held);
        held = undefined;
      } else {
        release();
      }
      if (total === 0) return { text: fullText, dropped, replaced: false };
      let text = fullText;
      for (const sentence of droppedText) text = text.replace(sentence, "");
      text = text
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // A dropped claim about the calendar: say it wasn't checked, and offer to (#102).
      const unchecked = dropped.tool_result > 0;
      if (replaced || unchecked) {
        // After an opening reaction it flows on ("Hmm. Actually, I can't…"); a held yes is never said.
        const line = unchecked ? (readFailed ? READ_FAILED : deps.calendar ? NOT_CHECKED : NO_CALENDAR) : reacted ? ACTUALLY_CANT_YET : CANT_YET;
        deps.onSentence?.(line);
        text = kept > 0 && text !== "" ? `${text} ${line}` : line;
      }
      // Categories and counts only: never the text.
      deps.log?.info("honesty guard", { claimedAction: dropped.claimed_action, promise: dropped.promise, perception: dropped.perception, toolResult: dropped.tool_result, replaced });
      return { text, dropped, replaced };
    },
  };
};
