// Skills (#116): routines Jarvis follows, drafted from memory or taught in chat.

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer } from "../src/answer/bare.js";
import { handleAsk } from "../src/ask.js";
import { parseContexts } from "../src/contexts.js";
import { runIntrospection } from "../src/introspection.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makeEcMatchers, type EcMatchers } from "../src/memory-rules.js";
import { makeMemoryStoreInMemory } from "../src/memory-store.js";
import { ok, err } from "../src/result.js";
import { makeServer } from "../src/server.js";
import { checkSkill, makeSkillStore, skillsForPrompt, type SkillStore } from "../src/skills.js";
import type { Context, ContextId, Deps, PathStep } from "../src/types.js";
import { confirmsOf } from "../src/web/chat.js";

const TZ = "Europe/Lisbon";
const NOW = new Date("2026-11-11T19:00:00Z");
const DAY = 86_400_000;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: null } };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let contexts: readonly Context[];
let ec: EcMatchers;
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error("contexts.md didn't parse");
  contexts = parsed.value;
  ec = makeEcMatchers(contexts, []);
});

const memoryFile = () => {
  let text: string | undefined;
  let n = 0;
  const store = makeSkillStore({ read: async () => text, write: async (t) => void (text = t), now: () => NOW, newId: () => `5c111${String(++n).padStart(4, "0")}` });
  return { store, file: () => text };
};

const train = { title: "Plan a short trip", when: "When he plans a trip under 500 km", steps: ["Check the calendar for free days", "Suggest a train, not the car", "Propose the event for his OK"] };

describe("the rules for a skill", () => {
  it("needs a title, a when and steps; short; no secrets; no EC", () => {
    expect(checkSkill(train, ec)).toEqual(ok(train));
    expect(checkSkill({ title: "x", when: "y", steps: [] }, ec)).toMatchObject({ ok: false });
    expect(checkSkill({ ...train, steps: Array.from({ length: 13 }, () => "step") }, ec)).toMatchObject({ ok: false });
    expect(checkSkill({ ...train, steps: ["Log in with password hunter2pass"] }, ec)).toMatchObject({ ok: false });
    expect(checkSkill({ ...train, title: "Prepare the UTP standup" }, ec)).toMatchObject({ ok: false, error: expect.stringContaining("Kiro") });
  });
});

