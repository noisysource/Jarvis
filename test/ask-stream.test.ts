// POST /ask with Accept: text/event-stream (#72), end to end through the server.
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import { makeTurnRegistry } from "../src/turns.js";
import type { AnswerInput, Context, ContextId, Deps, MemoryHooks } from "../src/types.js";

let contexts: readonly Context[] = [];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

type Event = { event: string; data: unknown };
const parseSse = (text: string): Event[] =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });

const CHUNKS = ["Hello! ", "Dr. Silva is your ", "doctor. She works ", "on Mondays."];

const setup = (options: { classifyAs?: string; answer?: (input: AnswerInput) => ReturnType<Deps["answer"]> } = {}) => {
  const lines: string[] = [];
  const wrapUps: { answer: string }[] = [];
  const log = makeJsonLogger({ write: (l) => lines.push(l) });
  const memory: MemoryHooks = {
    loadMemories: async () => [],
    wrapUp: async (input) => {
      wrapUps.push({ answer: input.answer });
    },
  };
  const deps: Deps = {
    contexts,
    precheck: makePrecheck(contexts),
    classify: async () => ({ kind: "context", contextId: (options.classifyAs ?? "personal") as ContextId }),
    answer:
      options.answer ??
      (async (input) => {
        for (const c of CHUNKS) input.onText?.(c);
        return ok({ kind: "answer", text: CHUNKS.join("") });
      }),
    memory,
    isAnswered: (id) => id === "personal",
    afterReply: (_name, task) => void task(),
    now: () => new Date("2026-11-08T10:00:00Z"),
    log,
  };
  let n = 0;
  const turns = makeTurnRegistry({ log, holdMs: 60_000 });
  const app = makeServer(deps, { newTurnId: () => `turn-000${(n += 1)}`, turns });
  const ask = (body: unknown, init: RequestInit = {}) =>
    app.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      ...init,
    });
  const spoken = (body: unknown) =>
    app.request("/ask/spoken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, ask, spoken, wrapUps, lines, turns };
};

