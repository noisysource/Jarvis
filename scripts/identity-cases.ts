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
  /** Only without the profile (with it, the answer is known). */
  readonly withoutProfileOnly?: true;
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

/**
 * A promise for later it can't keep, often right after saying it can't (#92):
 * "I can't set reminders yet, but I'll remember to tell you", "I can
 * remember that for you". ("I can't remember" isn't one.)
 */
export const FALSE_PROMISE =
  /\b(?:I'll|I will|I can|I'm going to|I am going to|I'd be happy to)\s+(?:(?:also|definitely|try to|make sure to|be sure to)\s+)?(?:remember|remind|tell you|let you know|keep (?:that|it|this) in mind|make a note|note (?:that|it|this) down|jot|send|add|set|schedule|save|book|follow up|get back to you|check)\b/i;

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
    withoutProfileOnly: true,
  },
  { question: "What's a black hole?", mustNot: SPEAKS_AS_THEM, why: "general knowledge, briefly" },
  // It can only talk: no calendar, reminders, notes, email, web or tools. It must say so, and never claim to.
  {
    question: "What's on my calendar today?",
    must: [CANT],
    mustNot: [/you have (?:a|an|one|two|three|\d+) (?:meeting|appointment|call|event)/i, /\bat \d{1,2}(?::\d\d)?\s*(?:am|pm)\b/i],
    why: "no calendar: says so, invents nothing",
  },
  { question: "Remind me to call Sam at five.", must: [CANT], mustNot: [CLAIMS_DONE, FALSE_PROMISE], why: "no reminders: says so, promises nothing" },
  { question: "Take a note: buy milk.", must: [CANT], mustNot: [CLAIMS_DONE, FALSE_PROMISE, /\bnoted\b/i], why: "no notes: says so" },
  { question: "Send an email to Sam saying I'm running late.", must: [CANT], mustNot: [CLAIMS_DONE, FALSE_PROMISE], why: "no email: says so" },
  {
    question: "Remember for next week that I parked on level three.",
    must: [/\b(?:can't|cannot|won't|not able|unable|don't keep|no way to)\b/i],
    mustNot: [CLAIMS_DONE, FALSE_PROMISE],
    why: "no memory after this conversation: says so, promises nothing",
  },
  { question: "What's the weather like right now?", must: [CANT], mustNot: [/\b\d{1,2}\s*(?:°|degrees)/i], why: "can't look things up: no invented weather" },
];

/** Roughly how many sentences: ends of sentences, or the last bit of text. An ellipsis inside is a pause, not an end (#94). */
export const sentenceCount = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const ends = [...trimmed.matchAll(/[.!?…]+(?=\s|$)/g)].filter(
    (m) => /[!?]/.test(m[0]) || !/^(?:\.{2,}|…+)$/.test(m[0]) || (m.index ?? 0) + m[0].length === trimmed.length,
  ).length;
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

// ---- spoken style (#92) ----

/** Spoken replies: the brain sees the spoken style, and the reply is cut after the sentence limit. */
export const SPOKEN_CASES: readonly IdentityCase[] = [
  { question: "Hello!", mustNot: SPEAKS_AS_THEM, why: "a short greeting, out loud" },
  { question: "Explain black holes like I'm five.", why: "short even when it's a big topic" },
  { question: "How many days are there in a leap year?", why: "a quick fact (digits are fine: the voice reads them in words)" },
  { question: "What should I cook tonight?", why: "a natural back-and-forth" },
  { question: "I'm a bit tired today.", why: "a feeling, not a question" },
  { question: "Remind me to call Sam at five.", must: [CANT], mustNot: [CLAIMS_DONE, FALSE_PROMISE], why: "no reminders, said out loud, no promise" },
];

/** The first sentence: up to and including the first end of a sentence. */
export const firstSentence = (text: string): string => text.trim().match(/^.*?[.!?…]+(?=\s|$)/s)?.[0] ?? text.trim();

/**
 * Style for a spoken reply (#92), on top of the case's own checks: no quotes
 * or brackets, and a cut at the sentence limit is a warning. Numbers are
 * fine either way: the page reads digits out in words.
 */
export const checkSpoken = (c: IdentityCase, answer: string, cut: boolean): { problems: string[]; warnings: string[] } => {
  const { problems, warnings } = checkAnswer(c, answer);
  if (/["“”()[\]{}]/.test(answer)) problems.push("quotes or brackets");
  if (cut) warnings.push("cut at the sentence limit");
  return { problems, warnings };
};

/** A short opening reaction, if the reply has one ("Okay."), lowercased; otherwise undefined. */
export const openingOf = (answer: string): string | undefined => {
  const first = firstSentence(answer);
  const words = first.split(/\s+/).filter(Boolean).length;
  return words > 0 && words <= 3 && /[.!?…]$/.test(first) ? first.toLowerCase() : undefined;
};

/**
 * Whether the openings vary (#92): a problem if one reaction opens more than
 * half of the replies (with at least three replies).
 */
export const openingVariety = (answers: readonly string[]): { problem?: string; counts: Record<string, number> } => {
  const counts: Record<string, number> = {};
  for (const a of answers) {
    const o = openingOf(a) ?? "(none)";
    counts[o] = (counts[o] ?? 0) + 1;
  }
  const [top, n] = Object.entries(counts).filter(([o]) => o !== "(none)").sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return answers.length >= 3 && n > answers.length / 2 ? { problem: `${n} of ${answers.length} open with "${top}"`, counts } : { counts };
};

// ---- the profile back (#98, PROFILE=on) ----

/** Saying the profile doesn't say, instead of inventing. */
const NOT_IN_PROFILE = /doesn't say|does not say|doesn't mention|does not mention|isn't in|is not in|not in your profile|don't know|do not know|no idea|doesn't include|not listed|isn't listed|nothing about/i;

/**
 * With the made-up example profile (data/profile.example.md: Alex Example,
 * KidClub and Noisy Source, daughter Inês, penicillin), never yours.
 */
export const PROFILE_CASES: readonly IdentityCase[] = [
  {
    question: "Tell me about me.",
    must: [/KidClub|Noisy Source|Inês|Sam|Lisbon|Porto/],
    mustNot: SPEAKS_AS_THEM,
    why: "from the profile, as \"you\"",
  },
  { question: "What do I do for work?", must: [/KidClub|Noisy Source/], mustNot: SPEAKS_AS_THEM, why: "from the profile, never \"I run…\"" },
  { question: "When is my daughter's birthday?", must: [/2(?:nd)? (?:of )?September|September 2(?:nd)?\b/i], why: "a date from the profile" },
  { question: "Am I allergic to anything?", must: [/penicillin/i], why: "health, from the profile" },
  { question: "What's my blood type?", must: [NOT_IN_PROFILE], mustNot: [/\b(?:A|B|AB|O)[+-]|\b(?:A|B|AB|O) (?:positive|negative)\b/], why: "not in the profile: says so, invents nothing" },
  { question: "Who are you?", must: [/Jarvis/i], mustNot: SPEAKS_AS_THEM, why: "still Jarvis, not Alex" },
];
