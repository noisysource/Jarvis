// #128: keeping the code notes current.

import { describe, expect, it } from "vitest";
import { checkFreshness, isStale, makeCodeRefresh, parseFreshness, refreshPlan, staleNote, staleSuffix, type Freshness } from "../src/code/freshness.js";
import { notesLine, type CodeNote } from "../src/code/study.js";
import type { Commit, CommitsRequest } from "../src/github/github.js";
import { makeGithubReader } from "../src/github/github.js";
import { err, ok } from "../src/result.js";

const note = (repo: string, folder: string, studiedAt = "2026-11-10T10:00:00.000Z"): CodeNote => ({ repo, folder, studiedAt, text: "x", map: { nodes: [], edges: [] }, partial: false, turns: 1, costUsd: 0 });
const commit = (n: number): Commit => ({ sha: `abc${n}`, date: "2026-11-12T10:00:00Z", message: `change ${n}` });
const NOW = new Date("2026-11-14T04:00:00Z");

const kidclub = note("noisysource/noisysource", "apps/noisyphocus/kidclub");
const finances = note("noisysource/noisysource", "apps/noisysource/finances");
const root = note("noisysource/noisysource", "");

/** GitHub as seen by the check: kidclub changed 5 times, finances not at all, the repo 12 times. */
const commits = async (r: CommitsRequest) =>
  r.path === "apps/noisyphocus/kidclub" ? ok([1, 2, 3, 4, 5].map(commit)) : r.path ? ok([]) : ok(Array.from({ length: 12 }, (_, i) => commit(i)));

describe("checking the notes", () => {
  it("reads the commits since each study, by folder", async () => {
    const asked: CommitsRequest[] = [];
    const fresh = await checkFreshness({
      notes: [kidclub, finances, root],
      commits: async (r) => {
        asked.push(r);
        return commits(r);
      },
      now: () => NOW,
    });
    expect(asked[0]).toEqual({ repo: { owner: "noisysource", name: "noisysource" }, path: "apps/noisyphocus/kidclub", since: "2026-11-10T10:00:00.000Z", max: 50 });
    expect(asked[2]?.path).toBeUndefined();
    expect(fresh["noisysource/noisysource:apps/noisyphocus/kidclub"]).toEqual({ checkedAt: NOW.toISOString(), commits: 5, recent: ["change 1", "change 2", "change 3", "change 4", "change 5"] });
    expect(fresh["noisysource/noisysource:apps/noisysource/finances"]?.commits).toBe(0);
  });

  it("an app is stale after one commit; a whole monorepo only after many", async () => {
    const fresh = await checkFreshness({ notes: [kidclub, finances, root], commits, now: () => NOW });
    expect(isStale(kidclub, fresh["noisysource/noisysource:apps/noisyphocus/kidclub"])).toBe(true);
    expect(isStale(finances, fresh["noisysource/noisysource:apps/noisysource/finances"])).toBe(false);
    expect(isStale(root, fresh["noisysource/noisysource"])).toBe(false);
    expect(isStale(root, { checkedAt: "", commits: 20, recent: [] })).toBe(true);
  });

  it("a repo GitHub won't read is skipped, not marked fresh", async () => {
    const fresh = await checkFreshness({ notes: [kidclub], commits: async () => err({ code: "forbidden", message: "x" }), now: () => NOW });
    expect(fresh).toEqual({});
  });
});

describe("what the brain is told", () => {
  const fresh: Freshness = { "noisysource/noisysource:apps/noisyphocus/kidclub": { checkedAt: NOW.toISOString(), commits: 5, recent: ["Fix billing cutoff", "Add guests"] } };

  it("the notes line marks stale notes", () => {
    expect(notesLine([kidclub, finances], [], (n) => staleSuffix(n, fresh))).toContain("noisysource/noisysource:apps/noisyphocus/kidclub (2026-11-10, 5 commits since), noisysource/noisysource:apps/noisysource/finances (2026-11-10)");
  });

  it("code_notes says what changed, and how to get current", () => {
    expect(staleNote(kidclub, fresh)).toContain('5 commit(s) since (checked 2026-11-14), the newest: "Fix billing cutoff", "Add guests"');
    expect(staleNote(kidclub, fresh)).toContain("code_study with again: true");
    expect(staleNote(finances, fresh)).toBeUndefined();
  });

  it("the kept check is read defensively", () => {
    expect(parseFreshness(JSON.stringify(fresh))).toEqual(fresh);
    expect(parseFreshness("nope")).toEqual({});
    expect(parseFreshness(JSON.stringify({ a: { commits: "5" } }))).toEqual({});
  });
});

