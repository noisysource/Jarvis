// #162: fixes as pull requests, each step after Renato's OK.

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import type { CodeAgent, CodeQuestion } from "../src/code/agent.js";
import { insideRepo } from "../src/code/claude-code.js";
import { checkFixRequest, fixGitEnv, makeFixes, slug, type FixRequest, type RunOut } from "../src/code/fix.js";
import type { GithubReader } from "../src/github/github.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import type { Context, Deps, PathStep } from "../src/types.js";
import { diffLines, fixStatusText } from "../src/web/fix-lib.js";

const isEc = (t: string) => /\bhrt\b|european commission/i.test(t);
const request: FixRequest = { owner: "noisysource", name: "noisysource", folder: "functions", title: "Fix timeout in billing cutoff", problem: "billingcutoff times out after 3000 ms on every run since Tuesday; the Vendus call has no timeout." };

describe("checking a proposal", () => {
  it("a plain repo, a folder inside it, short texts", () => {
    expect(checkFixRequest({ repo: "noisysource/noisysource", folder: "functions/", title: "  Fix   timeout ", problem: request.problem })).toEqual(ok({ ...request, title: "Fix timeout" }));
    expect(checkFixRequest({ repo: "noisysource/../x", title: "t", problem: request.problem }).ok).toBe(false);
    expect(checkFixRequest({ repo: "noisysource", title: "t", problem: request.problem }).ok).toBe(false);
    expect(checkFixRequest({ repo: "a/b", folder: "../etc", title: "t", problem: request.problem }).ok).toBe(false);
    expect(checkFixRequest({ repo: "a/b", folder: "/etc", title: "t", problem: request.problem }).ok).toBe(false);
    expect(checkFixRequest({ repo: "a/b", title: "x".repeat(101), problem: request.problem }).ok).toBe(false);
    expect(checkFixRequest({ repo: "a/b", title: "t", problem: "short" }).ok).toBe(false);
  });

  it("branch names come from the title", () => {
    expect(slug("Fix timeout in billing cutoff")).toBe("fix-timeout-in-billing-cutoff");
    expect(slug("Corrigir a faturação! (já)")).toBe("corrigir-a-faturacao-ja");
    expect(slug("!!!")).toBe("change");
  });

  it("git runs with the token only in its environment, and no hooks", () => {
    const env = fixGitEnv("ghp_secret", { PATH: "/bin", HOME: "/home/r", ANTHROPIC_API_KEY: "sk-x" });
    expect(env.GIT_CONFIG_KEY_1).toBe("core.hooksPath");
    expect(env.GIT_CONFIG_VALUE_1).toBe("/dev/null");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`);
    expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("the agent's change mode stays in its copy", () => {
  it("edits and writes inside the repo only, never .git or .github", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fix-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "x");
    const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
    await symlink(outside, path.join(root, "escape"));
    const can = (tool: string, input: Record<string, unknown>) => insideRepo(root, tool, input, undefined, "change");
    expect(await can("Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" })).toBe(true);
    expect(await can("Write", { file_path: "src/new.ts", content: "" })).toBe(true);
    expect(await can("Read", { file_path: ".git/config" })).toBe(true);
    expect(await can("Write", { file_path: ".git/hooks/pre-commit", content: "" })).toBe(false);
    expect(await can("Edit", { file_path: ".github/workflows/ci.yml" })).toBe(false);
    expect(await can("Write", { file_path: "escape/x.ts", content: "" })).toBe(false);
    expect(await can("Write", { file_path: "/tmp/x.ts", content: "" })).toBe(false);
    expect(await can("Write", { content: "" })).toBe(false);
    expect(await can("Bash", { command: "ls" })).toBe(false);
    // Read mode is unchanged: no writing at all.
    expect(await insideRepo(root, "Edit", { file_path: "src/a.ts" })).toBe(false);
  });
});

/** A fake git: records commands, answers the few whose output matters. */
const fakeGit = (over: { status?: string; push?: number; clone?: number } = {}) => {
  const ran: { args: readonly string[]; env: Record<string, string> }[] = [];
  const run: RunOut = async (_cmd, args, options) => {
    ran.push({ args, env: options.env });
    if (args[0] === "clone") return { code: over.clone ?? 0, stdout: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "main\n" };
    if (args[0] === "status") return { code: 0, stdout: over.status ?? " M functions/src/billing.ts\n" };
    if (args.join(" ") === "diff --cached --stat") return { code: 0, stdout: " functions/src/billing.ts | 2 +-\n" };
    if (args.join(" ") === "diff --cached") return { code: 0, stdout: "diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new\n" };
    if (args.includes("push")) return { code: over.push ?? 0, stdout: "" };
    return { code: 0, stdout: "" };
  };
  return { run, ran };
};

const agentThat = (answer: string, onAsk?: (q: CodeQuestion) => void): CodeAgent => ({
  name: "fake",
  ask: async () => err({ code: "agent", message: "x" }),
  change: async (q) => {
    onAsk?.(q);
    q.onProgress?.({ tool: "Read", target: "functions/src/billing.ts" });
    return ok({ answer, costUsd: 0.4, turns: 6 });
  },
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
};

describe("preparing and publishing a fix", () => {
  const setup = (over: Parameters<typeof fakeGit>[0] = {}, agent: CodeAgent = agentThat("The Vendus call had no timeout; added one in functions/src/billing.ts. Check: run billingcutoff on dev.")) => {
    const git = fakeGit(over);
    const removed: string[] = [];
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    let ids = 0;
    const fixes = makeFixes({
      agent,
      writeToken: async (owner) => (owner === "noisysource" ? "ghp_write" : undefined),
      isEc,
      root: "/data/fixes",
      run: git.run,
      remove: async (d) => {
        removed.push(d);
      },
      maxUsd: 2,
      maxTurns: 60,
      newId: () => `${"a".repeat(23)}${(ids += 1)}`,
      fetch: (async (url: string, init: RequestInit) => {
        posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ html_url: "https://github.com/noisysource/noisysource/pull/42" }), { status: 201 });
      }) as typeof fetch,
    });
    return { fixes, git, removed, posted };
  };

  it("nothing runs until his first OK; then a copy, the agent's change, a diff, and still nothing pushed", async () => {
    const asked: CodeQuestion[] = [];
    const { fixes, git, posted } = setup({}, agentThat("Added a 10 s timeout. Contact ana@example.com", (q) => asked.push(q)));
    const id = fixes.propose(request);
    expect(fixes.view(id)?.status).toBe("waiting");
    expect(git.ran).toEqual([]);
    const started = await fixes.decide(id, "yes");
    expect(started).toMatchObject({ ok: true, job: id });
    await until(() => fixes.view(id)?.status !== "working");
    const view = fixes.view(id);
    expect(view).toMatchObject({ status: "ready", stat: "functions/src/billing.ts | 2 +-", summary: "Added a 10 s timeout. Contact [email]", costUsd: 0.4 });
    expect(view?.diff).toContain("+new");
    expect(asked[0]?.dir).toBe(path.join("/data/fixes", "noisysource", "noisysource-aaaaaaaa"));
    expect(asked[0]?.question).toContain("in the app in functions");
    expect(git.ran.map((r) => r.args[0])).toEqual(["clone", "rev-parse", "status", "add", "diff", "diff"]);
    expect(git.ran.every((r) => r.env.GIT_CONFIG_VALUE_1 === "/dev/null")).toBe(true);
    expect(posted).toEqual([]);
    // The page never sees where the copy is, or the token.
    expect(JSON.stringify(view)).not.toMatch(/data\/fixes|ghp_/);
  });

  it("his second OK: a commit, a new branch pushed (never the default, never forced), a draft pull request", async () => {
    const { fixes, git, posted, removed } = setup();
    const id = fixes.propose(request);
    await fixes.decide(id, "yes");
    await until(() => fixes.view(id)?.status === "ready");
    const done = await fixes.publish(id, "yes");
    expect(done).toMatchObject({ ok: true, url: "https://github.com/noisysource/noisysource/pull/42" });
    const push = git.ran.find((r) => r.args.includes("push"));
    expect(push?.args).toEqual(["push", "--quiet", "origin", "HEAD:refs/heads/jarvis/fix-fix-timeout-in-billing-cutoff-aaaaaa"]);
    expect(push?.args.join(" ")).not.toMatch(/--force|-f\b|refs\/heads\/main/);
    const commit = git.ran.find((r) => r.args.includes("commit"));
    expect(commit?.args).toContain("--no-verify");
    expect(posted[0]?.url).toBe("https://api.github.com/repos/noisysource/noisysource/pulls");
    expect(posted[0]?.body).toMatchObject({ title: request.title, head: "jarvis/fix-fix-timeout-in-billing-cutoff-aaaaaa", base: "main", draft: true });
    expect(String(posted[0]?.body.body)).toContain("It wasn't run or tested");
    expect(removed).toHaveLength(1);
    expect(fixes.view(id)?.status).toBe("published");
    // Single use.
    expect((await fixes.publish(id, "yes")).ok).toBe(false);
  });

  it('"Throw it away" pushes nothing and removes the copy; "Not now" prepares nothing', async () => {
    const { fixes, git, posted, removed } = setup();
    const id = fixes.propose(request);
    await fixes.decide(id, "yes");
    await until(() => fixes.view(id)?.status === "ready");
    expect(await fixes.publish(id, "no")).toEqual({ ok: true, text: "Thrown away: nothing was pushed." });
    expect(git.ran.some((r) => r.args.includes("push"))).toBe(false);
    expect(posted).toEqual([]);
    expect(removed).toHaveLength(1);
    const other = fixes.propose(request);
    expect((await fixes.decide(other, "no")).ok).toBe(true);
    expect(fixes.view(other)).toBeUndefined();
  });

  it("no change, no write token, an EC repo or a failed push are said plainly", async () => {
    const quiet = setup({ status: "" });
    const a = quiet.fixes.propose(request);
    await quiet.fixes.decide(a, "yes");
    await until(() => quiet.fixes.view(a)?.status !== "working");
    expect(quiet.fixes.view(a)?.status).toBe("nothing");

    const { fixes } = setup();
    const b = fixes.propose({ ...request, owner: "renato" });
    expect(await fixes.decide(b, "yes")).toMatchObject({ ok: false, text: expect.stringContaining("github:connect -- renato --write") });
    const c = fixes.propose({ ...request, folder: "hrt" });
    expect((await fixes.decide(c, "yes")).text).toContain("Kiro");

    const refused = setup({ push: 128 });
    const d = refused.fixes.propose(request);
    await refused.fixes.decide(d, "yes");
    await until(() => refused.fixes.view(d)?.status === "ready");
    expect(await refused.fixes.publish(d, "yes")).toMatchObject({ ok: false, text: expect.stringContaining("GitHub refused the push") });
    expect(refused.posted).toEqual([]);
  });

  it("a change under .github is refused even if the agent made one", async () => {
    const { fixes } = setup({ status: " M .github/workflows/ci.yml\n" });
    const id = fixes.propose(request);
    await fixes.decide(id, "yes");
    await until(() => fixes.view(id)?.status !== "working");
    expect(fixes.view(id)).toMatchObject({ status: "failed", message: "The change touched .git or .github, which a fix may not" });
  });
});

describe("Claude proposing a fix", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
  const github: GithubReader = {
    owners: async () => ["noisysource"],
    repos: async () => ok([]),
    read: async () => err({ code: "not_found", message: "x" }),
    issues: async () => ok([]),
    checks: async () => ok({ ref: "main", checks: [] }),
  };

  it("only proposes: the path carries an OK card, nothing else happens", async () => {
    const { fixes, git } = (() => {
      const g = fakeGit();
      return {
        git: g,
        fixes: makeFixes({ agent: agentThat("ok"), writeToken: async () => "ghp_w", isEc, root: "/data/fixes", run: g.run, remove: async () => undefined, maxUsd: 2, maxTurns: 60, newId: () => "b".repeat(24) }),
      };
    })();
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "f1", name: "code_fix", input: { repo: "noisysource/noisysource", title: request.title, problem: request.problem } }] },
      { ...common, kind: "text", text: "I can fix that once you say so." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    const code = { agent: agentThat("x"), copies: { ensure: async () => ok("/tmp/x") }, owners: async () => ["noisysource"], isEc, maxUsd: 0.5, maxTurns: 25, fix: fixes };
    await makeBareAnswerer({ llm, tools: true, github: { reader: github, isEc }, code })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "fix it",
      history: [],
      memories: [],
      now: new Date(),
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("code_fix");
    expect(requests[0]?.system).toContain("propose it with code_fix");
    expect(steps[0]).toEqual({
      kind: "tool",
      name: "code_fix",
      args: "noisysource/noisysource",
      by: "model",
      ok: true,
      result: "waiting for your OK",
      confirm: { id: "b".repeat(24), label: `noisysource/noisysource: ${request.title}`, kind: "fix" },
    });
    expect(git.ran).toEqual([]);
    expect(JSON.stringify(requests[1]?.messages)).toContain("Never say it's done");
  });
});

describe("the routes and the page's helpers", () => {
  it("POST /code/fix, GET /code/fixes/:id and POST /code/fixes/publish take only an id and a decision", async () => {
    const calls: string[] = [];
    const codeFixes: NonNullable<Deps["codeFixes"]> = {
      decide: async (id, d) => {
        calls.push(`decide ${id} ${d}`);
        return { ok: true, text: "On it", job: id };
      },
      view: (id) => (id === "c".repeat(24) ? { id, repo: "a/b", folder: "", title: "t", status: "ready" } : undefined),
      publish: async (id, d) => {
        calls.push(`publish ${id} ${d}`);
        return { ok: true, text: "Pull request opened" };
      },
    };
    const errors: unknown[] = [];
    const log = { info: () => undefined, warn: () => undefined, error: (_m: string, f?: unknown) => void errors.push(f) };
    const app = makeServer({ codeFixes, log } as unknown as Deps);
    const post = (route: string, body: unknown) => app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/code/fix", { id: "c".repeat(24), decision: "yes" })).status).toBe(200);
    expect((await post("/code/fixes/publish", { id: "c".repeat(24), decision: "no" })).status).toBe(200);
    expect((await post("/code/fix", { id: "c".repeat(24), decision: "yes", extra: 1 })).status).toBe(400);
    expect((await post("/code/fix", { id: "../x", decision: "yes" })).status).toBe(400);
    expect((await app.request("/code/fix", { method: "POST", body: "{}" })).status).toBe(415);
    expect(errors).toEqual([]);
    expect(calls).toEqual([`decide ${"c".repeat(24)} yes`, `publish ${"c".repeat(24)} no`]);
    expect((await app.request(`/code/fixes/${"c".repeat(24)}`)).status).toBe(200);
    expect((await app.request(`/code/fixes/${"d".repeat(24)}`)).status).toBe(404);
  });

  it("colours a diff, as text", () => {
    expect(diffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n")).toEqual([
      { kind: "file", text: "diff --git a/x b/x" },
      { kind: "file", text: "--- a/x" },
      { kind: "file", text: "+++ b/x" },
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: "-old" },
      { kind: "add", text: "+new" },
      { kind: "ctx", text: " same" },
    ]);
  });

  it("words each state of a fix", () => {
    expect(fixStatusText({ status: "working", step: "Read a.ts" })).toEqual({ done: false, ok: true, text: "Preparing the fix… Read a.ts" });
    expect(fixStatusText({ status: "failed", message: "no" }).text).toContain("Nothing was pushed");
    expect(fixStatusText({ status: "ready" }).text).toContain("Nothing has left your Mac yet");
  });
});
