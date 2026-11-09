// Splits a streamed answer into sentences as it arrives (#72), so speech can
// start after the first one. Pure: feed text with `push`, get finished
// sentences back; `flush` returns whatever is left at the end.
//
// A sentence ends at . ! or ? followed by a space or a new line, except
// after an abbreviation ("Dr.", "e.g."), an initial ("J. Smith") or a list
// number at the start of a line ("1. "). A blank line always ends one.
// Closing quotes and brackets stay with their sentence. An ellipsis ("..."
// or "…") and a dash are pauses inside a piece, never an end (#94); "...?"
// still ends. A long first sentence is cut at a clause (, ; :) so the first
// audio comes sooner.

import type { Language } from "./types.js";

/** Words that end in a full stop without ending the sentence, per language (lower case, without the stop). */
const ABBREVIATIONS: Record<Language, ReadonlySet<string>> = {
  en: new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "eg", "ie", "approx", "no", "vol",
    "fig", "inc", "ltd", "co", "mt", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "a.m", "p.m", "u.s", "u.k",
  ]),
};

export type SentenceSplitterOptions = {
  readonly language: Language;
  /** Cut the first sentence at a clause once it's at least this long (characters). */
  readonly firstClauseAfter?: number;
};

export type SentenceSplitter = {
  /** Adds text; returns the sentences it completed, in order. */
  readonly push: (text: string) => string[];
  /** The rest, at the end of the answer. */
  readonly flush: () => string[];
};

const CLOSERS = "\"'”’)]»";

/** Where the sentence ending at `i` (an end mark) really ends: after any closing quotes/brackets. Undefined if it doesn't end there. */
const endAfter = (text: string, i: number, abbreviations: ReadonlySet<string>): number | undefined => {
  let j = i + 1;
  // "..." and "?!" belong together.
  while (j < text.length && ".!?…".includes(text[j] ?? "")) j += 1;
  while (j < text.length && CLOSERS.includes(text[j] ?? "")) j += 1;
  const next = text[j];
  if (next === undefined) return undefined; // can't tell yet: wait for more text
  if (!/\s/.test(next)) return undefined; // "3.5", "e.g.x", "example.com"
  if (text[i] === ".") {
    const lineStart = text.lastIndexOf("\n", i) + 1;
    const before = text.slice(lineStart, i);
    const word = /([\p{L}\p{N}.]+)$/u.exec(before)?.[1] ?? "";
    if (abbreviations.has(word.toLowerCase())) return undefined;
    if (/^\p{Lu}$/u.test(word)) return undefined; // an initial: "J. Smith"
    if (/^\s*\d{1,2}$/.test(before)) return undefined; // a list number: "1. "
  }
  return j;
};

export const makeSentenceSplitter = (options: SentenceSplitterOptions): SentenceSplitter => {
  const abbreviations = ABBREVIATIONS[options.language];
  const firstClauseAfter = options.firstClauseAfter ?? 120;
  let buffer = "";
  let emitted = 0;
  let scanFrom = 0;

  const take = (end: number): string | undefined => {
    const sentence = buffer.slice(0, end).trim();
    buffer = buffer.slice(end).replace(/^\s+/, "");
    scanFrom = 0;
    if (sentence === "") return undefined;
    emitted += 1;
    return sentence;
  };

  const push = (text: string): string[] => {
    buffer += text;
    const out: string[] = [];
    for (let i = scanFrom; i < buffer.length; i += 1) {
      const ch = buffer[i] ?? "";
      if (ch === "\n" && buffer[i + 1] === "\n") {
        const s = take(i);
        if (s) out.push(s);
        i = -1;
        continue;
      }
      if (".!?…".includes(ch)) {
        // An ellipsis is a pause, not an end (#94): skip the whole run of dots.
        if (ch !== "!" && ch !== "?" && (ch === "…" || buffer[i + 1] === "." || buffer[i - 1] === "." || buffer[i - 1] === "…")) {
          let k = i;
          while (k < buffer.length && ".…".includes(buffer[k] ?? "")) k += 1;
          i = k - 1; // a ? or ! right after ("...?") still ends it, on the next step
          continue;
        }
        const end = endAfter(buffer, i, abbreviations);
        if (end === undefined) {
          // Undecided only if we've reached the end of what's arrived.
          if (i >= buffer.length - 1 || /^[.!?…"'”’)\]»]*$/.test(buffer.slice(i + 1))) {
            scanFrom = i;
            return out.concat(cutLongFirst());
          }
          continue;
        }
        const s = take(end);
        if (s) out.push(s);
        i = -1;
      }
    }
    scanFrom = buffer.length;
    return out.concat(cutLongFirst());
  };

  /**
   * The first sentence only: if it's long and still going, cut at the last
   * clause mark; with no clause mark, cut at a word once it's twice as long,
   * so the first audio never waits for a long sentence to finish (#76).
   */
  const cutLongFirst = (): string[] => {
    if (emitted > 0 || buffer.length < firstClauseAfter) return [];
    const match = [...buffer.matchAll(/[,;:](\s)/g)].filter((m) => (m.index ?? 0) >= firstClauseAfter / 2).at(-1);
    if (match && match.index !== undefined) {
      const s = take(match.index + 1);
      return s ? [s] : [];
    }
    if (buffer.length < firstClauseAfter * 2) return [];
    const space = buffer.lastIndexOf(" ", buffer.length - 1);
    if (space < firstClauseAfter) return [];
    const s = take(space);
    return s ? [s] : [];
  };

  const flush = (): string[] => {
    const s = take(buffer.length);
    return s ? [s] : [];
  };

  return { push, flush };
};

/** Splits a whole text at once. */
export const splitSentences = (text: string, options: SentenceSplitterOptions): string[] => {
  const splitter = makeSentenceSplitter(options);
  return [...splitter.push(text), ...splitter.flush()];
};
