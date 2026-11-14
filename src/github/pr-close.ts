// Closing a pull request, after Renato's OK (#183).
//
// Claude asks with github_pr_close; nothing happens then: the app shows a
// card, "Close it" / "Keep it". On "Close it", code reads the pull request
// (it must be open, in that repo), closes it, and deletes its branch only
// when it's one of Jarvis's own (jarvis/… in the same repo). Never merges,
// never deletes any other branch. Uses the owner's write token (#162).

import { randomBytes } from "node:crypto";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";

export const GITHUB_PR_CLOSE_TOOL: LlmTool = {
  name: "github_pr_close",
  description:
    "Close a pull request in one of his repos (not merge). Nothing happens by this call: it shows him a card, so call it directly instead of asking in words. If the branch is one of yours (jarvis/…), it's deleted too.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: 'The repo as "owner/name"' },
      number: { type: "number", description: "The pull request's number" },
    },
    required: ["repo", "number"],
    additionalProperties: false,
  },
};

const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/;

export type PrCloseRequest = { readonly owner: string; readonly name: string; readonly number: number };

export const checkPrClose = (v: unknown): Result<PrCloseRequest, string> => {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const repo = typeof o.repo === "string" && !o.repo.includes("..") ? REPO.exec(o.repo.trim()) : null;
  if (!repo) return err("not a repo (owner/name)");
  if (typeof o.number !== "number" || !Number.isInteger(o.number) || o.number < 1 || o.number > 999_999) return err("not a pull request number");
  return ok({ owner: repo[1] ?? "", name: repo[2] ?? "", number: o.number });
};

/** Only Jarvis's own branches are deleted: jarvis/ and nothing odd after it. */
export const isJarvisBranch = (ref: string): boolean => /^jarvis\/[A-Za-z0-9._-]{1,120}$/.test(ref);

export type PrCloser = {
  readonly canWrite: (owner: string) => Promise<boolean>;
  readonly propose: (r: PrCloseRequest) => string;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

export const makePrCloser = (deps: {
  readonly writeToken: (owner: string) => Promise<string | undefined>;
  readonly isEc: (text: string) => boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: Logger;
}): PrCloser => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const pending = new Map<string, { r: PrCloseRequest; until: number }>();

  return {
    canWrite: async (owner) => (await deps.writeToken(owner)) !== undefined,
    propose: (r) => {
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const id = newId();
      pending.set(id, { r, until: now() + 30 * 60_000 });
      return id;
    },
    decide: async (id, decision) => {
      const got = pending.get(id);
      pending.delete(id);
      if (!got || got.until <= now()) return { ok: false, text: "That request has expired or was already answered, so nothing was closed." };
      if (decision === "no") return { ok: true, text: "Okay, I've left it open." };
      const { owner, name, number } = got.r;
      const where = `${owner}/${name}#${number}`;
      if (deps.isEc(`${owner}/${name}`)) return { ok: false, text: "That's an EC repo, which Kiro handles, so nothing was closed." };
      const token = await deps.writeToken(owner);
      if (!token) return { ok: false, text: `I can't write to ${owner}'s repos: run npm run github:connect -- ${owner} --write. Nothing was closed.` };
      const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "jarvis" };
      const base = `https://api.github.com/repos/${owner}/${name}`;
      const read = await doFetch(`${base}/pulls/${number}`, { headers }).catch(() => undefined);
      const pr = read?.ok ? ((await read.json().catch(() => ({}))) as { state?: unknown; merged?: unknown; head?: { ref?: unknown; repo?: { full_name?: unknown } } }) : undefined;
      if (!pr) return { ok: false, text: `I couldn't find pull request ${where}, so nothing was closed.` };
      if (pr.state !== "open") return { ok: true, text: `${where} is already ${pr.merged === true ? "merged" : "closed"}.` };
      const closed = await doFetch(`${base}/pulls/${number}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ state: "closed" }) }).catch(() => undefined);
      if (!closed?.ok) {
        deps.log?.warn("pr close failed", { repo: `${owner}/${name}`, status: closed?.status ?? 0 });
        return { ok: false, text: `GitHub didn't close ${where}${closed ? ` (${closed.status}; the write token needs Pull requests: Read and write)` : ""}.` };
      }
      const ref = typeof pr.head?.ref === "string" ? pr.head.ref : "";
      const sameRepo = typeof pr.head?.repo?.full_name === "string" && pr.head.repo.full_name.toLowerCase() === `${owner}/${name}`.toLowerCase();
      let branch = "";
      if (sameRepo && isJarvisBranch(ref)) {
        const deleted = await doFetch(`${base}/git/refs/heads/${ref.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE", headers }).catch(() => undefined);
        branch = deleted?.ok || deleted?.status === 204 ? ` and deleted its branch ${ref}` : `; its branch ${ref} is still there (GitHub didn't delete it)`;
      }
      deps.log?.info("pr closed", { repo: `${owner}/${name}`, branchDeleted: branch.startsWith(" and") });
      return { ok: true, text: `Closed ${where}${branch}. Nothing was merged.`, tool: `github_pr_close ${where}` };
    },
  };
};
