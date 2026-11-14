// Which tools Claude gets for a question (#175). Pure, apart from the router call.
//
// Offering every connected tool on every question cost tokens on every turn,
// hit Anthropic's limits (#174), and gave Claude more ways to pick wrong. So
// tools come in groups, and Jarvis picks the groups before Claude sees the
// question:
//   - a dictionary of words (English and Portuguese, plus the studied apps),
//   - the groups his last answers used (follow-ups: "and tomorrow?"),
//   - and, in parallel, a one-word question to a small model.
// If a guess was wrong, Claude asks for a group with tools_more: one more
// step, never a wrong "I can't". Memory and skills aren't routed: they're
// small and he must be able to remember at any time.

import type { LlmCall, LlmTool } from "../llm/types.js";
import type { Logger } from "../types.js";

export type ToolGroup = "calendar" | "gmail" | "github" | "code" | "cloud" | "invoices" | "house";

/** In the order tools are offered: a fixed order keeps the same choice cacheable. */
export const TOOL_GROUPS: readonly ToolGroup[] = ["calendar", "gmail", "github", "code", "cloud", "invoices", "house"];

/** One line each, for the router and for tools_more. */
export const GROUP_ABOUT: Record<ToolGroup, string> = {
  calendar: "his calendars: what's on, free time, booking",
  gmail: "his email: search, read, draft, delete drafts",
  github: "his GitHub repos: files, issues, pull requests, CI checks",
  code: "understanding his code: notes on studied repos and apps, studying, asking the code agent",
  cloud: "his Google Cloud environments: errors, logs and the database",
  invoices: "KidClub's invoices in Vendus: totals, VAT, one invoice",
  house: "the house now: heating, heat pump, temperatures, solar, battery, energy",
};

export const TOOLS_MORE = "tools_more";

export type RouterMode = "model" | "rules" | "all";

/** The group a tool belongs to; undefined for tools that are always offered. */
export const groupOfTool = (name: string): ToolGroup | undefined => {
  if (name.startsWith("calendar_") || name === "day_brief") return "calendar";
  if (name.startsWith("gmail_")) return "gmail";
  if (name.startsWith("github_")) return "github";
  if (name.startsWith("code_")) return "code";
  if (name.startsWith("gcloud_")) return "cloud";
  if (name.startsWith("vendus_")) return "invoices";
  if (name.startsWith("house_")) return "house";
  return undefined;
};

/** Lower case, no accents, so "reunião" and "reuniao" match the same word. */
export const normalise = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** A word list as one pattern: whole words, "*" at the end of a word for any ending. */
const words = (list: string): RegExp =>
  new RegExp(
    `\\b(?:${list
      .trim()
      .split(/\s*,\s*/)
      .map((w) => w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+").replace(/\*$/, "\\w*"))
      .join("|")})\\b`,
  );

