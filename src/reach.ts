// What Jarvis can reach (#133): for the brain view's node panels, each node's
// tools and, where there are accounts, which are connected. Read-only and
// content-free: names, on/off and counts only; never a token, an address, a
// title or a memory.

import { CALENDAR_ACCOUNTS, calendarTokensPath } from "./calendar/accounts.js";
import { noteKey, type CodeNote, type StudyState } from "./code/study.js";
import type { Config } from "./config.js";
import { GMAIL_ACCOUNTS } from "./gmail/gmail.js";

export type ReachTool = { readonly name: string; readonly does: string };
export type ReachAccount = { readonly name: string; readonly connected: boolean };
export type ReachNode = {
  readonly id: "profile" | "memory" | "skills" | "calendar" | "gmail" | "github" | "cloud" | "code" | "kiro";
  /** "on": in use; "off": built but switched off in .env; "soon": not built yet. */
  readonly status: "on" | "off" | "soon";
  /** One line about what it is, for the panel. */
  readonly about: string;
  readonly tools: readonly ReachTool[];
  readonly accounts?: readonly ReachAccount[];
  /** How to switch it on or connect it, when it isn't. */
  readonly hint?: string;
  /** Things waiting for Renato (draft skills). */
  readonly waiting?: number;
  /** #127: the code he has notes on, and what's being studied: names and states only. */
  readonly studied?: readonly { readonly name: string; readonly state: string }[];
};

export type ReachInput = {
  readonly config: Pick<Config, "bareMode" | "bareProfile" | "toolCalling" | "bareMemory" | "introspection" | "calendar" | "gmail" | "github" | "gcloud" | "codeAgent">;
  /** Whether a token file exists: connected, as far as Jarvis can tell without calling Google. */
  readonly exists: (path: string) => Promise<boolean>;
  /** How many draft skills wait for review. */
  readonly draftSkills?: () => Promise<number>;
  /** #125: the GitHub owners with a token. */
  readonly githubOwners?: () => Promise<readonly string[]>;
  /** #161: the Google Cloud environments with a key, and their projects. */
  readonly cloudEnvs?: () => Promise<readonly { readonly env: string; readonly project: string }[]>;
  /** #127: his code notes, and studies under way. */
  readonly studied?: () => Promise<{ readonly notes: readonly CodeNote[]; readonly active: readonly StudyState[] }>;
};

