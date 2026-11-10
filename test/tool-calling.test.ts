// Native tool calling for the calendar on Claude (#104): the brain decides
// when to call calendar_read; code checks every call, reads, and reports it.

import { beforeAll, describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer, MAX_TOOL_ROUNDS, toolsSoFar } from "../src/answer/bare.js";
import { calendarIntent } from "../src/calendar/intent.js";
import { parseAskRequest } from "../src/request.js";
import { appendTurn, toolsRan } from "../src/web/chat.js";
import { makeGoogleCalendarReader } from "../src/calendar/google.js";
import { CALENDAR_READ_TOOL, EC_EVENT, isEcEvent, type GoogleEvent } from "../src/calendar/read.js";
import { parseContexts } from "../src/contexts.js";
import { streamedFrom } from "../src/llm/stream.js";
import type { LlmCall, LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep, Precheck } from "../src/types.js";
import { readFile } from "node:fs/promises";

const TZ = "Europe/Lisbon";
// Tuesday 10 November 2026, 17:20 in Lisbon.
const NOW = new Date("2026-11-10T17:20:00Z");
const personal = { id: "personal", name: "Personal" } as unknown as Context;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "opaque" } };

const text = (t: string): LlmResponse => ({ ...common, kind: "text", text: t });
const calls = (t: string, ...c: LlmToolCall[]): LlmResponse => ({ ...common, kind: "tool_calls", text: t, calls: c });
const read = (id: string, from: string, to: string): LlmToolCall => ({ id, name: "calendar_read", input: { from, to } });

/** A brain that answers from a script, one response per call, and records each request. */
const scripted = (responses: readonly LlmResponse[], options: { stream?: boolean } = {}) => {
  const requests: LlmRequest[] = [];
  let i = 0;
  const next = (r: LlmRequest): LlmResponse => {
    requests.push(r);
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!response) throw new Error("no scripted response");
    return response;
  };
  const call = async (r: LlmRequest) => ok(next(r));
  const llm: LlmCall = options.stream
    ? Object.assign(call, {
        stream: (r: LlmRequest) => {
          const response = next(r);
          const chunks = response.kind === "json" || response.text === "" ? [] : [response.text];
          return streamedFrom(chunks, ok(response));
        },
      })
    : call;
  return { llm, requests };
};

let precheck: (text: string) => Precheck;
beforeAll(async () => {
  const contexts = parseContexts(await readFile("contexts.md", "utf8"));
  if (!contexts.ok) throw new Error("contexts.md didn't parse");
  precheck = makePrecheck(contexts.value);
});

