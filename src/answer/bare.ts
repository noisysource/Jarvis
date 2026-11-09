// Bare conversation mode (#88, BARE_MODE=on): the selected brain gets only
// the conversation so far and a short persona with the conversational style.
// No profile, no memories, no contexts or classifier. Each of those comes
// back later, one at a time, behind its own switch (see PLAN.md).
//
// The name comes from JARVIS_USER_NAME in the gitignored .env, never from
// the code (it's personal data).

import { err, ok, type Result } from "../result.js";
import type { AnswerInput, AnswerOutcome, AppError, Logger } from "../types.js";
import type { LlmCall, LlmError, LlmRequest } from "../llm/types.js";
import { streamOrCall } from "../llm/stream.js";
import { makeSentenceSplitter } from "../sentences.js";
import { historyMessages } from "./personal.js";

const BARE_MAX_TOKENS = 2000;

/** Spoken replies (#92): at most this many sentences after the opening reaction, unless they ask for detail. */
export const DEFAULT_SPOKEN_SENTENCES = 3;

/** They asked for more than a quick answer. */
export const asksForDetail = (question: string): boolean =>
  /\b(?:in (?:more )?detail|detailed|more detail|in depth|step by step|elaborate|go deeper|tell me (?:more|everything)|longer|explain (?:it )?(?:fully|properly|thoroughly)|the whole (?:story|thing))\b/i.test(question);

/** An opening reaction: one to three words, as its own sentence ("Okay.", "Good question."). */
export const isReaction = (sentence: string): boolean => {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && /[.!?…]$/.test(sentence.trim());
};

/**
 * Stops a reply after `max` sentences (#92); an opening reaction doesn't
 * count. Text is passed on as it arrives; when the limit is reached, exactly
 * the rest of the last allowed sentence is passed on and `done` is true.
 */
export const makeSentenceCap = (max: number) => {
  const splitter = makeSentenceSplitter({ language: "en", firstClauseAfter: Number.MAX_SAFE_INTEGER });
  let full = "";
  let forwarded = 0;
  let searchFrom = 0;
  let counted = 0;
  let first = true;
  let done = false;
  return {
    /** @returns the text to pass on now, and whether the reply should stop here */
    feed: (delta: string): { text: string; done: boolean } => {
      if (done) return { text: "", done: true };
      full += delta;
      for (const sentence of splitter.push(delta)) {
        const at = full.indexOf(sentence, searchFrom);
        const end = at === -1 ? full.length : at + sentence.length;
        searchFrom = end;
        const reaction = first && isReaction(sentence);
        first = false;
        if (!reaction) counted += 1;
        if (counted >= max) {
          done = true;
          const text = full.slice(forwarded, end);
          forwarded = end;
          return { text, done: true };
        }
      }
      const text = full.slice(forwarded);
      forwarded = full.length;
      return { text, done: false };
    },
    /** The reply so far, cut at the limit if it was reached. */
    text: () => full.slice(0, forwarded).trim(),
  };
};

/**
 * How to talk when the reply is spoken aloud (#92): it opens with a tiny
 * reaction (so the first thing to speak is a word or two and starts at
 * once), stays short, and reads well out loud.
 */
const SPOKEN_STYLE = (max: number) => [
  "How to talk (your reply is spoken aloud):",
  "- Start with a very short reaction of one to three words, as its own sentence: \"Okay.\", \"Good question.\", \"Hmm.\", \"Right.\", \"Oh, nice.\"",
  `- Then at most ${max === 1 ? "one sentence" : `${max === 2 ? "two" : max === 3 ? "two or three" : String(max)} short sentences`}, unless they ask for detail. Even for 'explain like I'm five', keep it that short.`,
  "- Talk the way people talk: contractions (it's, you're, don't), plain everyday words.",
  "- Write numbers and times in words (twenty-five, half past six, two thousand and twenty-six).",
  "- No quotes, brackets, lists, bullet points, headings, symbols, markdown or emoji.",
  "- Ask a short question back when it's natural, not every time.",
  "- Reply in the language they use.",
];

