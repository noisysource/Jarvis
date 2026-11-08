// @ts-check
// Speaking one reply, sentence by sentence (#82). Sentences are added as they
// stream in; each is fetched from POST /speak while the one before it plays,
// so there's no gap. If the configured voice fails, the rest is spoken by the
// browser voice. Stopping (barge-in, a new question) cuts the audio at once
// and works out what was actually said.
//
// The network and audio are passed in, so the bookkeeping is unit-tested.

import { spokenText } from "./turn-lib.js";

/**
 * @typedef {{ playedSeconds: number, totalSeconds: number, stopped: boolean }} Played
 * @typedef {{ fraction: () => number }} Tracker the player sets `fraction`: the share of the sentence heard so far
 * reason: why playback ended (#89): "finished", or what stopped it ("barge-in", "new-question", ...).
 * played: sentences played in full; voiceErrors: /speak or playback failures.
 * @typedef {{ interrupted: boolean, spoken: string, sentences: number, fellBack: boolean, reason: string, played: number, voiceErrors: number }} PlaybackResult
 * @typedef {{
 *   fetchSpeech: ((text: string, signal: AbortSignal) => Promise<Response>) | null,
 *   play: (response: Response, signal: AbortSignal, tracker: Tracker) => Promise<Played>,
 *   speakBrowser: (text: string, signal: AbortSignal, tracker: Tracker) => Promise<{ fraction: number, stopped: boolean }>,
 *   muted?: boolean,
 *   onFallback?: (reason: string) => void,
 *   onSpeaking?: () => void,
 *   onDone: (result: PlaybackResult) => void,
 * }} SpeakerDeps
 */

/** Why /speak didn't give audio, for the fallback note. @param {Response} res */
const problemOf = async (res) => {
  const body = /** @type {{ message?: unknown } | null} */ (await res.json().catch(() => null));
  return body && typeof body.message === "string" ? body.message : `the voice service answered ${res.status}`;
};

/**
 * fetchSpeech null: the browser voice is the voice. `onDone` is called exactly
 * once: when the last sentence has played after `finish()`, or straight away
 * (synchronously) on `stop()`, so the result is known before anything else
 * happens.
 * @param {SpeakerDeps} deps
 */
export const makeSpeaker = (deps) => {
  const controller = new AbortController();
  /** @type {string[]} */
  const sentences = [];
  /** @type {(Promise<Response | Error> | undefined)[]} */
  const fetched = [];
  let fallback = deps.fetchSpeech === null;
  let finished = false;
  let settled = false;
  let full = 0;
  /** Share of the current sentence played when stopped. */
  let currentFraction = 0;
  /** The sentence playing now, as its player reports it. @type {Tracker} */
  let tracker = { fraction: () => 0 };
  /** @type {(() => void) | undefined} */
  let wake;

  let voiceErrors = 0;
  /** @param {boolean} interrupted @param {string} reason */
  const settle = (interrupted, reason) => {
    if (settled) return;
    settled = true;
    deps.onDone({
      interrupted,
      spoken: interrupted ? spokenText(sentences, { full, cutFraction: currentFraction }) : sentences.join(" "),
      sentences: sentences.length,
      fellBack: fallback && deps.fetchSpeech !== null,
      reason: interrupted ? reason : "finished",
      played: full,
      voiceErrors,
    });
  };

  /** Starts fetching sentence i, unless it's already on its way. @param {number} i */
  const prefetch = (i) => {
    if (fallback || deps.muted || !deps.fetchSpeech || i >= sentences.length || fetched[i]) return;
    const text = sentences[i] ?? "";
    fetched[i] = deps.fetchSpeech(text, controller.signal).then(
      async (res) => (res.ok ? res : new Error(await problemOf(res))),
      (e) => (e instanceof Error ? e : new Error(String(e))),
    );
  };

  const run = async () => {
    for (let i = 0; ; i += 1) {
      while (i >= sentences.length && !finished && !controller.signal.aborted) {
        await new Promise((r) => (wake = () => r(undefined)));
      }
      if (controller.signal.aborted) return;
      if (i >= sentences.length) break;
      if (i === 0) deps.onSpeaking?.();
      if (deps.muted) {
        full = i + 1;
        continue;
      }
      const text = sentences[i] ?? "";
      prefetch(i);
      const response = fallback ? undefined : await fetched[i];
      if (controller.signal.aborted) return;
      if (response instanceof Response) {
        prefetch(i + 1); // the next one is fetched while this one plays
        tracker = { fraction: () => 0 };
        try {
          const played = await deps.play(response, controller.signal, tracker);
          if (played.stopped) {
            currentFraction = played.totalSeconds > 0 ? played.playedSeconds / played.totalSeconds : 0;
            return;
          }
        } catch (e) {
          if (controller.signal.aborted) return;
          voiceErrors += 1;
          fallback = true;
          deps.onFallback?.(e instanceof Error ? e.message : "the voice stopped");
          i -= 1; // say this sentence again with the browser voice
          continue;
        }
      } else {
        if (response instanceof Error && !fallback) {
          voiceErrors += 1;
          fallback = true;
          deps.onFallback?.(response.message);
        }
        tracker = { fraction: () => 0 };
        const spoke = await deps.speakBrowser(text, controller.signal, tracker);
        if (spoke.stopped || controller.signal.aborted) {
          currentFraction = spoke.fraction;
          return;
        }
      }
      full = i + 1;
      tracker = { fraction: () => 0 };
    }
    settle(false, "finished");
  };
  void run();

  return {
    /** Adds the next sentence. @param {string} text */
    say: (text) => {
      const t = text.trim();
      if (t === "" || finished || controller.signal.aborted) return;
      sentences.push(t);
      // The first two are fetched straight away; later ones as playback reaches them.
      if (sentences.length <= 2) prefetch(sentences.length - 1);
      wake?.();
    },
    /** No more sentences are coming. */
    finish: () => {
      finished = true;
      wake?.();
    },
    /**
     * Stops at once (barge-in, or a new question). `reason` is logged (#89).
     * @param {string} [reason]
     */
    stop: (reason = "stopped") => {
      if (settled) return;
      currentFraction = currentFraction || tracker.fraction();
      controller.abort();
      wake?.();
      settle(full < sentences.length || !finished, reason);
    },
    /** Is anything still to be said or playing? */
    active: () => !settled,
  };
};
