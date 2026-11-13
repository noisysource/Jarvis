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
import { err, ok, type Result } from "../result.js";
import { codeAgentPrompt, WRAP_UP_PROMPT, type CodeAgent, type CodeAnswer, type CodeError } from "./agent.js";

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

/**
 * #150: how the agent signs in.
 * - "subscription": Claude Code's own login on this Mac (`claude`, then /login
 *   with his Claude account). No API key is passed, so it runs on his plan.
 *   His own questions only: guests never reach the code agent this way.
 * - "api-key": the Anthropic API key Jarvis already has.
 * - "auto": the subscription, and the API key if there's no login.
 */
export type CodeAuth = "subscription" | "api-key" | "auto";

const LOGIN_TROUBLE = /not logged in|log ?in|\/login|invalid api key|api key|authenticat|oauth|credential|401/i;

/** `query`: the SDK's, injected so tests don't start Claude Code. */
export const makeClaudeCodeAgent = (deps: { readonly apiKey?: string; readonly auth?: CodeAuth; readonly query?: QueryFn; readonly model?: string }): CodeAgent => {
  const auth = deps.auth ?? (deps.apiKey ? "api-key" : "subscription");

  const once = async (q: Parameters<CodeAgent["ask"]>[0], withKey: boolean): Promise<Result<CodeAnswer, CodeError>> => {
    const run: QueryFn = deps.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn);
    const controller = new AbortController();
    q.signal?.addEventListener("abort", () => controller.abort());
    let result: Record<string, unknown> | undefined;
    let keySource: unknown;
    let session: string | undefined;
    // Only what Claude Code needs to start and find its login; never Jarvis's other settings.
    const base = Object.fromEntries(
      (["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"] as const).flatMap((k) => (process.env[k] ? [[k, process.env[k] ?? ""]] : [])),
    ) as Record<string, string>;
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
          systemPrompt: codeAgentPrompt(q.maxTurns),
          maxTurns: q.maxTurns,
          maxBudgetUsd: q.maxUsd,
          ...(deps.model ? { model: deps.model } : {}),
          abortController: controller,
          env: {
            PATH: "/usr/bin:/bin",
            ...base,
            ...(withKey && deps.apiKey ? { ANTHROPIC_API_KEY: deps.apiKey } : {}),
            CLAUDE_AGENT_SDK_CLIENT_APP: "jarvis",
          },
        },
      })) {
        const m = message as Record<string, unknown>;
        if (m.type === "system" && m.subtype === "init") keySource = m.apiKeySource;
        if (typeof m.session_id === "string") session = m.session_id;
        if (m.type === "result") result = m;
      }
    } catch {
      // The SDK throws after an error result; the result says why, so use it when there is one.
      if (controller.signal.aborted) return err<CodeError>({ code: "cancelled", message: "Cancelled." });
      if (!result) return err<CodeError>({ code: withKey ? "agent" : "login", message: withKey ? "The code agent stopped with an error" : "Claude Code couldn't start with your Claude login" });
    }
    if (!result) return err<CodeError>({ code: "agent", message: "The code agent gave no answer" });
    const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
    const turns = typeof result.num_turns === "number" ? result.num_turns : 0;
    const via = withKey || (keySource !== undefined && keySource !== "none") ? "api-key" : "subscription";
    if (result.subtype === "error_max_budget_usd" || result.subtype === "error_max_turns") {
      const limit = result.subtype === "error_max_budget_usd" ? `the $${q.maxUsd.toFixed(2)} limit` : `the ${q.maxTurns}-step limit`;
      // Don't throw away what it read: one short call, no tools, to answer from it.
      const wrapped = session ? await wrapUp(session, q, withKey, base, run) : undefined;
      if (wrapped) return ok({ answer: wrapped.answer, costUsd: costUsd + wrapped.costUsd, turns: turns + 1, via, partial: true });
      return err<CodeError>({ code: "limit", message: `It hit ${limit} for one question before answering` });
    }
    if (result.subtype !== "success" || result.is_error === true || typeof result.result !== "string") {
      const loginTrouble = typeof result.result === "string" && LOGIN_TROUBLE.test(result.result);
      return err<CodeError>(
        loginTrouble
          ? withKey
            ? { code: "login", message: "The code agent couldn't sign in to Anthropic (check the API key)" }
            : { code: "login", message: "Claude Code isn't signed in to your Claude account on this Mac (run claude, then /login)" }
          : { code: "agent", message: "The code agent couldn't answer" },
      );
    }
    // "none" means no API key: it ran on the Claude login, i.e. his plan.
    return ok({ answer: result.result, costUsd, turns, via });
  };

  /**
   * What the wrap-up may cost, on top of the question's limit.
   */
  const wrapUpBudget = (maxUsd: number): number => Math.max(0.25, Math.round(maxUsd * 60) / 100);

  /**
   * The same session, resumed for one turn with no tools: "answer from what
   * you've read". Capped small. Undefined if that fails too.
   */
  const wrapUp = async (session: string, q: Parameters<CodeAgent["ask"]>[0], withKey: boolean, base: Record<string, string>, run: QueryFn): Promise<{ answer: string; costUsd: number } | undefined> => {
    let result: Record<string, unknown> | undefined;
    try {
      for await (const message of run({
        prompt: WRAP_UP_PROMPT,
        options: {
          resume: session,
          cwd: q.dir,
          tools: [],
          permissionMode: "default",
          canUseTool: async () => ({ behavior: "deny", message: "No more reading: answer now." }),
          settingSources: [],
          systemPrompt: codeAgentPrompt(q.maxTurns),
          maxTurns: 1,
          // Resuming re-sends everything it read, so this costs about as much as one more step over the whole lot.
          maxBudgetUsd: wrapUpBudget(q.maxUsd),
          ...(deps.model ? { model: deps.model } : {}),
          env: { PATH: "/usr/bin:/bin", ...base, ...(withKey && deps.apiKey ? { ANTHROPIC_API_KEY: deps.apiKey } : {}), CLAUDE_AGENT_SDK_CLIENT_APP: "jarvis" },
        },
      })) {
        const m = message as Record<string, unknown>;
        if (m.type === "result") result = m;
      }
    } catch {
      // fall through: use the result if there is one
    }
    if (!result || result.subtype !== "success" || result.is_error === true || typeof result.result !== "string" || result.result.trim() === "") return undefined;
    return { answer: result.result, costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0 };
  };

  return {
    name: "Claude Code",
    ask: async (q) => {
      if (auth === "api-key") return once(q, true);
      const first = await once(q, false);
      // auto: no Claude login on this Mac, so use the API key instead.
      if (auth === "auto" && !first.ok && first.error.code === "login" && deps.apiKey) return once(q, true);
      return first;
    },
  };
};
