// Skills (#116): routines Jarvis follows, learned from memory or taught in chat.
//
// A skill is text: a title, when to use it, and its steps. It only says how to
// use tools Jarvis already has, so it can't add powers, and actions still need
// Renato's OK (the calendar's "Add it" card, for one).
//
// Where they come from: the nightly introspection drafts them (#108), or Claude
// proposes one in chat with skill_propose. Either way it's a draft until he
// approves it (a card in the chat, or the ✨ Skills panel). Active skills are
// listed in the prompt; Claude calls skill_follow to get one's steps, and the
// path line shows "✨ skill". Skills live in data/skills.json (gitignored,
// readable only by him). Logs carry counts and fixed words, never skill text.

import { randomBytes } from "node:crypto";
import { containsSecret, type EcMatchers } from "./memory-rules.js";
import type { LlmTool } from "./llm/types.js";
import { err, ok, type Result } from "./result.js";
import type { Logger, PathStep } from "./types.js";

export type SkillStatus = "draft" | "active";

export type Skill = {
  readonly id: string;
  readonly title: string;
  readonly when: string;
  readonly steps: readonly string[];
  readonly status: SkillStatus;
  readonly source: "introspection" | "chat";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type NewSkill = Pick<Skill, "title" | "when" | "steps" | "source">;

export const SKILL_LIMITS = { title: 80, when: 200, step: 200, steps: 12, skills: 100 } as const;

const clean = (s: string, max: number): string =>
  [...s]
    .map((c) => (c.charCodeAt(0) < 32 || c === "<" || c === ">" ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** The rules for a skill's text: sensible lengths, never secrets, never EC work (that's Kiro's). */
export const checkSkill = (value: unknown, ec: EcMatchers): Result<Pick<Skill, "title" | "when" | "steps">, string> => {
  if (typeof value !== "object" || value === null) return err("not understood");
  const v = value as Record<string, unknown>;
  const title = typeof v.title === "string" ? clean(v.title, SKILL_LIMITS.title + 1) : "";
  const when = typeof v.when === "string" ? clean(v.when, SKILL_LIMITS.when + 1) : "";
  const steps = Array.isArray(v.steps) ? v.steps.map((s) => (typeof s === "string" ? clean(s, SKILL_LIMITS.step + 1) : "")).filter((s) => s !== "") : [];
  if (title === "" || when === "" || steps.length === 0) return err("it needs a title, when to use it, and at least one step");
  if (title.length > SKILL_LIMITS.title || when.length > SKILL_LIMITS.when || steps.some((s) => s.length > SKILL_LIMITS.step) || steps.length > SKILL_LIMITS.steps)
    return err(`keep it short: a title, one sentence for when, and at most ${SKILL_LIMITS.steps} one-line steps`);
  const all = [title, when, ...steps].join(" ");
  if (containsSecret(all)) return err("it contains something like a password, key or account number");
  if (ec.mentionsEc(all) || ec.mentionsForbidden(all)) return err("it's about European Commission work, which is Kiro's");
  return ok({ title, when, steps });
};

const normalise = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type SkillStore = {
  readonly list: () => Promise<readonly Skill[]>;
  readonly get: (id: string) => Promise<Skill | undefined>;
  /** Adds a draft. A skill with the same title is updated instead (and stays as it was: draft or active). */
  readonly propose: (skill: NewSkill) => Promise<Skill>;
  readonly approve: (id: string) => Promise<Skill | undefined>;
  readonly remove: (id: string) => Promise<boolean>;
};

/**
 * Skills in one JSON file. `files` is injected (tests use memory); the real one
 * writes with mode 600. Writes are serialised so two changes can't race.
 */
export const makeSkillStore = (deps: {
  readonly read: () => Promise<string | undefined>;
  readonly write: (text: string) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}): SkillStore => {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomBytes(9).toString("hex"));
  let cache: Skill[] | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<Skill[]> => {
    if (cache) return cache;
    const text = await deps.read();
    const parsed: unknown = text ? JSON.parse(text) : [];
    cache = (Array.isArray(parsed) ? parsed : []).filter(
      (s): s is Skill => typeof s === "object" && s !== null && typeof (s as Skill).id === "string" && Array.isArray((s as Skill).steps),
    );
    return cache;
  };
  const change = <T>(fn: (skills: Skill[]) => { next: Skill[]; result: T }): Promise<T> => {
    const run = queue.then(async () => {
      const { next, result } = fn(await load());
      cache = next;
      await deps.write(JSON.stringify(next, null, 2));
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    list: async () => [...(await load())],
    get: async (id) => (await load()).find((s) => s.id === id),
    propose: (skill) =>
      change((skills) => {
        const at = now().toISOString();
        const same = skills.find((s) => normalise(s.title) === normalise(skill.title));
        if (same) {
          const updated: Skill = { ...same, when: skill.when, steps: skill.steps, updatedAt: at };
          return { next: skills.map((s) => (s.id === same.id ? updated : s)), result: updated };
        }
        const added: Skill = { id: newId(), ...skill, status: "draft", createdAt: at, updatedAt: at };
        return { next: [added, ...skills].slice(0, SKILL_LIMITS.skills), result: added };
      }),
    approve: (id) =>
      change((skills) => {
        const s = skills.find((x) => x.id === id);
        if (!s) return { next: skills, result: undefined };
        const active: Skill = { ...s, status: "active", updatedAt: now().toISOString() };
        return { next: skills.map((x) => (x.id === id ? active : x)), result: active };
      }),
    remove: (id) =>
      change((skills) => {
        const next = skills.filter((s) => s.id !== id);
        return { next, result: next.length !== skills.length };
      }),
  };
};

export const SKILL_PROPOSE_TOOL: LlmTool = {
  name: "skill_propose",
  description:
    "Propose a new skill: a routine for a task they do again and again, as a title, when to use it, and short steps using the tools you have. It's only a draft: they approve it before you'll follow it. Use it when they ask to make something a skill or to remember how to do a task.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      when: { type: "string", description: "When to use it, one sentence" },
      steps: { type: "array", items: { type: "string" }, description: "Short steps, in order" },
    },
    required: ["title", "when", "steps"],
    additionalProperties: false,
  },
};

export const SKILL_FOLLOW_TOOL: LlmTool = {
  name: "skill_follow",
  description: "Get the steps of one of their approved skills (listed in the prompt), when a request matches its 'when'. Then follow them with your tools.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};

/** The approved skills, for the end of the prompt. Undefined when there are none. */
export const skillsForPrompt = (skills: readonly Skill[]): string | undefined => {
  const active = skills.filter((s) => s.status === "active");
  if (active.length === 0) return undefined;
  return [
    "<skills>",
    "Skills they approved (routines; call skill_follow with the id when a request matches, then follow the steps):",
    ...active.map((s) => `- id=${s.id} · ${s.title} · when: ${s.when}`),
    "</skills>",
  ].join("\n");
};

/** The skill tools for one answer. */
export const makeSkillTurn = (deps: { readonly store: SkillStore; readonly ec: EcMatchers; readonly log?: Logger }, turn: { readonly onStep?: (s: PathStep) => void }) => {
  const propose = async (input: unknown): Promise<{ content: string; isError?: boolean }> => {
    const checked = checkSkill(input, deps.ec);
    if (!checked.ok) {
      deps.log?.info("skill propose refused", { why: checked.error.slice(0, 40) });
      turn.onStep?.({ kind: "skill", name: "skill_propose", args: "", by: "model", ok: false, error: "refused" });
      return { content: `Not proposed: ${checked.error}.`, isError: true };
    }
    const skill = await deps.store.propose({ ...checked.value, source: "chat" });
    deps.log?.info("skill proposed", { steps: skill.steps.length, status: skill.status });
    turn.onStep?.({
      kind: "skill",
      name: "skill_propose",
      args: "",
      by: "model",
      ok: true,
      result: skill.status === "active" ? "updated" : "draft, waiting for your OK",
      ...(skill.status === "draft" ? { confirm: { id: skill.id, label: `${skill.title}: ${skill.steps.length} step${skill.steps.length === 1 ? "" : "s"}, when ${skill.when}`, kind: "skill" as const } } : {}),
    });
    return {
      content:
        skill.status === "active"
          ? "Updated that approved skill's steps."
          : "Saved as a draft. The app is showing them a card to approve it; say in one short sentence what the skill does and that it needs their OK. Don't say it's active.",
    };
  };
  const follow = async (input: unknown): Promise<{ content: string; isError?: boolean }> => {
    const id = typeof input === "object" && input !== null && typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id : "";
    const skill = await deps.store.get(id);
    if (!skill || skill.status !== "active") {
      turn.onStep?.({ kind: "skill", name: "skill_follow", args: "", by: "model", ok: false, error: "not an approved skill" });
      return { content: "That isn't one of their approved skills. Answer without it.", isError: true };
    }
    deps.log?.info("skill followed", { steps: skill.steps.length });
    turn.onStep?.({ kind: "skill", name: skill.title, args: "", by: "model", ok: true, result: "followed" });
    return {
      content: [`Skill "${skill.title}" (approved by them). Follow these steps with your tools; any action still needs their OK:`, ...skill.steps.map((s, i) => `${i + 1}. ${s}`)].join("\n"),
    };
  };
  return { propose, follow };
};

/** What the page gets: the skills, drafts first. */
export const skillsView = (skills: readonly Skill[]): readonly Skill[] => [...skills.filter((s) => s.status === "draft"), ...skills.filter((s) => s.status === "active")];
