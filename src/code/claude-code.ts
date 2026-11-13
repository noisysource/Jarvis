// The first code agent backend (#126): Claude Code, through the Claude Agent
// SDK, on this Mac.
//
// Read-only and boxed in:
// - its only tools are Read, Grep and Glob; nothing is auto-allowed, so every
//   call goes through `canUseTool`, which refuses any path outside the repo's
//   copy (Read can otherwise open any file on the Mac);
// - the repo's own Claude settings, CLAUDE.md hooks and skills are not loaded
//   (`settingSources: []`): a repo is untrusted and could ship hooks that run
//   commands;
// - a turn limit and a cost limit per question;
// - its environment is only PATH, HOME and the API key.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { err, ok } from "../result.js";
import { CODE_AGENT_PROMPT, type CodeAgent, type CodeAnswer, type CodeError } from "./agent.js";

const TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Whether a tool call stays inside `root`: the paths it names resolve under
 * it (after symlinks), and patterns are relative with no "..".
 */
export const insideRepo = async (root: string, tool: string, input: Record<string, unknown>, resolve: (p: string) => Promise<string> = realpath): Promise<boolean> => {
  if (!(TOOLS as readonly string[]).includes(tool)) return false;
  const base = await resolve(root).catch(() => undefined);
  if (!base) return false;
  const within = async (p: unknown): Promise<boolean> => {
    if (p === undefined) return true;
    if (typeof p !== "string" || p === "") return false;
    const full = path.resolve(base, p);
    // A file that doesn't exist yet can't be resolved; check its folder instead.
    const real = await resolve(full).catch(async () => path.join(await resolve(path.dirname(full)).catch(() => "/"), path.basename(full)));
    return real === base || real.startsWith(`${base}${path.sep}`);
  };
  const pattern = input.pattern;
  if (tool === "Glob" && (typeof pattern !== "string" || path.isAbsolute(pattern) || pattern.split(/[/\\]/).includes(".."))) return false;
  if (tool === "Grep" && typeof input.glob === "string" && (path.isAbsolute(input.glob) || input.glob.split(/[/\\]/).includes(".."))) return false;
  return (await within(input.file_path)) && (await within(input.path)) && (await within(input.notebook_path));
};

type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

/** `query`: the SDK's, injected so tests don't start Claude Code. */
export const makeClaudeCodeAgent = (deps: { readonly apiKey: string; readonly query?: QueryFn; readonly model?: string }): CodeAgent => ({
  name: "Claude Code",
  ask: async (q) => {
    const run: QueryFn = deps.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn);
    const controller = new AbortController();
    q.signal?.addEventListener("abort", () => controller.abort());
    let result: Record<string, unknown> | undefined;
    try {
      for await (const message of run({
        prompt: q.question,
        options: {
          cwd: q.dir,
          tools: [...TOOLS],
          disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"],
          permissionMode: "default",
          canUseTool: async (tool: string, input: Record<string, unknown>) =>
            (await insideRepo(q.dir, tool, input))
              ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: "Only reading and searching inside this repository is allowed." },
          settingSources: [],
          systemPrompt: CODE_AGENT_PROMPT,
          maxTurns: q.maxTurns,
          maxBudgetUsd: q.maxUsd,
          ...(deps.model ? { model: deps.model } : {}),
          abortController: controller,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "",
            ANTHROPIC_API_KEY: deps.apiKey,
            CLAUDE_AGENT_SDK_CLIENT_APP: "jarvis",
          },
        },
      })) {
        const m = message as Record<string, unknown>;
        if (m.type === "result") result = m;
      }
    } catch {
      // The SDK throws after an error result; the result says why, so use it when there is one.
      if (controller.signal.aborted) return err<CodeError>({ code: "cancelled", message: "Cancelled." });
      if (!result) return err<CodeError>({ code: "agent", message: "The code agent stopped with an error" });
    }
    if (!result) return err<CodeError>({ code: "agent", message: "The code agent gave no answer" });
    const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
    const turns = typeof result.num_turns === "number" ? result.num_turns : 0;
    if (result.subtype === "error_max_budget_usd") return err<CodeError>({ code: "limit", message: `It hit the $${q.maxUsd.toFixed(2)} limit for one question before answering` });
    if (result.subtype === "error_max_turns") return err<CodeError>({ code: "limit", message: `It hit the ${q.maxTurns}-step limit before answering` });
    if (result.subtype !== "success" || result.is_error === true || typeof result.result !== "string")
      return err<CodeError>({
        code: "agent",
        message: typeof result.result === "string" && /api key|authentication|401/i.test(result.result) ? "The code agent couldn't sign in to Anthropic (check the API key)" : "The code agent couldn't answer",
      });
    const answer: CodeAnswer = { answer: result.result, costUsd, turns };
    return ok(answer);
  },
});
