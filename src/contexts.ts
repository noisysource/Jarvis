// Parses contexts.md into typed contexts, plus small helpers the classifier
// and ask handler use. Pure functions; the only I/O is in loadContexts, which
// takes its file reader as an argument.

import { err, ok, type Result } from "./result.js";
import type { Context, ContextId, ContextOption, ToolName, UnlessRule } from "./types.js";

const KNOWN_TOOLS: readonly ToolName[] = ["vendus"];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const FIELD_KEYS = [
  "name",
  "description",
  "data",
  "tools",
  "handling",
  "handoff to",
  "recognition cues",
  "unless",
  "aliases",
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];
const REPEATABLE: readonly FieldKey[] = ["unless"];

type Section = {
  readonly id: string;
  readonly line: number;
  readonly fields: ReadonlyMap<FieldKey, readonly string[]>;
};

// Only the contexts parser creates ContextIds.
const asContextId = (id: string): ContextId => id as ContextId;

const isFieldKey = (key: string): key is FieldKey =>
  (FIELD_KEYS as readonly string[]).includes(key);

const parseList = (value: string): string[] => {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length === 1 && items[0]?.toLowerCase() === "none" ? [] : items;
};

/** Splits the file into `## id` sections. Text before the first section is documentation. */
const splitSections = (markdown: string): { sections: Section[]; errors: string[] } => {
  const sections: Section[] = [];
  const errors: string[] = [];
  let current: { id: string; line: number; fields: Map<FieldKey, string[]> } | undefined;

  markdown.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();

    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      if (current) sections.push(current);
      current = { id: heading[1].trim(), line: lineNo, fields: new Map() };
      return;
    }
    if (!current || line === "") return;

    const field = /^([^:]+):\s*(.*)$/.exec(line);
    const key = field?.[1]?.trim().toLowerCase();
    const value = field?.[2]?.trim() ?? "";
    if (key === undefined) {
      errors.push(`line ${lineNo} (${current.id}): expected "Key: value", got "${line}"`);
      return;
    }
    if (!isFieldKey(key)) {
      errors.push(`line ${lineNo} (${current.id}): unknown field "${field?.[1]?.trim() ?? key}"`);
      return;
    }
    const existing = current.fields.get(key);
    if (existing && !REPEATABLE.includes(key)) {
      errors.push(`line ${lineNo} (${current.id}): "${key}" appears more than once`);
      return;
    }
    current.fields.set(key, [...(existing ?? []), value]);
  });

  if (current) sections.push(current);
  return { sections, errors };
};

const single = (section: Section, key: FieldKey): string | undefined => section.fields.get(key)?.[0];

const parseUnless = (
  section: Section,
  value: string,
): Result<{ words: string[]; target: string }, string> => {
  const parts = value.split("->");
  const words = parseList(parts[0] ?? "");
  const target = parts[1]?.trim() ?? "";
  if (parts.length !== 2 || words.length === 0 || target === "") {
    return err(`${section.id}: "Unless" must look like "word, word -> context-id", got "${value}"`);
  }
  return ok({ words, target });
};

type Draft = {
  readonly section: Section;
  readonly context: Omit<Context, "handling">;
  readonly handling:
    | { readonly kind: "answer" }
    | {
        readonly kind: "handoff";
        readonly to: string;
        readonly cues: readonly string[];
        readonly unless: readonly { words: string[]; target: string }[];
      };
};

