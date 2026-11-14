// Keeping the code notes current (#128).
//
// Each night Jarvis asks GitHub (read-only) how many commits touched each
// studied repo or app since he studied it. A note with changes is stale: he
// says so when he uses it ("KidClub changed since I studied it: 5 commits").
// With CODE_REFRESH=study, he also re-studies the stalest few (capped per
// night, since studies use Renato's Claude plan). The check is kept in
// data/code/_freshness.json; logs carry counts only.

import type { Commit, CommitsRequest, GithubError } from "../github/github.js";
import type { Result } from "../result.js";
import type { Logger } from "../types.js";
import { noteKey, type CodeNote } from "./study.js";

export type RefreshMode = "off" | "check" | "study";

/** What the check found for one note. */
export type NoteFreshness = {
  readonly checkedAt: string;
  /** Commits since the study (capped at the read's limit). */
  readonly commits: number;
  /** The newest few, first line only. */
  readonly recent: readonly string[];
};

export type Freshness = Readonly<Record<string, NoteFreshness>>;

/** A whole monorepo's note goes stale with the repo, so it needs more change than one app's. */
export const ROOT_STALE_AT = 20;
export const APP_STALE_AT = 1;
const READ_MAX = 50;

/** Whether a note should be refreshed. */
export const isStale = (note: CodeNote, f: NoteFreshness | undefined): boolean => (f ? f.commits >= (note.folder === "" ? ROOT_STALE_AT : APP_STALE_AT) : false);

/** Reads the commits since each note's study; a repo that can't be read is skipped. */
export const checkFreshness = async (deps: {
  readonly notes: readonly CodeNote[];
  readonly commits: (r: CommitsRequest) => Promise<Result<readonly Commit[], GithubError>>;
  readonly now: () => Date;
  readonly log?: Logger;
}): Promise<Freshness> => {
  const out: Record<string, NoteFreshness> = {};
  let failed = 0;
  for (const note of deps.notes) {
    const [owner, name] = note.repo.split("/");
    if (!owner || !name) continue;
    const got = await deps.commits({ repo: { owner, name }, ...(note.folder ? { path: note.folder } : {}), since: note.studiedAt, max: READ_MAX });
    if (!got.ok) {
      failed += 1;
      continue;
    }
    out[noteKey(note.repo, note.folder)] = { checkedAt: deps.now().toISOString(), commits: got.value.length, recent: got.value.slice(0, 5).map((c) => c.message) };
  }
  deps.log?.info("code notes checked", { notes: deps.notes.length, stale: deps.notes.filter((n) => isStale(n, out[noteKey(n.repo, n.folder)])).length, failed });
  return out;
};

/** Which notes to re-study tonight: apps first (most changed first), then whole repos, at most `max`. */
export const refreshPlan = (notes: readonly CodeNote[], fresh: Freshness, max: number): readonly CodeNote[] =>
  notes
    .filter((n) => isStale(n, fresh[noteKey(n.repo, n.folder)]))
    .sort((a, b) => (a.folder === "" ? 1 : 0) - (b.folder === "" ? 1 : 0) || (fresh[noteKey(b.repo, b.folder)]?.commits ?? 0) - (fresh[noteKey(a.repo, a.folder)]?.commits ?? 0))
    .slice(0, Math.max(0, max));

/** For the brain: "5 commits since" after a stale note's name. */
export const staleSuffix = (note: CodeNote, fresh: Freshness): string => {
  const f = fresh[noteKey(note.repo, note.folder)];
  if (!f || !isStale(note, f)) return "";
  return `, ${f.commits >= READ_MAX ? `${READ_MAX}+` : f.commits} ${f.commits === 1 ? "commit" : "commits"} since`;
};

/** For code_notes: what changed since, to say it plainly. */
export const staleNote = (note: CodeNote, fresh: Freshness): string | undefined => {
  const f = fresh[noteKey(note.repo, note.folder)];
  if (!f || !isStale(note, f)) return undefined;
  return `The code changed after this study: ${f.commits >= READ_MAX ? `${READ_MAX}+` : f.commits} commit(s) since (checked ${f.checkedAt.slice(0, 10)}), the newest: ${f.recent.map((m) => `"${m}"`).join(", ")}. Say the note may be out of date where it matters; code_ask reads the code as it is now, and code_study with again: true refreshes the note.`;
};

/** The kept check, read defensively. */
export const parseFreshness = (text: string | undefined): Freshness => {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Record<string, NoteFreshness> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const o = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : undefined;
      if (o && typeof o.checkedAt === "string" && typeof o.commits === "number" && Array.isArray(o.recent))
        out[k] = { checkedAt: o.checkedAt, commits: o.commits, recent: o.recent.filter((m): m is string => typeof m === "string") };
    }
    return out;
  } catch {
    return {};
  }
};

export type CodeRefresh = {
  /** The last check, for the brain. */
  readonly freshness: () => Promise<Freshness>;
  /** Checks every note now, keeps the result, and (in "study" mode) queues the refreshes. */
  readonly run: () => Promise<{ readonly checked: number; readonly stale: number; readonly queued: number }>;
};

export const makeCodeRefresh = (deps: {
  readonly mode: RefreshMode;
  readonly maxStudies: number;
  readonly notes: () => Promise<readonly CodeNote[]>;
  readonly commits: (r: CommitsRequest) => Promise<Result<readonly Commit[], GithubError>>;
  readonly start: (owner: string, name: string, folder: string) => "queued" | "already";
  readonly read: () => Promise<string | undefined>;
  readonly write: (text: string) => Promise<void>;
  readonly now: () => Date;
  readonly log?: Logger;
}): CodeRefresh => ({
  freshness: async () => parseFreshness(await deps.read().catch(() => undefined)),
  run: async () => {
    if (deps.mode === "off") return { checked: 0, stale: 0, queued: 0 };
    const notes = await deps.notes();
    const fresh = await checkFreshness({ notes, commits: deps.commits, now: deps.now, ...(deps.log ? { log: deps.log } : {}) });
    await deps.write(JSON.stringify(fresh, null, 2));
    const stale = notes.filter((n) => isStale(n, fresh[noteKey(n.repo, n.folder)])).length;
    let queued = 0;
    if (deps.mode === "study")
      for (const n of refreshPlan(notes, fresh, deps.maxStudies)) {
        const [owner, name] = n.repo.split("/");
        if (owner && name && deps.start(owner, name, n.folder) === "queued") queued += 1;
      }
    if (queued > 0) deps.log?.info("code notes refreshing", { queued });
    return { checked: notes.length, stale, queued };
  },
});
