// Local copies of his repos for the code agent (#126): data/repos/<owner>/<name>,
// gitignored, shallow (latest commit of the default branch only).
//
// git runs with the owner's read-only token passed in its environment for
// that one command, never in the URL or in .git/config, and never logged.
// A copy is refreshed when it's older than `freshMs`.

import { stat } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "../result.js";
import type { CodeError } from "./agent.js";

export type Run = (cmd: string, args: readonly string[], options: { readonly cwd?: string; readonly env: Record<string, string> }) => Promise<{ readonly code: number }>;

export type RepoCopies = {
  /** The repo's local folder, cloned or refreshed as needed. */
  readonly ensure: (owner: string, name: string, signal?: AbortSignal) => Promise<Result<string, CodeError>>;
};

/** git's environment for one command: the token as an HTTP header, nothing on disk. */
export const gitEnv = (token: string, base: Record<string, string | undefined> = process.env): Record<string, string> => ({
  PATH: base.PATH ?? "/usr/bin:/bin",
  HOME: base.HOME ?? "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

export const makeRepoCopies = (deps: {
  readonly root: string;
  readonly token: (owner: string) => Promise<string | undefined>;
  readonly run: Run;
  readonly now?: () => number;
  readonly freshMs?: number;
  readonly mtime?: (p: string) => Promise<number | undefined>;
}): RepoCopies => {
  const now = deps.now ?? Date.now;
  const fresh = deps.freshMs ?? 10 * 60_000;
  const mtime = deps.mtime ?? ((p: string) => stat(p).then((s) => s.mtimeMs, () => undefined));
  return {
    ensure: async (owner, name) => {
      const token = await deps.token(owner);
      if (!token) return err({ code: "not_connected", message: `No GitHub token for ${owner}: run npm run github:connect -- ${owner}` });
      const dir = path.join(deps.root, owner, name);
      const env = gitEnv(token);
      const fetched = await mtime(path.join(dir, ".git", "FETCH_HEAD"));
      const cloned = fetched ?? (await mtime(path.join(dir, ".git", "HEAD")));
      if (cloned === undefined) {
        const r = await deps.run("git", ["clone", "--depth", "1", "--quiet", "--no-tags", `https://github.com/${owner}/${name}.git`, dir], { env });
        return r.code === 0 ? ok(dir) : err({ code: "clone", message: `Couldn't copy ${owner}/${name} from GitHub` });
      }
      if (now() - cloned < fresh) return ok(dir);
      const f = await deps.run("git", ["fetch", "--depth", "1", "--quiet", "--no-tags", "origin", "HEAD"], { cwd: dir, env });
      if (f.code !== 0) return ok(dir); // offline or refused: the copy it has will do
      await deps.run("git", ["reset", "--hard", "--quiet", "FETCH_HEAD"], { cwd: dir, env });
      return ok(dir);
    },
  };
};