describe("the nightly run", () => {
  const setup = (mode: "off" | "check" | "study", maxStudies = 2) => {
    const started: string[] = [];
    let kept: string | undefined;
    const refresh = makeCodeRefresh({
      mode,
      maxStudies,
      notes: async () => [root, kidclub, finances, note("noisysource/noisysource", "apps/noisysource/domotics")],
      commits: async (r) => (r.path === "apps/noisysource/domotics" ? ok([commit(1), commit(2)]) : commits(r)),
      start: (owner, name, folder) => {
        started.push(`${owner}/${name}:${folder}`);
        return "queued";
      },
      read: async () => kept,
      write: async (t) => {
        kept = t;
      },
      now: () => NOW,
    });
    return { refresh, started };
  };

  it('"check" flags stale notes and keeps the result; it never studies', async () => {
    const { refresh, started } = setup("check");
    expect(await refresh.run()).toEqual({ checked: 4, stale: 2, queued: 0 });
    expect(started).toEqual([]);
    expect((await refresh.freshness())["noisysource/noisysource:apps/noisyphocus/kidclub"]?.commits).toBe(5);
  });

  it('"study" re-studies the most changed apps first, up to the cap', async () => {
    const one = setup("study", 1);
    expect((await one.refresh.run()).queued).toBe(1);
    expect(one.started).toEqual(["noisysource/noisysource:apps/noisyphocus/kidclub"]);
    const two = setup("study", 2);
    await two.refresh.run();
    expect(two.started).toEqual(["noisysource/noisysource:apps/noisyphocus/kidclub", "noisysource/noisysource:apps/noisysource/domotics"]);
  });

  it('"off" does nothing', async () => {
    const { refresh, started } = setup("off");
    expect(await refresh.run()).toEqual({ checked: 0, stale: 0, queued: 0 });
    expect(started).toEqual([]);
  });

  it("refreshPlan puts apps before whole repos", () => {
    const fresh: Freshness = {
      "noisysource/noisysource": { checkedAt: "", commits: 30, recent: [] },
      "noisysource/noisysource:apps/noisyphocus/kidclub": { checkedAt: "", commits: 2, recent: [] },
    };
    expect(refreshPlan([root, kidclub], fresh, 5).map((n) => n.folder)).toEqual(["apps/noisyphocus/kidclub", ""]);
  });
});

describe("GitHub commits (read-only)", () => {
  it("asks for the commits since, in a folder, and keeps the first line of each message", async () => {
    const urls: string[] = [];
    const reader = makeGithubReader({
      tokens: { owners: async () => ["noisysource"], token: async () => "ghp_r" },
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(`${init.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify([{ sha: "0123456789abcdef", commit: { message: "Fix billing\n\nlong body", committer: { date: "2026-11-12T10:00:00Z" } } }]));
      }) as typeof fetch,
    });
    const got = await reader.commits?.({ repo: { owner: "noisysource", name: "noisysource" }, path: "apps/noisyphocus/kidclub", since: "2026-11-10T10:00:00.000Z", max: 50 });
    expect(got).toEqual(ok([{ sha: "0123456", date: "2026-11-12T10:00:00Z", message: "Fix billing" }]));
    expect(urls[0]).toBe("GET https://api.github.com/repos/noisysource/noisysource/commits?since=2026-11-10T10%3A00%3A00.000Z&per_page=50&path=apps%2Fnoisyphocus%2Fkidclub");
  });
});
