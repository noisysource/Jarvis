// Human-like memory, part 1 (#107): Claude remembers and recalls with tools;
// code enforces every memory rule.

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer } from "../src/answer/bare.js";
import { handleAsk } from "../src/ask.js";
import { loadConfig } from "../src/config.js";
import { parseContexts } from "../src/contexts.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makeEcMatchers } from "../src/memory-rules.js";
import { makeMemoryStoreInMemory, type MemoryStore } from "../src/memory-store.js";
import { makeMemoryTurn, MEMORY_TOOLS, SHORT_TERM_DAYS, type MemoryToolDeps } from "../src/memory-tools.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import type { Context, ContextId, Deps, PathStep } from "../src/types.js";

const TZ = "Europe/Lisbon";
// Wednesday 11 November 2026, 17:00 in Lisbon.
const NOW = new Date("2026-11-11T17:00:00Z");
const DAY = 86_400_000;

let contexts: readonly Context[];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error("contexts.md didn't parse");
  contexts = parsed.value;
});
const ctx = (id: string) => id as unknown as ContextId;

const setup = (store: MemoryStore = makeMemoryStoreInMemory({ now: () => NOW })) => {
  const deps: MemoryToolDeps = { store, contexts, ec: makeEcMatchers(contexts, ["Jane Example"]), timeZone: TZ };
  const steps: PathStep[] = [];
  const turn = (question: string, remember = true) => makeMemoryTurn(deps, { question, remember, now: NOW, onStep: (s) => steps.push(s) });
  return { store, deps, steps, turn };
};