export const reachView = async (input: ReachInput): Promise<readonly ReachNode[]> => {
  const { config, exists } = input;
  const tools = config.bareMode && config.toolCalling;
  const onOff = (on: boolean): "on" | "off" => (on && tools ? "on" : "off");

  const calendarAccounts = await Promise.all(
    CALENDAR_ACCOUNTS.map(async (name) => ({ name, connected: await exists(calendarTokensPath(config.calendar.tokensPath, name)) })),
  );
  const gmailAccounts = await Promise.all(GMAIL_ACCOUNTS.map(async (name) => ({ name, connected: await exists(config.gmail.tokensPath(name)) })));
  const drafts = config.bareMemory && input.draftSkills ? await input.draftSkills().catch(() => 0) : 0;
  const githubOwners = config.github.enabled && input.githubOwners ? await input.githubOwners().catch(() => []) : [];
  const cloudEnvs = config.gcloud.enabled && input.cloudEnvs ? await input.cloudEnvs().catch(() => []) : [];
  const studied = config.codeAgent.enabled && input.studied ? await input.studied().catch(() => ({ notes: [], active: [] })) : { notes: [], active: [] };

  return [
    {
      id: "profile",
      status: config.bareMode && config.bareProfile ? "on" : "off",
      about: "Who you are, from data/profile.md on this Mac. It goes into every answer and is never committed or logged.",
      tools: [],
      ...(config.bareProfile ? {} : { hint: "PROFILE=on in .env" }),
    },
    {
      id: "memory",
      status: onOff(config.bareMemory),
      about: config.introspection
        ? "He notices things himself and recalls them when needed. Every night at 03:30, introspection keeps, promotes, merges or drops memories."
        : "He notices things himself and recalls them when needed. Nightly introspection is off.",
      tools: [
        { name: "memory_recall", does: "search his memory" },
        { name: "memory_remember", does: "keep something you said" },
        { name: "memory_forget", does: "forget something when you ask" },
      ],
      ...(config.bareMemory ? {} : { hint: "MEMORY=on in .env" }),
    },
    {
      id: "skills",
      status: onOff(config.bareMemory),
      about: "Routines he follows. New ones are drafts until you approve them.",
      tools: [
        { name: "skill_follow", does: "follow an approved skill" },
        { name: "skill_propose", does: "draft a new skill for your OK" },
      ],
      ...(drafts > 0 ? { waiting: drafts } : {}),
      ...(config.bareMemory ? {} : { hint: "MEMORY=on in .env" }),
    },
    {
      id: "calendar",
      status: onOff(config.calendar.enabled),
      about: config.calendar.write
        ? "Reads your calendars, and adds events only after you press Add it."
        : "Reads your calendars. Adding events is off (CALENDAR_WRITE=on).",
      tools: [
        { name: "calendar_read", does: "read days from one or all calendars" },
        ...(config.calendar.write ? [{ name: "calendar_create", does: "propose an event, added after your OK" }] : []),
      ],
      accounts: calendarAccounts,
      ...(config.calendar.enabled ? {} : { hint: "CALENDAR=on in .env" }),
    },
    {
      id: "gmail",
      status: onOff(config.gmail.enabled),
      about: config.gmail.write
        ? "Searches and reads your email. Drafts go out only after you press Send it. EC email shows only as \"handled by Kiro\"."
        : "Searches and reads your email, read-only. EC email shows only as \"handled by Kiro\".",
      tools: [
        { name: "gmail_search", does: "search one account" },
        { name: "gmail_read", does: "read one email" },
        ...(config.gmail.write
          ? [
              { name: "gmail_draft", does: "write a draft, sent after your OK" },
              { name: "gmail_draft_delete", does: "delete a draft he wrote, after your OK" },
            ]
          : []),
      ],
      accounts: gmailAccounts,
      ...(config.gmail.enabled ? {} : { hint: "GMAIL=on in .env" }),
    },
    {
      id: "github",
      status: onOff(config.github.enabled),
      about: "Reads your repositories, read-only: files, issues, pull requests and CI. Repos that look like EC work are Kiro's.",
      tools: [
        { name: "github_repos", does: "list your repos" },
        { name: "github_read", does: "read a file or list a folder" },
        { name: "github_issues", does: "list issues or pull requests" },
        { name: "github_checks", does: "CI results for a branch" },
      ],
      accounts: githubOwners.map((name) => ({ name, connected: true })),
      ...(config.github.enabled ? (githubOwners.length === 0 ? { hint: "npm run github:connect -- <owner>" } : {}) : { hint: "GITHUB=on in .env" }),
    },
    {
      id: "cloud",
      status: config.gcloud.enabled ? onOff(true) : "soon",
      about: "Reads errors, logs and the database (Firestore) of your Google Cloud environments, read-only, one environment at a time. He can't change or deploy anything. Email addresses are masked.",
      tools: [
        { name: "gcloud_errors", does: "recent errors, grouped" },
        { name: "gcloud_logs", does: "recent log entries" },
        { name: "gcloud_db_collections", does: "collection names in the database" },
        { name: "gcloud_db_query", does: "documents of a collection" },
        { name: "gcloud_db_get", does: "one document" },
      ],
      accounts: cloudEnvs.map((e) => ({ name: `${e.env} · ${e.project}`, connected: true })),
      ...(config.gcloud.enabled ? (cloudEnvs.length === 0 ? { hint: "npm run gcloud:connect -- dev <project-id>" } : {}) : { hint: "GCLOUD=on in .env" }),
    },
    {
      id: "code",
      status: config.codeAgent.enabled && config.bareMode && config.toolCalling ? "on" : config.github.enabled ? "off" : "soon",
      about: `Asks Claude Code about a repo: it reads a local copy (data/repos/) and can't change or run anything. ${
        config.codeAgent.auth === "api-key"
          ? "Runs on the API key."
          : config.codeAgent.auth === "subscription"
            ? "Runs on your Claude plan (Claude Code's login on this Mac)."
            : "Runs on your Claude plan when Claude Code is signed in on this Mac, otherwise on the API key."
      } Each question is capped at $${config.codeAgent.maxUsd.toFixed(2)} and ${config.codeAgent.maxTurns} steps; a study at $${config.codeAgent.study.maxUsd.toFixed(2)} and ${config.codeAgent.study.maxTurns} steps per repo or app.`,
      tools: [
        { name: "code_notes", does: "read his note on code he's studied" },
        { name: "code_study", does: "study a repo or app in the background" },
        { name: "code_ask", does: "ask a question about a repo's code" },
      ],
      studied: [
        ...studied.notes.map((n) => ({ name: noteKey(n.repo, n.folder), state: `studied ${n.studiedAt.slice(0, 10)}${n.partial ? " (partial)" : ""}` })),
        ...studied.active.map((s) => ({ name: noteKey(s.repo, s.folder), state: s.state === "failed" ? `failed: ${s.error ?? "error"}` : s.state === "running" ? "studying now…" : "waiting to be studied" })),
      ],
      ...(config.codeAgent.enabled ? {} : { hint: config.github.enabled ? "CODE_AGENT=on in .env" : "GITHUB=on and CODE_AGENT=on in .env" }),
    },
    {
      id: "kiro",
      status: "on",
      about: "European Commission / HRT work goes to Kiro, the EC's agent. Jarvis replies with the handoff and does nothing else: no answer model, no tools, no memory.",
      tools: [],
    },
  ];
};
