// Local recognition of handoff contexts, before any model runs.
//
// For each handoff context (in file order):
//   1. a cue AND an "Unless" word  -> route to that rule's context
//   2. a cue alone                 -> hand off
// Nothing matched -> the question goes to the classifier.

import type { Context, ContextId } from "./types.js";

export type Precheck =
  | { readonly kind: "handoff"; readonly context: Context }
  | { readonly kind: "route"; readonly contextId: ContextId }
  | { readonly kind: "none" };

const stripAccents = (s: string): string => s.normalize("NFD").replace(/\p{M}+/gu, "");

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ALL-CAPS cues such as "EC" are acronyms and match case-sensitively. */
const isAcronym = (cue: string): boolean => /\p{Lu}/u.test(cue) && !/\p{Ll}/u.test(cue);

/**
 * Whole-word/phrase matcher that ignores accents (and case, unless the cue is
 * an acronym). Spaces in a cue match any whitespace; a hyphen matches a hyphen,
 * whitespace or nothing, since speech transcription often drops it.
 */
export const makeCueMatcher = (cue: string): ((text: string) => boolean) => {
  const normalized = stripAccents(cue.trim());
  const body = normalized
    .split(/\s+/)
    .map((word) => word.split("-").map(escapeRegExp).join("[-\\s]*"))
    .join("\\s+");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
    isAcronym(normalized) ? "u" : "iu",
  );
  return (text) => pattern.test(stripAccents(text));
};

const anyMatch =
  (words: readonly string[]): ((text: string) => boolean) => {
    const matchers = words.map(makeCueMatcher);
    return (text) => matchers.some((m) => m(text));
  };

/** Builds the precheck once at startup; the returned function is pure and cheap per question. */
export const makePrecheck = (contexts: readonly Context[]): ((question: string) => Precheck) => {
  const rules = contexts.flatMap((context) =>
    context.handling.kind === "handoff" && context.handling.cues.length > 0
      ? [
          {
            context,
            matchesCue: anyMatch(context.handling.cues),
            unless: context.handling.unless.map((u) => ({
              routeTo: u.routeTo,
              matches: anyMatch(u.words),
            })),
          },
        ]
      : [],
  );

  return (question) => {
    for (const rule of rules) {
      if (!rule.matchesCue(question)) continue;
      const exception = rule.unless.find((u) => u.matches(question));
      return exception
        ? { kind: "route", contextId: exception.routeTo }
        : { kind: "handoff", context: rule.context };
    }
    return { kind: "none" };
  };
};
