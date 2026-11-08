// Streamed (spoken) answers and the memory wrap-up (#72).
//
// A streamed answer usually finishes long before Jarvis has finished
// *speaking* it, so the server can't tell on its own whether you heard it
// all. The wrap-up of a streamed answer is held here until the page reports
// how playback ended (`POST /ask/spoken`):
//
// - played to the end            → wrap up on the full answer, as usual
// - interrupted (barge-in)       → skip it: half an answer isn't worth
//                                  learning from…
// - …unless your question explicitly asked to remember or forget, in your
//   own words (the #61 check, and not an opt-out): then wrap up on your
//   question and what was actually spoken.
//
// No report within the hold time (the page closed, say) counts as played to
// the end if the answer finished, and as interrupted with nothing spoken if
// it didn't. Nothing here is logged except counts and outcomes.

import { asksNotToRemember, asksToForget, asksToRemember } from "./memory-rules.js";
import type { Logger } from "./types.js";

/** A streamed answer's wrap-up, waiting for the playback report. */
export type HeldTurn = {
  readonly question: string;
  /** Whether the answer finished streaming (false: it was cancelled part-way). */
  readonly completed: boolean;
  /** The full answer when completed; empty otherwise. */
  readonly answer: string;
  /** Schedules the wrap-up with this as the answer text. */
  readonly run: (answerText: string) => void;
};

export type PlaybackReport = {
  readonly interrupted: boolean;
  /** What Jarvis actually said aloud (the sentences played, the last one cut where it stopped). */
  readonly spoken: string;
};

/** Did the question explicitly ask to remember or forget something (and not to keep the exchange out of memory)? */
export const asksExplicitMemoryChange = (question: string): boolean =>
  !asksNotToRemember(question) && (asksToRemember(question) || asksToForget(question));

/**
 * What to wrap up on, or null to skip. `report` is undefined when the page
 * never reported.
 */
export const decideWrapUp = (turn: Pick<HeldTurn, "question" | "completed" | "answer">, report: PlaybackReport | undefined): { answer: string } | null => {
  const interrupted = report ? report.interrupted || !turn.completed : !turn.completed;
  if (!interrupted) return { answer: turn.answer };
  return asksExplicitMemoryChange(turn.question) ? { answer: report?.spoken ?? "" } : null;
};

export type TurnRegistry = {
  readonly hold: (turnId: string, turn: HeldTurn) => void;
  /** Applies the page's report. False if there's no such turn (already decided, expired or unknown). */
  readonly report: (turnId: string, report: PlaybackReport) => boolean;
  /** Shutdown (#78): settles every held turn as unreported, so no wrap-up is lost. Returns how many. */
  readonly settleAll: () => number;
  readonly pending: () => number;
};

export const DEFAULT_TURN_HOLD_MS = 120_000;
const MAX_HELD_TURNS = 100;

export const makeTurnRegistry = (deps: {
  readonly log: Logger;
  readonly holdMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}): TurnRegistry => {
  const holdMs = deps.holdMs ?? DEFAULT_TURN_HOLD_MS;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { clear: () => clearTimeout(t) };
    });
  const held = new Map<string, { turn: HeldTurn; timer: { clear: () => void } }>();

  const settle = (turnId: string, report: PlaybackReport | undefined): boolean => {
    const entry = held.get(turnId);
    if (!entry) return false;
    held.delete(turnId);
    entry.timer.clear();
    const decision = decideWrapUp(entry.turn, report);
    deps.log.info("spoken turn settled", {
      reported: report !== undefined,
      interrupted: report?.interrupted ?? !entry.turn.completed,
      wrapUp: decision === null ? "skipped" : "run",
    });
    if (decision) entry.turn.run(decision.answer);
    return true;
  };

  return {
    hold: (turnId, turn) => {
      // A runaway page can't pile up turns: the oldest is settled as unreported.
      if (held.size >= MAX_HELD_TURNS) {
        const oldest = held.keys().next().value;
        if (oldest !== undefined) settle(oldest, undefined);
      }
      held.set(turnId, { turn, timer: setTimer(() => settle(turnId, undefined), holdMs) });
    },
    report: (turnId, report) => settle(turnId, report),
    settleAll: () => {
      const ids = [...held.keys()];
      for (const id of ids) settle(id, undefined);
      return ids.length;
    },
    pending: () => held.size,
  };
};
