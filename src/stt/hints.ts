// Whisper name hints (#83). Whisper misspells names it doesn't know, so it
// gets a short prompt of expected words: the names in your profile (your
// name and its "## Family" section) and anything in the gitignored
// data/whisper-hints.txt (one word or name per line).
//
// The hints only go to Whisper on this machine. They're personal, so they're
// never logged (only how many there are) and never put in error messages.

/** Whisper reads at most ~224 prompt tokens; this stays well inside that. */
export const MAX_HINTS = 40;
export const MAX_PROMPT_CHARS = 400;

const heading = (line: string): string | undefined => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase();

/**
 * Names from the profile: "Name: …" anywhere, and the name in each
 * "- Role: Name, …" line of the Family section ("- Daughter: Inês, born …" → "Inês").
 */
export const profileNames = (markdown: string): string[] => {
  const names: string[] = [];
  let section = "";
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const h = heading(line);
    if (h !== undefined) {
      section = h;
      continue;
    }
    const item = /^[-*]\s*([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!item) continue;
    const label = (item[1] ?? "").trim().toLowerCase();
    if (label !== "name" && !/^(family|família)/.test(section)) continue;
    // The name is what comes before the first comma, semicolon, bracket or " - ".
    const name = (item[2] ?? "").split(/[,;(]| - | – /)[0]?.trim() ?? "";
    if (name !== "" && name.length <= 60) names.push(name);
  }
  return names;
};

/** One hint per line; blank lines and "#" comments are skipped. */
export const parseHintsFile = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.slice(0, 60));

/** The prompt Whisper gets, or "" when there are no hints. Deduplicated (ignoring case) and capped. */
export const buildWhisperPrompt = (hints: readonly string[]): string => {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const hint of hints) {
    const h = hint.replace(/\s+/g, " ").trim();
    const key = h.toLowerCase();
    if (h === "" || seen.has(key)) continue;
    if (kept.length >= MAX_HINTS || length + h.length + 2 > MAX_PROMPT_CHARS) break;
    seen.add(key);
    kept.push(h);
    length += h.length + 2;
  }
  return kept.length === 0 ? "" : `${kept.join(", ")}.`;
};

/**
 * Reads the hints fresh each time (so edits apply without a restart). A
 * missing hints file or profile just means fewer hints.
 */
export const makeWhisperHints = (deps: {
  readonly readProfile: () => Promise<string | undefined>;
  readonly readHintsFile: () => Promise<string | undefined>;
}): (() => Promise<{ readonly prompt: string; readonly count: number }>) => {
  return async () => {
    const [profile, file] = await Promise.all([
      deps.readProfile().catch(() => undefined),
      deps.readHintsFile().catch(() => undefined),
    ]);
    const hints = [...(profile ? profileNames(profile) : []), ...(file ? parseHintsFile(file) : [])];
    const prompt = buildWhisperPrompt(hints);
    return { prompt, count: prompt === "" ? 0 : prompt.split(", ").length };
  };
};