describe("the store", () => {
  it("drafts, approves, updates by title, and removes; it's saved to the file", async () => {
    const { store, file } = memoryFile();
    const draft = await store.propose({ ...train, source: "chat" });
    expect(draft.status).toBe("draft");
    expect(skillsForPrompt(await store.list())).toBeUndefined(); // drafts aren't followed
    await store.approve(draft.id);
    const again = await store.propose({ ...train, title: "plan a SHORT trip!", steps: ["Ask where", "Suggest a train"], source: "introspection" });
    expect(again).toMatchObject({ id: draft.id, status: "active", steps: ["Ask where", "Suggest a train"] });
    expect(skillsForPrompt(await store.list())).toContain(`id=${draft.id} · Plan a short trip · when: When he plans a trip under 500 km`);
    expect(JSON.parse(file() ?? "[]")).toHaveLength(1);
    expect(await store.remove(draft.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});

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

const answererWith = (llm: LlmCall, skills: SkillStore) =>
  makeBareAnswerer({ llm, tools: true, memory: { store: makeMemoryStoreInMemory({ now: () => NOW }), contexts, ec, timeZone: TZ }, skills: { store: skills, ec } });

describe("Claude and skills", () => {
  it("the prompt explains skills; approved ones are listed", async () => {
    expect(barePrompt("Alex", { tools: true, memory: true, skills: true })).toContain("call skill_follow and follow its steps");
    const { store } = memoryFile();
    const s = await store.propose({ ...train, source: "chat" });
    await store.approve(s.id);
    const { llm, requests } = scripted([{ ...common, kind: "text", text: "Sure." }]);
    await answererWith(llm, store)({ context: contexts[0] as Context, question: "hi", history: [], memories: [], now: NOW });
    expect(requests[0]?.systemSuffix).toContain("<skills>");
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["skill_follow", "skill_propose"]));
  });

  it("teaching a skill in chat: a draft with an approve card; approving makes it active", async () => {
    const { store } = memoryFile();
    const { llm } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "skill_propose", input: train }] },
      { ...common, kind: "text", text: "I've drafted a skill for short trips; approve it and I'll follow it." },
    ]);
    const deps = { contexts, precheck: (await import("../src/precheck.js")).makePrecheck(contexts), bare: answererWith(llm, store), nativeTools: true, skills: store, log: silent, now: () => NOW } as unknown as Deps;
    const r = await handleAsk(deps, { question: "Make that a skill: how I plan short trips", brain: "claude" });
    const card = r.type === "answer" ? confirmsOf(r.path ?? []) : [];
    expect(card).toEqual([{ id: "5c1110001", label: "Plan a short trip: 3 steps, when When he plans a trip under 500 km", kind: "skill" }]);
    expect((await store.get("5c1110001"))?.status).toBe("draft");
    const app = makeServer(deps);
    const decide = (body: unknown) => app.request("/skills/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await decide({ id: "5c1110001", decision: "approve" })).json()).toMatchObject({ ok: true, text: "Approved: I'll follow “Plan a short trip” from now on." });
    expect((await store.get("5c1110001"))?.status).toBe("active");
    expect((await app.request("/skills")).headers.get("cache-control")).toBe("no-store");
    expect((await decide({ id: "nope", decision: "approve" })).status).toBe(400);
    expect((await app.request("/skills/decide", { method: "POST", body: "id=1" })).status).toBe(415);
  });

  it("following an approved skill: its steps go to Claude and the path shows ✨", async () => {
    const { store } = memoryFile();
    const s = await store.propose({ ...train, source: "chat" });
    const { llm, requests } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "skill_follow", input: { id: s.id } }] },
      { ...common, kind: "text", text: "x" },
    ]);
    const steps: PathStep[] = [];
    await answererWith(llm, store)({ context: contexts[0] as Context, question: "Plan a trip to Porto", history: [], memories: [], now: NOW, onStep: (x) => steps.push(x) });
    expect(steps).toEqual([{ kind: "skill", name: "skill_follow", args: "", by: "model", ok: false, error: "not an approved skill" }]); // still a draft
    await store.approve(s.id);
    const second = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "skill_follow", input: { id: s.id } }] },
      { ...common, kind: "text", text: "x" },
    ]);
    const steps2: PathStep[] = [];
    await answererWith(second.llm, store)({ context: contexts[0] as Context, question: "Plan a trip to Porto", history: [], memories: [], now: NOW, onStep: (x) => steps2.push(x) });
    expect(steps2).toEqual([{ kind: "skill", name: "Plan a short trip", args: "", by: "model", ok: true, result: "followed" }]);
    const last = second.requests[1]?.messages.at(-1);
    expect(last && "toolResults" in last ? last.toolResults[0]?.content : "").toContain("2. Suggest a train, not the car");
    expect(requests).toHaveLength(2);
  });
});

describe("introspection drafts skills", () => {
  it("puts them in the store as drafts, checked by the rules", async () => {
    const memories = makeMemoryStoreInMemory({ now: () => NOW });
    await memories.add({ contextId: "personal" as unknown as ContextId, kind: "fact", text: "Took the train to Porto", origin: "auto", source: "bare", expiresAt: new Date(NOW.getTime() + 5 * DAY) });
    const { store } = memoryFile();
    const llm: LlmCall = async () =>
      ok({ ...common, kind: "json", value: { decisions: [], skills: [train, { ...train, title: "UTP weekly report" }], tools: [] } });
    await runIntrospection({ store: memories, llm, contexts, ec, timeZone: TZ, now: () => NOW, skills: store });
    const skills = await store.list();
    expect(skills.map((s) => [s.title, s.status, s.source])).toEqual([["Plan a short trip", "draft", "introspection"]]);
  });
});
