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
];

/** Roughly how many sentences: ends of sentences, or the last bit of text. */
export const sentenceCount = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const ends = trimmed.match(/[.!?…]+(?=\s|$)/g)?.length ?? 0;
  return /[.!?…]\s*$/.test(trimmed) ? ends : ends + 1;
};

const LIST_OR_HEADING = /^\s*(?:[-*•]\s|\d+[.)]\s|#{1,6}\s)/m;

/** Everything wrong with one answer, or [] when it passes. Style is checked on every case. */
export const checkAnswer = (c: IdentityCase, answer: string): string[] => {
  const problems: string[] = [];
  for (const r of c.must ?? []) if (!r.test(answer)) problems.push(`missing ${r}`);
  for (const r of c.mustNot ?? []) if (r.test(answer)) problems.push(`has ${r}`);
  const n = sentenceCount(answer);
  if (n > 3) problems.push(`${n} sentences (at most 3)`);
  if (LIST_OR_HEADING.test(answer)) problems.push("a list or heading");
  if (/\*\*|__/.test(answer)) problems.push("markdown");
  return problems;
};
