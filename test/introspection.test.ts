// Introspection (#108): the nightly review of short-term memory.

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { introspectionInput, msUntil, reportMarkdown, runIntrospection, INTROSPECTION_SCHEMA } from "../src/introspection.js";
import { loadConfig } from "../src/config.js";
import { parseContexts } from "../src/contexts.js";
import type { LlmCall, LlmRequest } from "../src/llm/types.js";
import { makeEcMatchers } from "../src/memory-rules.js";
import { makeMemoryStoreInMemory, type MemoryStore } from "../src/memory-store.js";
import { ok } from "../src/result.js";
import type { Context, ContextId } from "../src/types.js";

const TZ = "Europe/Lisbon";
const NOW = new Date("2026-11-12T03:30:00Z");
const DAY = 86_400_000;
const ctx = (id: string) => id as unknown as ContextId;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

let contexts: readonly Context[];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error("contexts.md didn't parse");
  contexts = parsed.value;
});

const brain = (value: unknown) => {
  const requests: LlmRequest[] = [];
  const llm: LlmCall = async (r) => {
    requests.push(r);
    return ok({ kind: "json", value, servedBy: "claude-test", usage, payload: { provider: "anthropic", data: null } });
  };
  return { llm, requests };
};

const seed = async (store: MemoryStore) => {
  const soon = new Date(NOW.getTime() + 5 * DAY);
  const play = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Duarte's school play is on Friday 20 November", origin: "auto", source: "bare", expiresAt: soon });
  const trains = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Took the train to Porto again, prefers it to driving", origin: "auto", source: "bare", expiresAt: soon });
  const chat = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Was tired on Tuesday", origin: "auto", source: "bare", expiresAt: soon });
  const swim = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Diniz now swims on Thursdays", origin: "auto", source: "bare", expiresAt: soon });
  const swimLong = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Diniz swims on Tuesdays", origin: "auto", source: "bare" });
  const faded = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Old plan", origin: "auto", source: "bare", expiresAt: new Date(NOW.getTime() - DAY) });
  return { play, trains, chat, swim, swimLong, faded };
};

