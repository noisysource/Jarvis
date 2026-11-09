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

export type HonestyCategory = "claimed_action" | "promise" | "perception";

/** What's said when the guard leaves nothing useful. */
export const CANT_YET = "I can't do that yet.";

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

/** Which rule a sentence breaks, if any. */
export const honestyCategory = (sentence: string): HonestyCategory | undefined => {
  for (const [category, pattern] of PATTERNS) if (pattern.test(sentence)) return category;
  return undefined;
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
  readonly log?: Logger;
}) => {
  const splitter = makeSentenceSplitter({ language: "en", ...(deps.firstClauseAfter !== undefined ? { firstClauseAfter: deps.firstClauseAfter } : {}) });
  const dropped: Record<HonestyCategory, number> = { claimed_action: 0, promise: 0, perception: 0 };
  const droppedText: string[] = [];
  let kept = 0;
  let useful = false;
  let pushed = false;
  let toolSucceeded = false;

  const check = (sentences: readonly string[]): void => {
    for (const sentence of sentences) {
      const category = toolSucceeded ? undefined : honestyCategory(sentence);
      if (category) {
        dropped[category] += 1;
        droppedText.push(sentence);
        continue;
      }
      kept += 1;
      if (!isOnlyReaction(sentence)) useful = true;
      deps.onSentence?.(sentence);
    }
  };

  return {
    /** A tool ran and succeeded this turn: its claims are true, so nothing is dropped from here on. */
    toolSucceeded: (): void => {
      toolSucceeded = true;
    },
    /** A streamed piece of the answer. */
    onText: (delta: string): void => {
      pushed = true;
      check(splitter.push(delta));
    },
    /** The answer is complete: checks what's left and returns the text to keep. */
    finish: (fullText: string): HonestyResult => {
      check(pushed ? splitter.flush() : [...splitter.push(fullText), ...splitter.flush()]);
      const total = dropped.claimed_action + dropped.promise + dropped.perception;
      if (total === 0) return { text: fullText, dropped, replaced: false };
      let text = fullText;
      for (const sentence of droppedText) text = text.replace(sentence, "");
      text = text
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const replaced = !useful;
      if (replaced) {
        deps.onSentence?.(CANT_YET);
        text = kept > 0 && text !== "" ? `${text} ${CANT_YET}` : CANT_YET;
      }
      // Categories and counts only: never the text.
      deps.log?.info("honesty guard", { claimedAction: dropped.claimed_action, promise: dropped.promise, perception: dropped.perception, replaced });
      return { text, dropped, replaced };
    },
  };
};