describe("remembering", () => {
  it("short-term fades in two weeks; long-term doesn't; both show on the path", async () => {
    const { store, steps, turn } = setup();
    const t = turn("We're thinking of a weekend in Porto, and I always want answers in English");
    expect(await t.remember({ text: "Thinking of a weekend in Porto", term: "short", kind: "fact", context: "personal", sensitive: "none" })).toMatchObject({ saved: true });
    expect(await t.remember({ text: "Wants answers in English", term: "long", kind: "routine", context: "personal", sensitive: "none" })).toMatchObject({ saved: true });
    const all = await store.list();
    const short = all.find((m) => m.text.includes("Porto"));
    const long = all.find((m) => m.text.includes("English"));
    expect(short?.expiresAt?.getTime()).toBe(NOW.getTime() + SHORT_TERM_DAYS * DAY);
    expect(long?.expiresAt).toBeUndefined();
    expect(long?.kind).toBe("playbook");
    expect(steps).toEqual([
      { kind: "tool", by: "model", name: "memory_remember", args: "personal · short-term", ok: true, result: "saved" },
      { kind: "tool", by: "model", name: "memory_remember", args: "personal · long-term", ok: true, result: "saved" },
    ]);
  });

  it("a dated event is kept short-term until the day after, even without \"remember\"", async () => {
    const { store, turn } = setup();
    await turn("Diniz has a football match on Saturday 14 November").remember({ text: "Diniz has a football match on Saturday 14 November", term: "short", kind: "fact", context: "personal", sensitive: "none" });
    const [m] = await store.list();
    expect(m?.expiresAt?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
  });

  it("the rules hold whatever the brain asks", async () => {
    const { store, steps, turn } = setup();
    const t = turn("my wifi password is hunter2pass and I have a dentist appointment for my back pain");
    expect(await t.remember({ text: "Wifi password is hunter2pass", term: "long", kind: "fact", context: "personal", sensitive: "none" })).toMatchObject({ isError: true, content: expect.stringContaining("never kept") });
    expect(await t.remember({ text: "Has back pain", term: "short", kind: "fact", context: "personal", sensitive: "health" })).toMatchObject({ isError: true, content: expect.stringContaining("only kept when they ask") });
    expect(await turn("Summarise the UTP standup").remember({ text: "UTP standup moved to 10", term: "short", kind: "fact", context: "personal", sensitive: "none" })).toMatchObject({ isError: true, content: expect.stringContaining("Kiro") });
    expect(await turn("x").remember({ text: "Cloudflare invoice FT 2026/123 is €11.17", term: "short", kind: "fact", context: "noisysource", sensitive: "none" })).toMatchObject({ isError: true });
    expect(await turn("x").remember({ text: "Note", term: "short", kind: "fact", context: "ec-hrt", sensitive: "none" })).toMatchObject({ isError: true });
    expect(await store.list()).toEqual([]);
    expect(steps.every((s) => s.kind === "tool" && !s.ok)).toBe(true);
  });

  it("health is kept when he asks to remember it", async () => {
    const { store, turn } = setup();
    expect(await turn("Remember that I'm allergic to penicillin").remember({ text: "Allergic to penicillin", term: "long", kind: "fact", context: "personal", sensitive: "health" })).toMatchObject({ saved: true });
    expect((await store.list())[0]?.origin).toBe("explicit");
  });

  it("\"off the record\" and the Remembering toggle stop saving", async () => {
    const { store, turn } = setup();
    expect(await turn("Off the record, I'm thinking of quitting").remember({ text: "Thinking of quitting", term: "short", kind: "fact", context: "personal", sensitive: "none" })).toMatchObject({ isError: true });
    expect(await turn("I like tea", false).remember({ text: "Likes tea", term: "long", kind: "fact", context: "personal", sensitive: "none" })).toMatchObject({ isError: true });
    expect(await store.list()).toEqual([]);
  });

  it("updating: a changed memory replaces the one recalled, and can become long-term", async () => {
    const { store, turn } = setup();
    const old = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Diniz has swimming on Tuesdays", origin: "auto", source: "bare", expiresAt: new Date(NOW.getTime() + 3 * DAY) });
    const t = turn("Diniz swims on Thursdays now");
    await t.recall({ query: "Diniz swimming" });
    expect(await t.remember({ text: "Diniz has swimming on Thursdays", term: "long", kind: "fact", context: "personal", sensitive: "none", replaces: old.id })).toMatchObject({ saved: true });
    const [m] = await store.list();
    expect(m).toMatchObject({ id: old.id, text: "Diniz has swimming on Thursdays" });
    expect(m?.expiresAt).toBeUndefined();
    // An id it wasn't shown can't be touched.
    expect(await turn("x").remember({ text: "y", term: "long", kind: "fact", context: "personal", sensitive: "none", replaces: "made-up" })).toMatchObject({ isError: true });
  });
});

describe("recalling and forgetting", () => {
  it("recall searches every context he works in, strengthens what it finds, and never reaches EC", async () => {
    const { store, steps, turn } = setup();
    const a = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Marisa prefers Italian food", origin: "auto", source: "bare" });
    await store.add({ contextId: ctx("kidclub"), kind: "playbook", text: "Food orders for KidClub go to the usual supplier", origin: "auto", source: "bare" });
    const r = await turn("what food does Marisa like?").recall({ query: "Marisa food" });
    expect(r.content).toContain(`id=${a.id} [personal · long-term · fact`);
    expect(r.content).toContain("[kidclub · long-term · routine");
    expect((await store.get(a.id))?.lastUsedAt).toEqual(NOW);
    expect(steps).toEqual([{ kind: "tool", by: "model", name: "memory_recall", args: "", ok: true, result: "2 memories" }]);
  });

  it("the prompt carries recent short-term memories; expired ones are gone", async () => {
    const { store, turn } = setup();
    await store.add({ contextId: ctx("personal"), kind: "fact", text: "Weekend in Porto being planned", origin: "auto", source: "bare", expiresAt: new Date(NOW.getTime() + 5 * DAY) });
    await store.add({ contextId: ctx("personal"), kind: "fact", text: "Old plan", origin: "auto", source: "bare", expiresAt: new Date(NOW.getTime() - DAY) });
    await store.add({ contextId: ctx("personal"), kind: "fact", text: "Long-term fact", origin: "auto", source: "bare" });
    const core = (await turn("hi").core()) ?? "";
    expect(core).toContain("Weekend in Porto being planned");
    expect(core).not.toContain("Old plan");
    expect(core).not.toContain("Long-term fact"); // recalled on demand
  });

  it("forgets only when asked, and only what it was shown", async () => {
    const { store, turn } = setup();
    const m = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Likes espresso", origin: "auto", source: "bare" });
    const notAsked = turn("I switched to tea");
    await notAsked.recall({ query: "espresso" });
    expect(await notAsked.forget({ id: m.id })).toMatchObject({ isError: true });
    const asked = turn("Forget that I like espresso");
    expect(await asked.forget({ id: m.id })).toMatchObject({ isError: true }); // not shown yet
    await asked.recall({ query: "espresso" });
    expect(await asked.forget({ id: m.id })).toMatchObject({ saved: true });
    expect(await store.list()).toEqual([]);
  });
});

describe("Claude with memory", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: null } };
  const scripted = (responses: readonly LlmResponse[]) => {
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return next ? ok(next) : err({ kind: "unknown", message: "no script", retryable: false });
    };
    return { llm, requests };
  };

  it("the prompt explains the memory; without it, it says nothing is kept", () => {
    const p = barePrompt("Alex", { tools: true, memory: true });
    expect(p).toContain("You have a memory that lasts beyond this conversation");
    expect(p).toContain("Only say you remember, or have noted, what memory_remember actually saved.");
    expect(p).not.toContain("You won't remember anything after this conversation.");
    expect(barePrompt("Alex", {})).toContain("You won't remember anything after this conversation.");
  });

  it("notices something worth keeping, saves it, and \"noted\" gets through the honesty guard", async () => {
    const { deps, store } = setup();
    const { llm, requests } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "memory_remember", input: { text: "Prefers trains over planes for trips under 500 km", term: "long", kind: "routine", context: "personal", sensitive: "none" } }] },
      { ...common, kind: "text", text: "Noted. Trains it is for short trips." },
    ]);
    const bare = makeBareAnswerer({ llm, tools: true, memory: deps });
    const d = { contexts, precheck: makePrecheck(contexts), bare, nativeTools: true, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, now: () => NOW } as unknown as Deps;
    const r = await handleAsk(d, { question: "For trips under 500 km I always prefer the train", brain: "claude" });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(MEMORY_TOOLS.map((t) => t.name));
    expect(r).toMatchObject({ type: "answer", answer: "Noted. Trains it is for short trips." });
    expect(r.type === "answer" ? r.path?.find((s) => s.kind === "tool") : undefined).toMatchObject({ name: "memory_remember", ok: true, result: "saved" });
    expect((await store.list())[0]?.text).toBe("Prefers trains over planes for trips under 500 km");
  });

  it("a claim to have noted something that wasn't saved is still dropped", async () => {
    const { deps } = setup();
    const { llm } = scripted([{ ...common, kind: "text", text: "Done, I've saved that. Anything else?" }]);
    const bare = makeBareAnswerer({ llm, tools: true, memory: deps });
    const d = { contexts, precheck: makePrecheck(contexts), bare, nativeTools: true, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, now: () => NOW } as unknown as Deps;
    const r = await handleAsk(d, { question: "Remember I like tea", brain: "claude" });
    expect(r.type === "answer" ? r.answer : "").not.toContain("I've saved that");
  });

  it("config: MEMORY=on needs bare mode", () => {
    expect(loadConfig({ MEMORY: "on", BARE_MODE: "on" })).toMatchObject({ ok: true, value: { bareMemory: true } });
    const bad = loadConfig({ MEMORY: "on" });
    expect(!bad.ok && bad.error).toContain("MEMORY: needs BARE_MODE=on");
  });
});
