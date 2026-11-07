// The `npm run memory` command line (#62): parsing and formatting, pure, so
// it can be tested. scripts/memory.ts does the I/O.
//
//   npm run memory -- list [--context personal] [--kind fact|playbook|history]
//   npm run memory -- delete <id>
//   npm run memory -- wipe --context kidclub [--yes]
//   npm run memory -- export [--context personal]

import type { Memory, MemoryKind } from "./types.js";

export type MemoryCommand =
  | { readonly command: "list"; readonly context?: string; readonly kind?: MemoryKind }
  | { readonly command: "delete"; readonly id: string }
  | { readonly command: "wipe"; readonly context: string; readonly yes: boolean }
  | { readonly command: "export"; readonly context?: string }
  | { readonly command: "help" };

export const MEMORY_USAGE = [
  "Usage:",
  "  npm run memory -- list [--context <id>] [--kind fact|playbook|history]",
  "  npm run memory -- delete <id>",
  "  npm run memory -- wipe --context <id> [--yes]",
  "  npm run memory -- export [--context <id>]   (JSON on screen; nothing is written to a file)",
].join("\n");

const KINDS: readonly MemoryKind[] = ["fact", "playbook", "history"];

/** Reads the arguments after `npm run memory --`. Errors are messages for the user. */
export const parseMemoryArgs = (argv: readonly string[]): { ok: true; value: MemoryCommand } | { ok: false; error: string } => {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (arg === "--yes") flags.set("yes", true);
    else if (arg.startsWith("--")) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} needs a value` };
      flags.set(arg.slice(2), value);
      i += 1;
    } else positional.push(arg);
  }
  const known = new Set(["context", "kind", "yes"]);
  const unknown = [...flags.keys()].find((k) => !known.has(k));
  if (unknown) return { ok: false, error: `unknown option --${unknown}` };
  const context = typeof flags.get("context") === "string" ? (flags.get("context") as string) : undefined;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
      return { ok: true, value: { command: "help" } };
    case "list": {
      const kind = flags.get("kind");
      if (kind !== undefined && !KINDS.includes(kind as MemoryKind)) return { ok: false, error: "--kind must be fact, playbook or history" };
      return { ok: true, value: { command: "list", ...(context ? { context } : {}), ...(kind ? { kind: kind as MemoryKind } : {}) } };
    }
    case "delete":
      return positional.length === 1 && positional[0]
        ? { ok: true, value: { command: "delete", id: positional[0] } }
        : { ok: false, error: "delete needs one memory id (see `list`)" };
    case "wipe":
      return context
        ? { ok: true, value: { command: "wipe", context, yes: flags.get("yes") === true } }
        : { ok: false, error: "wipe needs --context <id>" };
    case "export":
      return { ok: true, value: { command: "export", ...(context ? { context } : {}) } };
    default:
      return { ok: false, error: `unknown command "${command}"` };
  }
};

const day = (d: Date): string => d.toISOString().slice(0, 10);

/** One line per memory: id, context, kind, date, explicit/new markers, text. */
export const formatMemoryList = (memories: readonly Memory[]): string =>
  memories.length === 0
    ? "No memories."
    : memories
        .map((m) =>
          [
            m.id,
            m.contextId,
            m.kind,
            day(m.updatedAt),
            ...(m.origin === "explicit" ? ["explicit"] : []),
            ...(m.seen ? [] : ["new"]),
            ...(m.expiresAt ? [`expires ${day(m.expiresAt)}`] : []),
          ].join("  ") + `\n    ${m.text}`,
        )
        .join("\n");

/** Export as plain JSON, dates as ISO strings. */
export const exportMemories = (memories: readonly Memory[]): string =>
  JSON.stringify(
    memories.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      ...(m.lastUsedAt ? { lastUsedAt: m.lastUsedAt.toISOString() } : {}),
      ...(m.expiresAt ? { expiresAt: m.expiresAt.toISOString() } : {}),
    })),
    null,
    2,
  );
