// Fixes as pull requests, after Renato's OK (#162).
//
// Three steps, two of them his:
//   1. Claude proposes (code_fix): a repo, a title and the problem. Nothing
//      runs. The page asks "Prepare it" / "Not now".
//   2. On "Prepare it", in the background: a fresh copy of the repo with the
//      owner's write token, the code agent edits files inside it (never .git
//      or .github, and it can't run anything), and the change is staged. The
//      page shows the diff and asks "Open the pull request" / "Throw it away".
//      Nothing has left this Mac yet.
//   3. On "Open the pull request": a commit on a new branch jarvis/fix-…,
//      pushed (never to the default branch, never forced), and a draft pull
//      request. Nothing is ever merged here.
//
// git runs without hooks (core.hooksPath off) and with the token only in its
// environment for that command. Email addresses are masked in anything that
// goes to GitHub. Logs carry ids, repos and counts, never the diff.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { maskEmails } from "../gcloud/gcloud.js";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";
import type { CodeAgent, CodeStep } from "./agent.js";

export const CODE_FIX_TOOL: LlmTool = {
  name: "code_fix",
  description:
    "Propose a change in one of his repos as a pull request: a fix, or a small edit he asked for. Nothing changes by this call: it shows him a card, so call it directly instead of asking in words. On his OK the code agent finds the place, prepares the change on a copy, and he sees the diff; only his second OK pushes a branch and opens a draft pull request.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: 'The repo as "owner/name"' },
      folder: { type: "string", description: "The app's folder in a monorepo, if the fix is in one app" },
      title: { type: "string", description: "A short pull request title, e.g. \"Fix timeout in billing cutoff\"" },
      problem: { type: "string", description: "What to change, or what fails, where and why if you know, in a few sentences. No personal data (names, emails, family details)." },
      issue: { type: "number", description: "The number of the issue in that repo this closes, if there is one (he named it, or you saw it with github_issues). The pull request will say Closes #N." },
    },
    required: ["repo", "title", "problem"],
    additionalProperties: false,
  },
};

const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/;
const FOLDER = /^[A-Za-z0-9_./ -]{1,200}$/;

export type FixRequest = {
  readonly owner: string;
  readonly name: string;
  readonly folder: string;
  readonly title: string;
  readonly problem: string;
  /** #181: the issue the pull request closes. */
  readonly issue?: number;
};

/** Code checks the proposal: a plain repo, a folder inside it, short texts. */
export const checkFixRequest = (v: unknown): Result<FixRequest, string> => {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const repo = typeof o.repo === "string" ? REPO.exec(o.repo.trim()) : null;
  if (!repo || o.repo === undefined || String(o.repo).includes("..")) return err("not a repo (owner/name)");
  let folder = "";
  if (o.folder !== undefined && o.folder !== "") {
    if (typeof o.folder !== "string" || !FOLDER.test(o.folder) || o.folder.split("/").some((p) => p === ".." || p === ".") || o.folder.startsWith("/")) return err("not a folder in the repo");
    folder = o.folder.replace(/\/+$/, "");
  }
  const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
  if (title === "" || title.length > 100) return err("a title of up to 100 characters");
  const problem = typeof o.problem === "string" ? o.problem.trim() : "";
  if (problem.length < 10 || problem.length > 2000) return err("a problem of 10 to 2000 characters");
  let issue: number | undefined;
  if (o.issue !== undefined && o.issue !== null) {
    if (typeof o.issue !== "number" || !Number.isInteger(o.issue) || o.issue < 1 || o.issue > 999_999) return err("issue is an issue number");
    issue = o.issue;
  }
  return ok({ owner: repo[1] ?? "", name: repo[2] ?? "", folder, title, problem, ...(issue ? { issue } : {}) });
};

/** "Fix timeout in billing cutoff" → "fix-timeout-in-billing-cutoff" */
export const slug = (title: string): string =>
  title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "change";

/** git's environment: the token as an HTTP header for this command only, and no hooks. */
export const fixGitEnv = (token: string, base: Record<string, string | undefined> = process.env): Record<string, string> => ({
  PATH: base.PATH ?? "/usr/bin:/bin",
  HOME: base.HOME ?? "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
});