const TYPED_STYLE = [
  "How to talk:",
  "- 1 to 3 short sentences, unless they ask for detail.",
  "- React first, in a few natural words, then answer.",
  "- Ask a short question back when it helps, not every time.",
  "- Plain, everyday words. No lists, bullet points, headings, markdown or emoji.",
  "- Reply in the language they use.",
];

/** The whole system prompt in bare mode: who is who, what it can do, and how to talk (typed or spoken). */
export const barePrompt = (userName?: string, options: { readonly spoken?: boolean; readonly maxSentences?: number } = {}): string => {
  const you = userName ?? "the person you're talking to";
  return [
    `You are Jarvis, ${userName ? `${userName}'s` : "the"} personal assistant. You speak as "I"; ${userName ?? "they"} ${userName ? "is" : "are"} "you". Never speak as them.`,
    `You don't know anything about ${you}'s life, work or family beyond what's said in this conversation; if asked, say so plainly rather than guessing.`,
    "",
    "What you can do right now: only talk. You can chat, answer questions from what you know, and think things through together.",
    "You can't see a calendar, set reminders or alarms, take or keep notes, read or send email or messages, look anything up online, or use any tools or apps. When something needs one of those, say plainly that you can't do that yet, and offer what you can do instead, like talking it through.",
    "Never say or suggest you've done something you can't do (\"I've added it\", \"done\", \"I'll remind you\").",
    "",
    ...(options.spoken ? SPOKEN_STYLE(options.maxSentences ?? DEFAULT_SPOKEN_SENTENCES) : TYPED_STYLE),
  ].join("\n");
};

const toAppError = (e: LlmError): AppError =>
  e.kind === "aborted"
    ? { code: "cancelled", message: "Cancelled." }
    : { code: "llm_failed", message: e.userMessage ?? "Sorry, something went wrong answering that. Please try again." };

export const makeBareAnswerer = (deps: {
  readonly llm: LlmCall;
  readonly userName?: string;
  readonly log?: Logger;
  /** Spoken replies: sentences allowed after the opening reaction (VOICE_MAX_SENTENCES). */
  readonly spokenSentences?: number;
}): ((input: AnswerInput) => Promise<Result<AnswerOutcome, AppError>>) => {
  const max = deps.spokenSentences ?? DEFAULT_SPOKEN_SENTENCES;
  const typedSystem = barePrompt(deps.userName);
  const spokenSystem = barePrompt(deps.userName, { spoken: true, maxSentences: max });
  return async ({ question, history, onText, signal, spoken }) => {
    // Spoken and not asking for detail: the reply is cut off after the limit, whatever the model does (#92).
    const cap = spoken === true && !asksForDetail(question) ? makeSentenceCap(max) : undefined;
    const request: LlmRequest = {
      system: spoken === true ? spokenSystem : typedSystem,
      cacheSystem: true,
      messages: [...historyMessages(history), { role: "user", text: question }],
      effort: "low",
      // A conversation: answer without thinking first (Claude; Ollama has its own think setting).
      thinking: "off",
      maxTokens: BARE_MAX_TOKENS,
    };
    let result: Awaited<ReturnType<LlmCall>>;
    let cut = false;
    if (onText || cap) {
      // Our own controller too, so the model can be stopped at the sentence limit.
      const controller = new AbortController();
      signal?.addEventListener("abort", () => controller.abort());
      const streamed = streamOrCall(deps.llm, request, controller.signal);
      for await (const delta of streamed.text) {
        if (!cap) {
          onText?.(delta);
          continue;
        }
        const step = cap.feed(delta);
        if (step.text !== "") onText?.(step.text);
        if (step.done) {
          cut = true;
          controller.abort();
          break;
        }
      }
      result = await streamed.result;
    } else {
      result = await deps.llm(request);
    }
    if (cut && cap && !signal?.aborted) {
      deps.log?.info("spoken reply cut at the sentence limit", { max });
      return ok({ kind: "answer", text: cap.text() });
    }
    if (!result.ok) {
      deps.log?.warn("bare answer failed", { kind: result.error.kind });
      return err(toAppError(result.error));
    }
    if (result.value.kind !== "text") return err({ code: "llm_failed", message: "Sorry, something went wrong answering that. Please try again." });
    return ok({ kind: "answer", text: result.value.text });
  };
};