/** Words that point at a group. Over-including costs a few tools; missing costs a tools_more step. */
const RULES: readonly { readonly pattern: RegExp; readonly groups: readonly ToolGroup[] }[] = [
  {
    pattern: words(`
      calendar*, agenda*, brief*, resumo*, anything i should know, good morning, bom dia, meeting*, appointment*, schedul*, book, booked, booking, free, busy, availab*, event*,
      today, tonight, tomorrow, yesterday, week*, weekend*, month, morning, afternoon, evening,
      monday, tuesday, wednesday, thursday, friday, saturday, sunday, plate, invite*, call, calls,
      calendario*, reuniao, reunioes, marcacao, marcar, marca, livre, ocupado, evento*, hoje, amanha, ontem, semana*,
      manha, tarde, noite, segunda, terca, quarta, quinta, sexta, sabado, domingo, convite*, chamada*`),
    groups: ["calendar"],
  },
  {
    pattern: words(`
      email*, e-mail*, mail*, inbox, unread, message*, repl*, draft*, send, sent, wrote, newsletter*, sender, subject,
      correio*, mensage*, rascunho*, responde*, enviar, envia*, escreveu, caixa de entrada`),
    groups: ["gmail"],
  },
  {
    // Passing a message on: "tell Sam…", "let Ana know…", "write to…", "avisa a Marisa…".
    pattern: /\b(?:tell (?!me\b|us\b)\w+|let \w+ know|write to|get back to|follow up with|avisa\w*|diz(?:e|er)? (?:a|ao|a)\b|escreve\w* (?:a|ao|para)\b)/,
    groups: ["gmail"],
  },
  {
    pattern: words(`
      github, git, repo, repos, repositor*, pull request*, pr, prs, issue*, commit*, branch*, merge*, ci, check, checks,
      workflow*, pipeline*, build*, actions, release*`),
    groups: ["github"],
  },
  {
    pattern: words(`
      code, codebase, coding, architectur*, module*, function*, file*, folder*, implement*, refactor*, stud*, how does,
      how do, where is, bug*, feature*, endpoint*, component*, api, apis, monorepo, codigo*, arquitetura, funcionalidade*, estudar, estuda*`),
    groups: ["code"],
  },
  {
    pattern: words(`
      cloud, gcp, google cloud, log, logs, logging, firestore, database, db, collection*, document*, dev, staging, prod,
      production, deploy*, server*, base de dados, colec*, producao`),
    groups: ["cloud"],
  },
  {
    pattern: words(`
      invoic*, billed, billing, revenue, sales, turnover, vat, receipt*, credit note*, vendus, earned, income,
      fatura*, faturacao, faturamos, faturado*, faturei, recibo*, receita*, vendas, iva, nota de credito, notas de credito, ganhamos, quanto ganh*`),
    groups: ["invoices"],
  },
  {
    pattern: words(`
      house, home, heating, heater, heat pump, pump, thermostat*, temperature*, warm*, cold, room*, solar, panel*, battery,
      inverter, energy, power, electricity, consumption, grid, domotics,
      casa, aquecimento, aquecer, bomba, termostato*, temperatura*, frio, quente, quarto*, sala, painei*, paineis, bateria,
      energia, eletricidade, consumo, rede`),
    groups: ["house"],
  },
  {
    // Something failing: where it shows (logs, CI) and where the cause is (code).
    pattern: words(`
      error*, fail*, crash*, broken, break*, down, wrong with, not working, isn't working, doesn't work, exception*, 500,
      erro, erros, falh*, partiu, avaria*, nao funciona`),
    groups: ["cloud", "github", "code"],
  },
];

/**
 * The groups the words of a question point at. `apps`: names of studied
 * repos and apps ("kidclub", "finances"); naming one points at its code.
 */
export const groupsByWords = (question: string, apps: readonly string[] = []): readonly ToolGroup[] => {
  const text = normalise(question);
  const found = new Set<ToolGroup>();
  for (const rule of RULES) if (rule.pattern.test(text)) for (const g of rule.groups) found.add(g);
  const appNames = apps.map(normalise).filter((a) => /^[a-z0-9][a-z0-9 _-]{1,40}$/.test(a));
  if (appNames.length > 0 && words(appNames.join(", ")).test(text)) {
    found.add("code");
    found.add("github");
  }
  return TOOL_GROUPS.filter((g) => found.has(g));
};

/** The groups the last answers used, from the history's record of tools that ran (e.g. "calendar_read today"). */
export const groupsUsedLately = (history: readonly { readonly role: string; readonly tools?: readonly string[] }[], answers = 2): readonly ToolGroup[] => {
  const recent = history.filter((t) => t.role === "assistant").slice(-answers);
  const used = new Set(recent.flatMap((t) => (t.tools ?? []).map((x) => groupOfTool(x.split(/\s/)[0] ?? "")).filter((g): g is ToolGroup => g !== undefined)));
  return TOOL_GROUPS.filter((g) => used.has(g));
};