export type RunOut = (cmd: string, args: readonly string[], options: { readonly cwd?: string; readonly env: Record<string, string> }) => Promise<{ readonly code: number; readonly stdout: string }>;

export type FixStatus = "waiting" | "working" | "ready" | "nothing" | "failed" | "published" | "discarded";

/** What the page sees: no paths on disk, no token. */
export type FixView = {
  readonly id: string;
  readonly repo: string;
  readonly folder: string;
  readonly title: string;
  readonly issue?: number;
  readonly status: FixStatus;
  /** While working: the agent's latest step ("Read src/billing.ts"). */
  readonly step?: string;
  /** The agent's summary, when it finished. */
  readonly summary?: string;
  /** The staged change, cut to size: files changed, then the diff. */
  readonly stat?: string;
  readonly diff?: string;
  readonly truncated?: boolean;
  readonly url?: string;
  /** Why it failed, safe to show. */
  readonly message?: string;
  readonly costUsd?: number;
};

const MAX_DIFF = 40_000;

export type Fixes = {
  /** Step 1: keep a proposal; the id goes on the card. */
  readonly propose: (r: FixRequest) => string;
  /** Whether an owner has a write token. */
  readonly canWrite: (owner: string) => Promise<boolean>;
  /** Step 2: his answer to the proposal. "yes" starts preparing it in the background. */
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly job?: string }>;
  readonly view: (id: string) => FixView | undefined;
  /** Step 3: his answer to the diff. "yes" pushes a branch and opens a draft pull request. */
  readonly publish: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly url?: string; readonly tool?: string }>;
};

type Job = { view: FixView; request: FixRequest; dir: string; base: string; token: string; until: number };