/** Checks one section on its own (cross-references are checked afterwards). */
const draftContext = (section: Section): { draft?: Draft; errors: string[] } => {
  const errors: string[] = [];
  const where = `${section.id} (line ${section.line})`;

  if (!ID_PATTERN.test(section.id)) {
    errors.push(`${where}: id must be lowercase letters, digits and "-"`);
  }

  const required = (key: FieldKey, label: string): string => {
    const value = single(section, key);
    if (value === undefined || value === "") errors.push(`${where}: missing "${label}"`);
    return value ?? "";
  };
  const name = required("name", "Name");
  const description = required("description", "Description");
  const data = required("data", "Data");
  const toolsRaw = section.fields.has("tools") ? (single(section, "tools") ?? "") : undefined;
  if (toolsRaw === undefined) errors.push(`${where}: missing "Tools" (use "none" for no tools)`);

  const toolNames = parseList(toolsRaw ?? "");
  const unknownTools = toolNames.filter((t) => !(KNOWN_TOOLS as readonly string[]).includes(t));
  if (unknownTools.length > 0) {
    errors.push(`${where}: unknown tool(s) ${unknownTools.join(", ")} (known: ${KNOWN_TOOLS.join(", ")})`);
  }
  const tools = toolNames.filter((t): t is ToolName => (KNOWN_TOOLS as readonly string[]).includes(t));
  const aliases = parseList(single(section, "aliases") ?? "");
  const withAliases = aliases.length > 0 ? { aliases } : {};

  const handlingRaw = (single(section, "handling") ?? "answer").toLowerCase();
  const handoffTo = single(section, "handoff to");
  const cuesRaw = single(section, "recognition cues");
  const unlessRaw = section.fields.get("unless") ?? [];

  if (handlingRaw !== "answer" && handlingRaw !== "handoff") {
    errors.push(`${where}: "Handling" must be "answer" or "handoff"`);
  }

  if (handlingRaw === "handoff") {
    if (!handoffTo) errors.push(`${where}: a handoff context needs "Handoff to"`);
    if (tools.length > 0 || unknownTools.length > 0) {
      errors.push(`${where}: a handoff context can't have tools`);
    }
    const cues = parseList(cuesRaw ?? "");
    if (unlessRaw.length > 0 && cues.length === 0) {
      errors.push(`${where}: "Unless" needs "Recognition cues"`);
    }
    const unless = unlessRaw.flatMap((value) => {
      const parsed = parseUnless(section, value);
      if (!parsed.ok) {
        errors.push(parsed.error);
        return [];
      }
      return [parsed.value];
    });
    return errors.length > 0
      ? { errors }
      : {
          errors,
          draft: {
            section,
            context: { id: asContextId(section.id), name, description, data, tools, ...withAliases },
            handling: { kind: "handoff", to: handoffTo ?? "", cues, unless },
          },
        };
  }

  if (handoffTo !== undefined) errors.push(`${where}: "Handoff to" only applies to handoff contexts`);
  if (cuesRaw !== undefined) errors.push(`${where}: "Recognition cues" only apply to handoff contexts`);
  if (unlessRaw.length > 0) errors.push(`${where}: "Unless" only applies to handoff contexts`);

  return errors.length > 0
    ? { errors }
    : {
        errors,
        draft: {
          section,
          context: { id: asContextId(section.id), name, description, data, tools, ...withAliases },
          handling: { kind: "answer" },
        },
      };
};

/** Parses contexts.md. Returns every problem found, one per line, so the file can be fixed in one go. */
export const parseContexts = (markdown: string): Result<readonly Context[], string> => {
  const { sections, errors } = splitSections(markdown);

  if (sections.length === 0) {
    return err("contexts.md defines no contexts (expected \"## id\" sections)");
  }

  const seen = new Set<string>();
  sections.forEach((s) => {
    if (seen.has(s.id)) errors.push(`${s.id} (line ${s.line}): duplicate context id`);
    seen.add(s.id);
  });

  const drafts = sections.flatMap((section) => {
    const result = draftContext(section);
    errors.push(...result.errors);
    return result.draft ? [result.draft] : [];
  });

  const kindById = new Map(drafts.map((d) => [d.section.id, d.handling.kind]));

  const contexts = drafts.map((d): Context => {
    if (d.handling.kind === "answer") return { ...d.context, handling: { kind: "answer" } };
    const unless = d.handling.unless.flatMap(({ words, target }): UnlessRule[] => {
      const where = `${d.section.id} (line ${d.section.line})`;
      const kind = kindById.get(target);
      if (kind === undefined) {
        errors.push(`${where}: "Unless" points at unknown context "${target}"`);
        return [];
      }
      if (kind === "handoff") {
        errors.push(`${where}: "Unless" must point at an answered context, not "${target}"`);
        return [];
      }
      return [{ words, routeTo: asContextId(target) }];
    });
    return {
      ...d.context,
      handling: { kind: "handoff", to: d.handling.to, cues: d.handling.cues, unless },
    };
  });

  return errors.length > 0 ? err(errors.join("\n")) : ok(contexts);
};

/** Reads and parses contexts.md once, at startup. */
export const loadContexts = async (
  readFile: (path: string) => Promise<string>,
  path: string,
): Promise<Result<readonly Context[], string>> => {
  try {
    const parsed = parseContexts(await readFile(path));
    return parsed.ok ? parsed : err(`${path} is invalid:\n${parsed.error}`);
  } catch (e) {
    return err(`Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** Every context id, for the classifier's output enum (handoff contexts included as a backstop). */
export const classifierContextIds = (contexts: readonly Context[]): readonly ContextId[] =>
  contexts.map((c) => c.id);

/** One line per context for the classifier's system prompt. */
export const describeContexts = (contexts: readonly Context[]): string =>
  contexts.map((c) => `- ${c.id} (${c.name}): ${c.description}`).join("\n");

/** Options for a clarify response. Handoff contexts are never offered. */
export const clarifyOptions = (contexts: readonly Context[]): readonly ContextOption[] =>
  contexts
    .filter((c) => c.handling.kind === "answer")
    .map((c) => ({ id: c.id, name: c.name, ...(c.aliases && c.aliases.length > 0 ? { aliases: c.aliases } : {}) }));

/** The fixed reply for a handoff context. */
export const handoffMessage = (context: Context): string =>
  context.handling.kind === "handoff"
    ? `This is for ${context.handling.to}. I don't handle ${context.name} requests.`
    : "";