const googleWith = (items: GoogleEvent[]) => {
  const urls: string[] = [];
  const reader = makeGoogleCalendarReader({
    accessToken: async () => ok("tok"),
    timeZone: TZ,
    isEc: (e) => isEcEvent(e, precheck),
    fetch: (async (u: string | URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { read: reader, urls };
};

const events: GoogleEvent[] = [
  { summary: "UTP standup", start: { dateTime: "2026-11-11T09:00:00Z" }, end: { dateTime: "2026-11-11T09:30:00Z" } },
  { summary: "Dentist", start: { dateTime: "2026-11-11T11:00:00Z" }, end: { dateTime: "2026-11-11T12:00:00Z" } },
];

const logging = () => {
  const logs: { m: string; f?: unknown }[] = [];
  const log = { info: (m: string, f?: unknown) => void logs.push({ m, f }), warn: (m: string, f?: unknown) => void logs.push({ m, f }), error: () => undefined };
  return { logs, log };
};

const answerer = (llm: LlmCall, read: ReturnType<typeof googleWith>["read"], log?: ReturnType<typeof logging>["log"]) =>
  makeBareAnswerer({ llm, userName: "Alex", tools: true, calendar: { read, timeZone: TZ, now: () => NOW }, ...(log ? { log } : {}) });

describe("native tool calling (#104)", () => {
  it("the prompt tells the brain to call calendar_read itself", () => {
    const p = barePrompt("Alex", { calendar: true, tools: true });
    expect(p).toContain("call the calendar_read tool, without announcing it first");
    expect(p).toContain("What you really did for earlier answers is listed at the end of this prompt; trust that list.");
    expect(p).not.toContain("the app reads it and gives you the events");
    expect(barePrompt("Alex", { calendar: true })).toContain("the app reads it and gives you the events");
  });

  it("offers the tool, runs the call the brain asks for, and answers from the result", async () => {
    const { llm, requests } = scripted([calls("", read("t1", "2026-11-11", "2026-11-11")), text("You've got the dentist at eleven.")]);
    const google = googleWith(events);
    const { logs, log } = logging();
    const steps: PathStep[] = [];
    const result = await answerer(llm, google.read, log)({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });

    // No code-written sentences: the brain answers in its own words (#104).
    expect(result).toEqual(ok({ kind: "answer", text: "You've got the dentist at eleven." }));
    // No structured request and no code detection: the brain got the tool.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.outputSchema).toBeUndefined();
    expect(requests[0]?.tools).toEqual([CALENDAR_READ_TOOL]);
    expect(requests[0]?.systemSuffix).not.toContain("<calendar>");
    // The second round carries the call and its result, with the provider payload passed back.
    const second = requests[1]?.messages ?? [];
    expect(second.at(-2)).toEqual({ role: "assistant", text: "", toolCalls: [read("t1", "2026-11-11", "2026-11-11")], payload: common.payload });
    const results = second.at(-1);
    expect(results && "toolResults" in results ? results.toolResults[0]?.callId : undefined).toBe("t1");
    const content = results && "toolResults" in results ? (results.toolResults[0]?.content ?? "") : "";
    expect(content).toContain("Dentist");
    expect(content).toContain(EC_EVENT);
    expect(content).not.toContain("UTP standup"); // EC titles never reach the brain
    expect(new URL(google.urls[0] ?? "").searchParams.get("timeMin")).toBe("2026-11-11T00:00:00+00:00");
    expect(steps).toEqual([{ kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "model", ok: true, result: "2 events" }]);
    expect(logs).toContainEqual({ m: "calendar read", f: expect.objectContaining({ days: 1, events: 2, ec: 1, by: "model" }) });
    expect(JSON.stringify(logs)).not.toMatch(/Dentist|UTP/);
  });

  it("a follow-up with no calendar words still reads, because the brain decides", async () => {
    const { llm } = scripted([calls("", read("t1", "2026-11-13", "2026-11-13")), text("Nothing on Friday.")]);
    const google = googleWith([]);
    const result = await answerer(llm, google.read)({
      context: personal,
      question: "And Friday?",
      history: [
        { role: "user", text: "What's on tomorrow?" },
        { role: "assistant", text: "Looking at Wednesday 11 November. The dentist at eleven." },
      ],
      memories: [],
      now: NOW,
    });
    expect(result).toEqual(ok({ kind: "answer", text: "Nothing on Friday." }));
    expect(google.urls).toHaveLength(1);
  });

  it("a question that doesn't need the calendar is answered with no read", async () => {
    const { llm, requests } = scripted([text("A region where gravity wins.")]);
    const google = googleWith(events);
    const steps: PathStep[] = [];
    const result = await answerer(llm, google.read)({ context: personal, question: "What's a black hole?", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(result).toEqual(ok({ kind: "answer", text: "A region where gravity wins." }));
    expect(requests).toHaveLength(1);
    expect(google.urls).toHaveLength(0);
    expect(steps).toEqual([]);
  });

  it("code refuses a bad call and tells the brain, which can then say so", async () => {
    const { llm, requests } = scripted([calls("", read("t1", "2026-11-01", "2026-12-31")), text("That's too long a stretch. Which week?")]);
    const google = googleWith(events);
    const steps: PathStep[] = [];
    const result = await answerer(llm, google.read)({ context: personal, question: "Anything this month or next?", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(result).toEqual(ok({ kind: "answer", text: "That's too long a stretch. Which week?" }));
    expect(google.urls).toHaveLength(0);
    const last = requests[1]?.messages.at(-1);
    expect(last && "toolResults" in last ? last.toolResults[0] : undefined).toMatchObject({ callId: "t1", isError: true, content: expect.stringContaining("Refused: too many days") });
    expect(steps).toEqual([{ kind: "tool", name: "calendar_read", args: "", by: "model", ok: false, error: "refused: too many days" }]);
  });

  it("an unknown tool is refused", async () => {
    const { llm, requests } = scripted([calls("", { id: "t1", name: "calendar_write", input: {} }), text("I can't add events yet.")]);
    const steps: PathStep[] = [];
    await answerer(llm, googleWith([]).read)({ context: personal, question: "Add lunch tomorrow", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    const last = requests[1]?.messages.at(-1);
    expect(last && "toolResults" in last ? last.toolResults[0]?.isError : undefined).toBe(true);
    expect(steps).toEqual([{ kind: "tool", name: "calendar_write", args: "", by: "model", ok: false, error: "not an allowed tool" }]);
  });

  it("a failed read goes back as an error, and the path shows it", async () => {
    const { llm, requests } = scripted([calls("", read("t1", "2026-11-11", "2026-11-11")), text("I couldn't reach your calendar just now.")]);
    const steps: PathStep[] = [];
    const notConnected = async () => err({ code: "not_connected" as const, message: "x" });
    const result = await answerer(llm, notConnected)({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(result).toEqual(ok({ kind: "answer", text: "I couldn't reach your calendar just now." }));
    const last = requests[1]?.messages.at(-1);
    expect(last && "toolResults" in last ? last.toolResults[0] : undefined).toMatchObject({ isError: true, content: expect.stringContaining("isn't connected") });
    expect(steps).toEqual([{ kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "model", ok: false, error: "not_connected" }]);
  });

  it(`stops offering tools after ${MAX_TOOL_ROUNDS} rounds`, async () => {
    const { llm, requests } = scripted([
      calls("", read("a", "2026-11-11", "2026-11-11")),
      calls("", read("b", "2026-11-12", "2026-11-12")),
      calls("", read("c", "2026-11-13", "2026-11-13")),
      text("Here's your week so far."),
    ]);
    await answerer(llm, googleWith([]).read)({ context: personal, question: "This week?", history: [], memories: [], now: NOW });
    expect(requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(requests[MAX_TOOL_ROUNDS]?.tools).toBeUndefined();
  });

  it("streams the brain's answer as it comes, with nothing added by code", async () => {
    const { llm } = scripted([calls("", read("t1", "2026-11-11", "2026-11-11")), text("You've got the dentist at eleven.")], { stream: true });
    const deltas: string[] = [];
    const result = await answerer(llm, googleWith(events).read)({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW, onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(["You've got the dentist at eleven."]);
    expect(result).toEqual(ok({ kind: "answer", text: "You've got the dentist at eleven." }));
  });

  it("\"did you check?\" goes to the brain, with the record of what really ran", async () => {
    const { llm, requests } = scripted([text("No, I hadn't. Shall I check tomorrow now?")]);
    const result = await answerer(llm, googleWith(events).read)({
      context: personal,
      question: "Did you actually check my calendar?",
      history: [
        { role: "user", text: "What's on tomorrow?" },
        { role: "assistant", text: "Your calendar is clear." },
      ],
      memories: [],
      now: NOW,
    });
    // No keyword-triggered code path: the brain gets the tool and answers itself.
    expect(requests[0]?.tools).toEqual([CALENDAR_READ_TOOL]);
    expect(requests[0]?.systemSuffix ?? "").not.toContain("Tools the app really ran"); // nothing ran before
    expect(result).toEqual(ok({ kind: "answer", text: "No, I hadn't. Shall I check tomorrow now?" }));
  });

  it("without tools (the local brain, or TOOL_CALLING=off), code decides as before", async () => {
    const { llm, requests } = scripted([text("You've got the dentist at eleven.")]);
    const answer = makeBareAnswerer({ llm, calendar: { read: googleWith(events).read, timeZone: TZ, now: () => NOW } });
    await answer({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW });
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.systemSuffix).toContain("<calendar>");
  });

  describe("the brain knows what it really did earlier", () => {
    const history = [
      { role: "user" as const, text: "What's on tomorrow?" },
      { role: "assistant" as const, text: "One meeting, 08:00 to 09:00.", tools: ["calendar_read Wed 11 Nov → 1 event"] },
      { role: "user" as const, text: "What's a black hole?" },
      { role: "assistant" as const, text: "A region where gravity wins." },
      { role: "user" as const, text: "And Friday?" },
      { role: "assistant" as const, text: "Friday is clear.", tools: ["calendar_read Fri 13 Nov → 0 events"] },
    ];

    it("the page keeps each answer's real tool calls, from its path: dates and counts only", () => {
      const tools = toolsRan([
        { kind: "precheck", result: "none" },
        { kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "model", ok: true, result: "1 event" },
        { kind: "tool", name: "calendar_read", args: "", by: "model", ok: false, error: "refused: too many days" },
      ]);
      expect(tools).toEqual(["calendar_read Wed 11 Nov → 1 event"]);
      expect(appendTurn([], "assistant", "One meeting.", tools)).toEqual([{ role: "assistant", text: "One meeting.", tools }]);
      expect(appendTurn([], "assistant", "Hi.", [])).toEqual([{ role: "assistant", text: "Hi." }]);
    });

    it("the server accepts them, within limits", () => {
      expect(parseAskRequest({ question: "Why?", history }).ok).toBe(true);
      expect(parseAskRequest({ question: "Why?", history: [{ role: "assistant", text: "x", tools: ["y".repeat(81)] }] }).ok).toBe(false);
      expect(parseAskRequest({ question: "Why?", history: [{ role: "assistant", text: "x", tools: ["a", "b", "c", "d", "e", "f"] }] }).ok).toBe(false);
    });

    it("lists them at the end of the prompt, numbered by answer", () => {
      expect(toolsSoFar(history)).toBe(
        [
          "Tools the app really ran for your earlier answers in this conversation (counting your answers from the first):",
          "- Your answer 1: calendar_read Wed 11 Nov → 1 event",
          "- Your answer 3: calendar_read Fri 13 Nov → 0 events",
          "Those answers came from real reads. Never say you didn't check for them. Answers not listed used no tool.",
        ].join("\n"),
      );
      expect(toolsSoFar([{ role: "assistant", text: "Hi." }])).toBeUndefined();
    });

    it("the brain gets that list with the next question", async () => {
      const { llm, requests } = scripted([text("Next week is clear.")]);
      await answerer(llm, googleWith([]).read)({ context: personal, question: "Thanks", history, memories: [], now: NOW });
      expect(requests[0]?.systemSuffix).toContain("- Your answer 1: calendar_read Wed 11 Nov → 1 event");
      expect(requests[0]?.systemSuffix).toContain("Never say you didn't check for them.");
    });

    it("\"did you check?\" says yes when the page recorded a read, even without code's date sentence", () => {
      expect(calendarIntent("Did you actually check my calendar?", history.slice(0, 2))?.didCheck).toEqual({ before: true });
      expect(calendarIntent("Did you actually check my calendar?", [{ role: "user", text: "What's on tomorrow?" }, { role: "assistant", text: "One meeting." }])?.didCheck).toEqual({ before: false });
    });

    it("the prompt says to call the tool without announcing it", () => {
      expect(barePrompt("Alex", { calendar: true, tools: true })).toContain("without announcing it");
    });
  });
});