/** What the router answered: group names, "none", or anything else (ignored). */
export const parseRoute = (text: string, available: readonly ToolGroup[]): readonly ToolGroup[] => {
  const said = new Set(normalise(text).split(/[^a-z]+/));
  return available.filter((g) => said.has(g));
};

export type RouteInput = {
  readonly question: string;
  readonly history: readonly { readonly role: string; readonly text: string }[];
  readonly available: readonly ToolGroup[];
  readonly signal?: AbortSignal;
};
/** Undefined when it couldn't answer in time; the words alone decide then. */
export type ToolRouter = (input: RouteInput) => Promise<readonly ToolGroup[] | undefined>;

const ROUTER_TIMEOUT_MS = 4000;
const ROUTER_HISTORY = 4;

/**
 * Asks a small model which groups a question needs: one short call, no
 * tools, no thinking. It sees the question and the last few turns (cut
 * short), never the profile or memory.
 */
export const makeToolRouter =
  (deps: { readonly llm: LlmCall; readonly log?: Logger; readonly timeoutMs?: number }): ToolRouter =>
  async ({ question, history, available, signal }) => {
    if (available.length === 0) return [];
    if (signal?.aborted) return undefined;
    const recent = history.slice(-ROUTER_HISTORY).map((t) => `${t.role === "user" ? "Renato" : "Jarvis"}: ${t.text.replace(/\s+/g, " ").slice(0, 300)}`);
    const call = deps
      .llm({
        system: [
          "You pick which tool groups a personal assistant needs to answer the newest question. The groups:",
          ...available.map((g) => `${g}: ${GROUP_ABOUT[g]}`),
          'Answer with the group names it needs, separated by spaces, or "none" for anything the assistant can answer by talking (greetings, opinions, general knowledge, things about Renato he already knows). Pick every group that could plausibly be needed. Only the names, nothing else.',
        ].join("\n"),
        messages: [{ role: "user", text: [...(recent.length > 0 ? ["Conversation so far:", ...recent, ""] : []), `Newest question: ${question.slice(0, 1000)}`].join("\n") }],
        effort: "low",
        thinking: "off",
        maxTokens: 20,
      })
      .then((result) => {
        if (result.ok && result.value.kind === "text") return parseRoute(result.value.text, available);
        deps.log?.info("tool router gave no answer", { kind: result.ok ? result.value.kind : result.error.kind });
        return undefined;
      })
      .catch(() => undefined);
    // Late is the same as no answer: the words decide, and the question isn't held up.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        deps.log?.info("tool router too slow", { ms: deps.timeoutMs ?? ROUTER_TIMEOUT_MS });
        resolve(undefined);
      }, deps.timeoutMs ?? ROUTER_TIMEOUT_MS);
    });
    try {
      return await Promise.race([call, late]);
    } finally {
      clearTimeout(timer);
    }
  };

/** The safety net: ask for a group that wasn't offered. Only offered while some group is missing. */
export const toolsMoreTool = (missing: readonly ToolGroup[]): LlmTool => ({
  name: TOOLS_MORE,
  description: `Adds a group of tools that isn't offered for this question. Not offered now: ${missing.map((g) => `${g} (${GROUP_ABOUT[g]})`).join("; ")}. If the question needs one of them, call this first, then use the tools it adds. Never say you can't do something one of these groups can do.`,
  inputSchema: { type: "object", properties: { group: { type: "string", enum: [...missing] } }, required: ["group"], additionalProperties: false },
});

/** The choice: what the words, the last answers and the router said, kept to what's connected, in a fixed order. */
export const pickGroups = (input: {
  readonly available: readonly ToolGroup[];
  readonly words: readonly ToolGroup[];
  readonly lately: readonly ToolGroup[];
  readonly router?: readonly ToolGroup[];
}): readonly ToolGroup[] => {
  const all = new Set([...input.words, ...input.lately, ...(input.router ?? [])]);
  return input.available.filter((g) => all.has(g));
};
