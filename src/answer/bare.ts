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
import { historyMessages } from "./personal.js";

const BARE_MAX_TOKENS = 2000;

/** The whole system prompt in bare mode: who is who, and how to talk. */
export const barePrompt = (userName?: string): string => {
  const you = userName ?? "the person you're talking to";
  return [
    `You are Jarvis, ${userName ? `${userName}'s` : "the"} personal assistant. You speak as "I"; ${userName ?? "they"} ${userName ? "is" : "are"} "you". Never speak as them.`,
    `You don't know anything about ${you}'s life, work or family beyond what's said in this conversation; if asked, say so plainly rather than guessing.`,
    "",
    "What you can do right now: only talk. You can chat, answer questions from what you know, and think things through together.",
    "You can't see a calendar, set reminders or alarms, take or keep notes, read or send email or messages, look anything up online, or use any tools or apps. When something needs one of those, say plainly that you can't do that yet, and offer what you can do instead, like talking it through.",
    "Never say or suggest you've done something you can't do (\"I've added it\", \"done\", \"I'll remind you\").",
    "",
    "How to talk:",
    "- 1 to 3 short sentences, unless they ask for detail.",
    "- React first, in a few natural words, then answer.",
    "- Ask a short question back when it helps, not every time.",
    "- Plain, everyday words. No lists, bullet points, headings, markdown or emoji.",
    "- Reply in the language they use.",
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
}): ((input: AnswerInput) => Promise<Result<AnswerOutcome, AppError>>) => {
  const system = barePrompt(deps.userName);
  return async ({ question, history, onText, signal }) => {
    const request: LlmRequest = {
      system,
      cacheSystem: true,
      messages: [...historyMessages(history), { role: "user", text: question }],
      effort: "low",
      maxTokens: BARE_MAX_TOKENS,
    };
    let result: Awaited<ReturnType<LlmCall>>;
    if (onText) {
      const streamed = streamOrCall(deps.llm, request, signal);
      for await (const delta of streamed.text) onText(delta);
      result = await streamed.result;
    } else {
      result = await deps.llm(request);
    }
    if (!result.ok) {
      deps.log?.warn("bare answer failed", { kind: result.error.kind });
      return err(toAppError(result.error));
    }
    if (result.value.kind !== "text") return err({ code: "llm_failed", message: "Sorry, something went wrong answering that. Please try again." });
    return ok({ kind: "answer", text: result.value.text });
  };
};