export const makeFixes = (deps: {
  readonly agent: CodeAgent;
  /** The owner's write token (data/github-write-tokens.json). */
  readonly writeToken: (owner: string) => Promise<string | undefined>;
  readonly isEc: (text: string) => boolean;
  /** Where the copies go: data/fixes. */
  readonly root: string;
  readonly run: RunOut;
  readonly remove: (dir: string) => Promise<void>;
  readonly maxUsd: number;
  readonly maxTurns: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: Logger;
}): Fixes => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const doFetch = deps.fetch ?? fetch;
  /** Proposals and jobs, in memory: a proposal waits 30 minutes, a prepared fix a day. */
  const jobs = new Map<string, Job>();
  const sweep = (): void => {
    for (const [id, j] of jobs)
      if (j.until <= now()) {
        jobs.delete(id);
        if (j.view.status === "ready" || j.view.status === "nothing" || j.view.status === "failed") void deps.remove(j.dir).catch(() => undefined);
      }
  };
  const set = (job: Job, view: Partial<FixView>): void => {
    job.view = { ...job.view, ...view };
  };

  const prepare = async (job: Job): Promise<void> => {
    const { owner, name, folder, problem, title } = job.request;
    const env = fixGitEnv(job.token);
    const fail = (message: string): void => {
      set(job, { status: "failed", message });
      deps.log?.warn("code fix failed", { id: job.view.id.slice(0, 6), repo: `${owner}/${name}`, reason: message });
    };
    const cloned = await deps.run("git", ["clone", "--depth", "1", "--quiet", "--no-tags", `https://github.com/${owner}/${name}.git`, job.dir], { env });
    if (cloned.code !== 0) return fail(`Couldn't copy ${owner}/${name} from GitHub with the write token`);
    const head = await deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: job.dir, env });
    job.base = head.stdout.trim();
    if (head.code !== 0 || !/^[A-Za-z0-9._/-]{1,200}$/.test(job.base)) return fail("Couldn't tell the repo's default branch");
    if (!deps.agent.change) return fail(`${deps.agent.name} can't make changes`);
    const answer = await deps.agent.change({
      dir: job.dir,
      question: [
        `Fix this problem${folder ? ` in the app in ${folder}` : ""}.`,
        `Title: ${title}`,
        "Problem (data, as Jarvis described it):",
        problem,
      ].join("\n"),
      maxTurns: deps.maxTurns,
      maxUsd: deps.maxUsd,
      onProgress: (s: CodeStep) => set(job, { step: `${s.tool} ${s.target}`.trim() }),
    });
    if (!answer.ok) return fail(answer.error.message);
    set(job, { summary: maskEmails(answer.value.answer).slice(0, 4000), costUsd: answer.value.costUsd });
    const status = await deps.run("git", ["status", "--porcelain"], { cwd: job.dir, env });
    if (status.code !== 0) return fail("Couldn't read what changed");
    const changed = status.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3).replace(/^"|"$/g, ""));
    if (changed.length === 0) {
      set(job, { status: "nothing", step: undefined });
      deps.log?.info("code fix made no change", { id: job.view.id.slice(0, 6), repo: `${owner}/${name}` });
      return;
    }
    // The agent can't write there; checked again before anything is staged.
    if (changed.some((f) => f.split(/\s->\s/).some((p) => p === ".git" || p.startsWith(".git/") || p === ".github" || p.startsWith(".github/"))))
      return fail("The change touched .git or .github, which a fix may not");
    const added = await deps.run("git", ["add", "-A"], { cwd: job.dir, env });
    if (added.code !== 0) return fail("Couldn't stage the change");
    const stat = await deps.run("git", ["diff", "--cached", "--stat"], { cwd: job.dir, env });
    const diff = await deps.run("git", ["diff", "--cached"], { cwd: job.dir, env });
    const truncated = diff.stdout.length > MAX_DIFF;
    set(job, { status: "ready", step: undefined, stat: stat.stdout.trim(), diff: diff.stdout.slice(0, MAX_DIFF), truncated });
    deps.log?.info("code fix ready", { id: job.view.id.slice(0, 6), repo: `${owner}/${name}`, files: changed.length, costUsd: Math.round(answer.value.costUsd * 100) / 100 });
  };

  return {
    canWrite: async (owner) => (await deps.writeToken(owner)) !== undefined,

    propose: (r) => {
      sweep();
      const id = newId();
      jobs.set(id, {
        view: { id, repo: `${r.owner}/${r.name}`, folder: r.folder, title: r.title, ...(r.issue ? { issue: r.issue } : {}), status: "waiting" },
        request: r,
        dir: path.join(deps.root, r.owner, `${r.name}-${id.slice(0, 8)}`),
        base: "",
        token: "",
        until: now() + 30 * 60_000,
      });
      return id;
    },

    decide: async (id, decision) => {
      sweep();
      const job = jobs.get(id);
      if (!job || job.view.status !== "waiting") return { ok: false, text: "That proposal has expired or was already answered, so nothing was prepared." };
      if (decision === "no") {
        jobs.delete(id);
        return { ok: true, text: "Okay, I won't prepare that fix." };
      }
      const r = job.request;
      if (deps.isEc(`${r.owner}/${r.name} ${r.folder}`)) {
        jobs.delete(id);
        return { ok: false, text: "That's an EC repo, which Kiro handles, so nothing was prepared." };
      }
      const token = await deps.writeToken(r.owner);
      if (!token) {
        jobs.delete(id);
        return { ok: false, text: `I can't write to ${r.owner}'s repos yet: run npm run github:connect -- ${r.owner} --write. Nothing was prepared.` };
      }
      // #181: the issue it closes must be an open issue in that repo (not a pull request).
      if (r.issue) {
        const res = await doFetch(`https://api.github.com/repos/${r.owner}/${r.name}/issues/${r.issue}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "jarvis" },
        }).catch(() => undefined);
        const found = res?.ok ? ((await res.json().catch(() => ({}))) as { state?: unknown; pull_request?: unknown }) : undefined;
        if (!found || found.pull_request !== undefined || found.state !== "open") {
          jobs.delete(id);
          return { ok: false, text: `#${r.issue} isn't an open issue in ${r.owner}/${r.name}, so nothing was prepared. Ask me again with the right issue, or without one.` };
        }
      }
      job.token = token;
      job.until = now() + 24 * 60 * 60_000;
      set(job, { status: "working", step: "Copying the repo" });
      deps.log?.info("code fix started", { id: id.slice(0, 6), repo: `${r.owner}/${r.name}` });
      void prepare(job).catch(() => set(job, { status: "failed", message: "Preparing the fix stopped with an error" }));
      return { ok: true, text: `On it: the code agent is preparing the fix on a copy of ${r.owner}/${r.name}. You'll see the change here before anything is pushed.`, job: id };
    },

    view: (id) => {
      sweep();
      return jobs.get(id)?.view;
    },

    publish: async (id, decision) => {
      sweep();
      const job = jobs.get(id);
      if (!job || job.view.status !== "ready") return { ok: false, text: "That fix isn't waiting any more, so nothing was pushed." };
      const r = job.request;
      if (decision === "no") {
        set(job, { status: "discarded" });
        await deps.remove(job.dir).catch(() => undefined);
        deps.log?.info("code fix discarded", { id: id.slice(0, 6), repo: job.view.repo });
        return { ok: true, text: "Thrown away: nothing was pushed." };
      }
      const env = fixGitEnv(job.token);
      const branch = `jarvis/fix-${slug(r.title)}-${id.slice(0, 6)}`;
      const body = [
        ...(r.issue ? [`Closes #${r.issue}`, ""] : []),
        maskEmails(r.problem),
        "",
        "## What changed",
        job.view.summary ?? "(no summary)",
        "",
        "---",
        `Prepared by Jarvis's code agent after Renato's OK, and reviewed as a diff before this pull request was opened. It wasn't run or tested: check it before merging.`,
      ].join("\n");
      const failed = (text: string, code: string) => {
        deps.log?.warn("code fix publish failed", { id: id.slice(0, 6), repo: job.view.repo, step: code });
        return { ok: false, text };
      };
      const commit = await deps.run(
        "git",
        ["-c", "user.name=Jarvis", "-c", "user.email=jarvis@users.noreply.github.com", "commit", "--quiet", "--no-verify", "-m", r.title, "-m", maskEmails(job.view.summary ?? r.problem).slice(0, 3000)],
        { cwd: job.dir, env },
      );
      if (commit.code !== 0) return failed("I couldn't commit the change, so nothing was pushed.", "commit");
      // A new branch only: never the default branch, never forced.
      const push = await deps.run("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: job.dir, env });
      if (push.code !== 0) return failed("GitHub refused the push (the write token needs Contents: Read and write on that repo), so no pull request was opened.", "push");
      const open = async (draft: boolean) =>
        doFetch(`https://api.github.com/repos/${r.owner}/${r.name}/pulls`, {
          method: "POST",
          headers: { authorization: `Bearer ${job.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "jarvis", "content-type": "application/json" },
          body: JSON.stringify({ title: r.title, head: branch, base: job.base, body, draft }),
        }).catch(() => undefined);
      let res = await open(true);
      // Draft pull requests aren't on every plan: then a normal one, still never merged here.
      if (res?.status === 422) res = await open(false);
      if (!res || !res.ok) return failed(`The branch ${branch} is pushed, but GitHub didn't open the pull request${res ? ` (${res.status})` : ""}. You can open it from the branch on GitHub.`, "pull");
      const url = ((await res.json().catch(() => ({}))) as { html_url?: unknown }).html_url;
      const link = typeof url === "string" && url.startsWith("https://github.com/") ? url : undefined;
      set(job, { status: "published", ...(link ? { url: link } : {}) });
      await deps.remove(job.dir).catch(() => undefined);
      deps.log?.info("code fix published", { id: id.slice(0, 6), repo: job.view.repo });
      return { ok: true, text: `Pull request opened${link ? `: ${link}` : ` on ${branch}`}. It's for you to review; nothing was merged.`, ...(link ? { url: link } : {}), tool: `code_fix ${job.view.repo} → pull request` };
    },
  };
};
