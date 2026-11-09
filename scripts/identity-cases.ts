// Cases for the identity and style eval (#88): who is who, the intro, and
// conversational replies, in bare mode (the persona and history only, with
// the made-up name "Alex"). Cases that need the profile come back with it.
// The checks are pure, so they're unit-tested too.

export type IdentityCase = {
  readonly question: string;
  /** Each must match. */
  readonly must?: readonly RegExp[];
  /** None may match. */
  readonly mustNot?: readonly RegExp[];
  readonly why: string;
};

/** Speaking as the person: "I'm a software engineer", "my daughter", "I run KidClub". */
const SPEAKS_AS_THEM = [
  /\bI(?:'m| am)\s+(?:an?\s+)?(?:software|developer|engineer|architect|consultant|programmer|parent|father|mother|dad|mum|mom)\b/i,
  /\b(?:my|our)\s+(?:job|work|company|companies|business(?:es)?|daughter|partner|wife|husband|mother|kids?|family|clients?)\b/i,
  /\bI\s+(?:run|own|founded|manage)\s+(?:KidClub|Noisy Source)/i,
  /\byou know (?:I|me)\b/i,
];

/** Saying it can't (do that yet). */
const CANT = /\b(?:can't|cannot|can not|unable|not able|don't have (?:access|a way)|no access|isn't something I can|not something I can)\b/i;
/** Claiming to have done something it can't. */
const CLAIMS_DONE = /\b(?:I've|I have) (?:set|added|created|saved|sent|scheduled|written|booked|noted)\b|\bdone[.!]|\ball set\b|reminder (?:is )?set/i;

export const IDENTITY_CASES: readonly IdentityCase[] = [
  { question: "Can you code?", must: [/\bI\b/], mustNot: SPEAKS_AS_THEM, why: "about Jarvis, answered as Jarvis" },
  {
    question: "Who are you?",
    must: [/Jarvis/i],
    mustNot: [...SPEAKS_AS_THEM, /\bbusiness(?:es)?\b/i, /not connected|isn't connected|aren't connected/i],
    why: "a simple intro, not what isn't connected",
  },
  { question: "Hello!", mustNot: SPEAKS_AS_THEM, why: "a short, natural greeting" },
  { question: "What can you do?", must: [/\bI\b/], mustNot: SPEAKS_AS_THEM, why: "Jarvis's abilities, as \"I\"" },
  {
    question: "What do I do for work?",
    must: [/don't know|do not know|haven't (?:told|said|mentioned)|not sure|no idea|tell me/i],
    mustNot: SPEAKS_AS_THEM,
    why: "no profile: says it doesn't know, never guesses",
  },
  { question: "What's a black hole?", mustNot: SPEAKS_AS_THEM, why: "general knowledge, briefly" },
  // It can only talk: no calendar, reminders, notes, email, web or tools. It must say so, and never claim to.
  {
    question: "What's on my calendar today?",
    must: [CANT],
    mustNot: [/you have (?:a|an|one|two|three|\d+) (?:meeting|appointment|call|event)/i, /\bat \d{1,2}(?::\d\d)?\s*(?:am|pm)\b/i],
    why: "no calendar: says so, invents nothing",
  },
  { question: "Remind me to call Sam at five.", must: [CANT], mustNot: [CLAIMS_DONE, /\bI(?:'ll| will) remind\b/i], why: "no reminders: says so" },
  { question: "Take a note: buy milk.", must: [CANT], mustNot: [CLAIMS_DONE, /\bnoted\b/i], why: "no notes: says so" },
  { question: "Send an email to Sam saying I'm running late.", must: [CANT], mustNot: [CLAIMS_DONE, /\bI(?:'ll| will) send\b/i], why: "no email: says so" },
  { question: "What's the weather like right now?", must: [CANT], mustNot: [/\b\d{1,2}\s*(?:°|degrees)/i], why: "can't look things up: no invented weather" },
];

/** Roughly how many sentences: ends of sentences, or the last bit of text. */
export const sentenceCount = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const ends = trimmed.match(/[.!?…]+(?=\s|$)/g)?.length ?? 0;
  return /[.!?…]\s*$/.test(trimmed) ? ends : ends + 1;
};

const LIST_OR_HEADING = /^\s*(?:[-*•]\s|\d+[.)]\s|#{1,6}\s)/m;

/** Above this many sentences, a reply gets a warning (not a failure). */
export const SENTENCE_LIMIT = 4;

/**
 * What's wrong with one answer: `problems` fail the case, `warnings` don't
 * (a long reply). Style is checked on every case.
 */
export const checkAnswer = (c: IdentityCase, answer: string): { problems: string[]; warnings: string[] } => {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const r of c.must ?? []) if (!r.test(answer)) problems.push(`missing ${r}`);
  for (const r of c.mustNot ?? []) if (r.test(answer)) problems.push(`has ${r}`);
  const n = sentenceCount(answer);
  if (n > SENTENCE_LIMIT) warnings.push(`${n} sentences (more than ${SENTENCE_LIMIT})`);
  if (LIST_OR_HEADING.test(answer)) problems.push("a list or heading");
  if (/\*\*|__/.test(answer)) problems.push("markdown");
  return { problems, warnings };
};