describe("POST /ask, streamed", () => {
  it("sends start, each sentence as it completes, then done", async () => {
    const { ask } = setup();
    const res = await ask({ question: "Who's my doctor?" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(parseSse(await res.text())).toEqual([
      { event: "start", data: { turnId: "turn-0001" } },
      { event: "sentence", data: { index: 0, text: "Hello!" } },
      { event: "sentence", data: { index: 1, text: "Dr. Silva is your doctor." } },
      { event: "sentence", data: { index: 2, text: "She works on Mondays." } },
      { event: "done", data: { type: "answer", context: "personal", answer: "Hello! Dr. Silva is your doctor. She works on Mondays." } },
    ]);
  });

  it.each([
    ["an EC/HRT handoff (the precheck, before any model)", "Summarise the UTP standup", "personal", "handoff"],
    ["a context that isn't connected", "Which invoices are unpaid?", "kidclub", "unavailable"],
    ["a clarify", "Did it get paid?", "unclear", "clarify"],
  ])("sends %s as one reply event, with no sentences", async (_label, question, classifyAs, type) => {
    let answered = false;
    const { ask } = setup({
      classifyAs,
      answer: async (input) => {
        answered = input.context.id === "personal";
        return ok({ kind: "unavailable", message: `${input.context.name} isn't connected yet, so I can't answer that one.` });
      },
    });
    const events = parseSse(await (await ask({ question })).text());
    expect(events.map((e) => e.event)).toEqual(["start", "reply"]);
    expect(events[1]?.data).toMatchObject({ type });
    expect(answered).toBe(false);
  });

  it("keeps the plain JSON /ask when the page doesn't ask for a stream", async () => {
    const { app, wrapUps } = setup();
    const res = await app.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Who's my doctor?" }),
    });
    expect(await res.json()).toEqual({ type: "answer", context: "personal", answer: CHUNKS.join("") });
    expect(wrapUps).toEqual([{ answer: CHUNKS.join("") }]); // wrapped up straight away, as before
  });

  it("holds the wrap-up until the page reports playback: played to the end → the full answer", async () => {
    const { ask, spoken, wrapUps, turns } = setup();
    await (await ask({ question: "Who's my doctor?" })).text();
    expect(wrapUps).toEqual([]);
    expect(turns.pending()).toBe(1);
    const res = await spoken({ turnId: "turn-0001", interrupted: false, spoken: CHUNKS.join("") });
    expect(res.status).toBe(200);
    expect(wrapUps).toEqual([{ answer: CHUNKS.join("") }]);
    expect((await spoken({ turnId: "turn-0001", interrupted: false, spoken: "" })).status).toBe(404); // already settled
  });

  it("skips the wrap-up for an interrupted answer…", async () => {
    const { ask, spoken, wrapUps } = setup();
    await (await ask({ question: "Who's my doctor?" })).text();
    await spoken({ turnId: "turn-0001", interrupted: true, spoken: "Hello! Dr. Silva—" });
    expect(wrapUps).toEqual([]);
  });

  it("…but an explicit remember wraps up on what was actually spoken", async () => {
    const { ask, spoken, wrapUps } = setup();
    await (await ask({ question: "Remember that Diniz has football tomorrow" })).text();
    await spoken({ turnId: "turn-0001", interrupted: true, spoken: "Noted: Diniz has football—" });
    expect(wrapUps).toEqual([{ answer: "Noted: Diniz has football—" }]);
  });

  it("cancels the answer when the client goes away mid-stream", async () => {
    let sawAbort = false;
    const controller = new AbortController();
    const { ask, spoken, wrapUps, lines } = setup({
      answer: async (input) => {
        input.onText?.("Noted: Diniz ");
        await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve()));
        sawAbort = true;
        return err({ code: "cancelled", message: "Cancelled." });
      },
    });
    const res = await ask({ question: "Remember that Diniz has football tomorrow" }, { signal: controller.signal });
    const reader = res.body?.getReader();
    await reader?.read(); // the start event
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(sawAbort).toBe(true);
    // The question explicitly asked to remember, so the page's report of what was spoken is wrapped up.
    expect((await spoken({ turnId: "turn-0001", interrupted: true, spoken: "" })).status).toBe(200);
    expect(wrapUps).toEqual([{ answer: "" }]);
    expect(lines.some((l) => l.includes('"message":"ask stream"') && l.includes('"outcome":"cancelled"'))).toBe(true);
  });

  it("validates /ask/spoken and keeps it JSON-only", async () => {
    const { app, spoken } = setup();
    expect((await spoken({ turnId: "x", interrupted: true, spoken: "" })).status).toBe(400);
    expect((await spoken({ turnId: "turn-0009", interrupted: "yes", spoken: "" })).status).toBe(400);
    expect((await spoken({ turnId: "turn-0009", interrupted: true, spoken: "" })).status).toBe(404);
    const form = await app.request("/ask/spoken", { method: "POST", headers: { "content-type": "text/plain" }, body: "turnId=x" });
    expect(form.status).toBe(415);
  });

  it("logs why playback stopped, as numbers and fixed words, never what was said (#89)", async () => {
    const { ask, spoken, lines } = setup();
    await (await ask({ question: "Who's my doctor?" })).text();
    const report = {
      turnId: "turn-0001",
      interrupted: true,
      spoken: "Hello!—",
      reason: "barge-in",
      played: 1,
      total: 3,
      voiceErrors: 0,
      streamComplete: true,
      bargeProb: 74,
      msAfterFirstAudio: 420,
    };
    expect((await spoken(report)).status).toBe(200);
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "playback");
    expect(line).toMatchObject({ interrupted: true, reason: "barge-in", played: 1, total: 3, bargeProb: 74, msAfterFirstAudio: 420, streamComplete: true });
    expect(JSON.stringify(line)).not.toContain("Hello");
    // Only known reasons, only numbers.
    expect((await spoken({ ...report, reason: "the user said something rude" })).status).toBe(400);
    expect((await spoken({ ...report, bargeProb: 0.74 })).status).toBe(400);
  });

  it("logs counts and timings, never the answer", async () => {
    const { ask, lines } = setup();
    await (await ask({ question: "Who's my doctor?" })).text();
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "ask stream");
    expect(line).toMatchObject({ outcome: "answer", sentences: 3 });
    expect(typeof line?.firstSentenceMs).toBe("number");
    expect(lines.join("\n")).not.toContain("Silva");
    expect(lines.join("\n")).not.toContain("doctor");
  });
});
