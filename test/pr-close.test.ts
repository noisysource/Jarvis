// #183: closing a pull request, after Renato's OK.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import type { GithubReader } from "../src/github/github.js";
import { checkPrClose, isJarvisBranch, makePrCloser } from "../src/github/pr-close.js";
import type { LlmCall, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const isEc = (t: string) => /\bhrt\b/i.test(t);

const github = (pr: Record<string, unknown> | undefined, over: { patch?: number; del?: number } = {}) => {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace("https://api.github.com", "")}`);
    if (method === "GET") return pr ? new Response(JSON.stringify(pr)) : new Response("{}", { status: 404 });
    if (method === "PATCH") return new Response("{}", { status: over.patch ?? 200 });
    return new Response(null, { status: over.del ?? 204 });
  }) as typeof fetch;
  return { calls, fetchFn };
};

const own = { state: "open", merged: false, head: { ref: "jarvis/fix-title-531727", repo: { full_name: "noisysource/Jarvis" } } };

describe("checking a close request", () => {
  it("a plain repo and a whole number", () => {
    expect(checkPrClose({ repo: "noisysource/Jarvis", number: 180 })).toEqual(ok({ owner: "noisysource", name: "Jarvis", number: 180 }));
    expect(checkPrClose({ repo: "noisysource/../x", number: 1 }).ok).toBe(false);
    expect(checkPrClose({ repo: "noisysource/Jarvis", number: 1.5 }).ok).toBe(false);
    expect(checkPrClose({ repo: "noisysource/Jarvis", number: "180" }).ok).toBe(false);
  });

  it("only Jarvis's own branches are ever deleted", () => {
    expect(isJarvisBranch("jarvis/fix-title-531727")).toBe(true);
    expect(isJarvisBranch("main")).toBe(false);
    expect(isJarvisBranch("claude/code-fix")).toBe(false);
    expect(isJarvisBranch("jarvis/../main")).toBe(false);
  });
});

describe("closing after his OK", () => {
  const closer = (pr: Record<string, unknown> | undefined, over: { patch?: number; del?: number } = {}, token: string | null = "ghp_w") => {
    const g = github(pr, over);
    let n = 0;
    return { ...g, closer: makePrCloser({ writeToken: async () => token ?? undefined, isEc, fetch: g.fetchFn, newId: () => `id${(n += 1)}` }) };
  };
  const req = { owner: "noisysource", name: "Jarvis", number: 180 };

  it("nothing happens until he says so; then it's closed and his own branch deleted", async () => {
    const { closer: c, calls } = closer(own);
    const id = c.propose(req);
    expect(calls).toEqual([]);
    expect(await c.decide(id, "yes")).toEqual({ ok: true, text: "Closed noisysource/Jarvis#180 and deleted its branch jarvis/fix-title-531727. Nothing was merged.", tool: "github_pr_close noisysource/Jarvis#180" });
    expect(calls).toEqual(["GET /repos/noisysource/Jarvis/pulls/180", "PATCH /repos/noisysource/Jarvis/pulls/180", "DELETE /repos/noisysource/Jarvis/git/refs/heads/jarvis/fix-title-531727"]);
    // Single use.
    expect((await c.decide(id, "yes")).ok).toBe(false);
  });

  it("someone else's branch, or one from a fork, is left alone", async () => {
    for (const head of [{ ref: "feature/x", repo: { full_name: "noisysource/Jarvis" } }, { ref: "jarvis/fix-x", repo: { full_name: "someone/Jarvis" } }]) {
      const { closer: c, calls } = closer({ ...own, head });
      expect((await c.decide(c.propose(req), "yes")).text).toBe("Closed noisysource/Jarvis#180. Nothing was merged.");
      expect(calls.some((x) => x.startsWith("DELETE"))).toBe(false);
    }
  });

  it('"Keep it", an already closed PR, a missing token or a refusal are said plainly', async () => {
    const a = closer(own);
    expect(await a.closer.decide(a.closer.propose(req), "no")).toEqual({ ok: true, text: "Okay, I've left it open." });
    expect(a.calls).toEqual([]);
    const b = closer({ ...own, state: "closed", merged: true });
    expect((await b.closer.decide(b.closer.propose(req), "yes")).text).toBe("noisysource/Jarvis#180 is already merged.");
    const c = closer(own, {}, null);
    expect((await c.closer.decide(c.closer.propose(req), "yes")).text).toContain("github:connect -- noisysource --write");
    const d = closer(own, { patch: 403 });
    expect(await d.closer.decide(d.closer.propose(req), "yes")).toMatchObject({ ok: false, text: expect.stringContaining("Pull requests: Read and write") });
    expect(d.calls.some((x) => x.startsWith("DELETE"))).toBe(false);
  });
});

describe("Claude asking to close", () => {
  it("only proposes: a card on the path, nothing sent to GitHub", async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "c1", name: "github_pr_close", input: { repo: "noisysource/Jarvis", number: 180 } }] },
      { ...common, kind: "text", text: "It needs your OK." },
    ];
    let i = 0;
    const llm: LlmCall = async () => ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    const reader: GithubReader = { owners: async () => ["noisysource"], repos: async () => ok([]), read: async () => err({ code: "not_found", message: "x" }), issues: async () => ok([]), checks: async () => ok({ ref: "main", checks: [] }) };
    const g = github(own);
    const prs = makePrCloser({ writeToken: async () => "ghp_w", isEc, fetch: g.fetchFn, newId: () => "card1" });
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, github: { reader, isEc, prs } })({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "close PR 180 in Jarvis", history: [], memories: [], now: new Date(), onStep: (s) => steps.push(s) });
    expect(steps[0]).toEqual({ kind: "tool", name: "github_pr_close", args: "noisysource/Jarvis#180", by: "model", ok: true, result: "waiting for your OK", confirm: { id: "card1", label: "noisysource/Jarvis#180", kind: "pr-close" } });
    expect(g.calls).toEqual([]);
  });
});