describe("introspection", () => {
  it("drops, promotes, merges and keeps; faded memories are gone; the report has skill and tool drafts", async () => {
    const store = makeMemoryStoreInMemory({ now: () => NOW });
    const m = await seed(store);
    const { llm, requests } = brain({
      decisions: [
        { id: m.play.id, action: "keep", text: "", kind: "fact", into: "" },
        { id: m.trains.id, action: "promote", text: "Prefers the train to driving for trips like Coimbra to Porto", kind: "routine", into: "" },
        { id: m.chat.id, action: "drop", text: "", kind: "fact", into: "" },
        { id: m.swim.id, action: "merge", text: "Diniz swims on Thursdays", kind: "fact", into: m.swimLong.id },
      ],
      skills: [{ title: "Plan a train trip", when: "When he plans a trip under 500 km", steps: ["Check the calendar for free days", "Suggest trains"], from: [m.trains.id] }],
      tools: [{ title: "Train timetables", why: "He keeps asking for CP times" }],
    });
    let saved = "";
    const report = await runIntrospection({ store, llm, contexts, ec: makeEcMatchers(contexts, []), timeZone: TZ, now: () => NOW, writeReport: async (_d, md) => void (saved = md) });

    expect(requests[0]?.outputSchema).toBe(INTROSPECTION_SCHEMA);
    const first = requests[0]?.messages[0];
    expect(first && "text" in first ? first.text : "").not.toContain("Old plan"); // faded first
    const left = await store.list();
    expect(left.map((x) => x.text).sort()).toEqual(["Diniz swims on Thursdays", "Duarte's school play is on Friday 20 November", "Prefers the train to driving for trips like Coimbra to Porto"]);
    const promoted = left.find((x) => x.text.startsWith("Prefers the train"));
    expect(promoted).toMatchObject({ kind: "playbook", source: "introspection" });
    expect(promoted?.expiresAt).toBeUndefined();
    expect(left.find((x) => x.id === m.swimLong.id)?.text).toBe("Diniz swims on Thursdays");
    expect(report).toMatchObject({ date: "2026-11-12", kept: 1, refused: 0 });
    expect(saved).toContain("## Proposed skills (drafts: approve them in the ✨ Skills panel)");
    expect(saved).toContain("1. Check the calendar for free days");
    expect(saved).toContain("**Train timetables**");
  });

  it("the rules still hold: no secrets or EC promoted, no sensitive details unless asked, unknown ids refused", async () => {
    const store = makeMemoryStoreInMemory({ now: () => NOW });
    const soon = new Date(NOW.getTime() + 5 * DAY);
    const a = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Mentioned a back pain", origin: "auto", source: "bare", expiresAt: soon });
    const b = await store.add({ contextId: ctx("personal"), kind: "fact", text: "Allergic to penicillin", origin: "explicit", source: "bare", expiresAt: soon });
    const { llm } = brain({
      decisions: [
        { id: a.id, action: "promote", text: "Has chronic back pain", kind: "fact", into: "", sensitive: "health" },
        { id: b.id, action: "promote", text: "Allergic to penicillin", kind: "fact", into: "", sensitive: "health" },
        { id: a.id, action: "promote", text: "The UTP standup is at 10", kind: "fact", into: "" },
        { id: "made-up", action: "drop", text: "", kind: "fact", into: "" },
      ],
      skills: [],
      tools: [],
    });
    const report = await runIntrospection({ store, llm, contexts, ec: makeEcMatchers(contexts, []), timeZone: TZ, now: () => NOW });
    const left = await store.list();
    expect(left.find((x) => x.text === "Mentioned a back pain")?.expiresAt).toBeDefined(); // health without asking: stays short-term
    expect(left.find((x) => x.text === "Allergic to penicillin")?.expiresAt).toBeUndefined(); // he asked: promoted
    expect(report.refused).toBe(3);
  });

  it("nothing to review: no model call", async () => {
    const { llm, requests } = brain({ decisions: [], skills: [], tools: [] });
    const report = await runIntrospection({ store: makeMemoryStoreInMemory({ now: () => NOW }), llm, contexts, ec: makeEcMatchers(contexts, []), timeZone: TZ, now: () => NOW });
    expect(requests).toHaveLength(0);
    expect(report.kept).toBe(0);
  });

  it("the input shows when each memory fades and whether it was recalled", async () => {
    const store = makeMemoryStoreInMemory({ now: () => NOW });
    const m = await seed(store);
    await store.touch([m.trains.id]);
    const all = await store.list();
    const text = introspectionInput(all.filter((x) => x.expiresAt && x.expiresAt > NOW), all.filter((x) => !x.expiresAt), NOW, TZ);
    expect(text).toMatch(/^Today is Thursday,? 12 November 2026\./);
    expect(text).toContain("fades 17 Nov 2026 · recalled 12 Nov 2026] Took the train");
    expect(text).toContain("never recalled] Was tired");
  });

  it("runs at 03:30 Lisbon time, winter and summer", () => {
    expect(msUntil(new Date("2026-11-12T02:30:00Z"), TZ, 3, 30)).toBe(3600_000);
    expect(msUntil(new Date("2026-07-01T01:30:00Z"), TZ, 3, 30)).toBe(3600_000); // 02:30 WEST
    expect(msUntil(new Date("2026-11-12T03:30:00Z"), TZ, 3, 30)).toBe(86_400_000);
  });

  it("report: says nothing is switched on", () => {
    const md = reportMarkdown({ date: "2026-11-12", kept: 2, promoted: [], merged: [], dropped: ["x"], refused: 0, skills: [], tools: [] });
    expect(md).toContain("# Jarvis introspection, 2026-11-12");
    expect(md).toContain("2 kept (they fade on their own), 0 made long-term, 0 merged, 1 dropped.");
  });

  it("config: INTROSPECTION=on needs MEMORY=on", () => {
    expect(loadConfig({ BARE_MODE: "on", MEMORY: "on", INTROSPECTION: "on" })).toMatchObject({ ok: true, value: { introspection: true } });
    const bad = loadConfig({ BARE_MODE: "on", INTROSPECTION: "on" });
    expect(!bad.ok && bad.error).toContain("INTROSPECTION: needs MEMORY=on");
  });
});
