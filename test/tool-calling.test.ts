// Native tool calling for the calendar on Claude (#104): the brain decides
// when to call calendar_read; code checks every call, reads, and reports it.

import { beforeAll, describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer, MAX_TOOL_ROUNDS } from "../src/answer/bare.js";
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
    expect(p).toContain("call the calendar_read tool first, before writing anything");
    expect(p).toContain("Only a calendar_read in this message counts");
    expect(p).not.toContain("the app reads it and gives you the events");
    expect(barePrompt("Alex", { calendar: true })).toContain("the app reads it and gives you the events");
  });

  it("offers the tool, runs the call the brain asks for, and answers from the result", async () => {
    const { llm, requests } = scripted([calls("", read("t1", "2026-11-11", "2026-11-11")), text("You've got the dentist at eleven.")]);
    const google = googleWith(events);
    const { logs, log } = logging();
    const steps: PathStep[] = [];
    const result = await answerer(llm, google.read, log)({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });

    expect(result).toEqual(ok({ kind: "answer", text: "Looking at Wednesday 11 November. You've got the dentist at eleven." }));
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
    expect(content).toContain('Your reply already starts with "Looking at Wednesday 11 November."');
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
    expect(result).toEqual(ok({ kind: "answer", text: "Looking at Friday 13 November. Nothing on Friday." }));
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

  it("streams: the date sentence goes out right after the read, before the answer", async () => {
    const { llm } = scripted([calls("", read("t1", "2026-11-11", "2026-11-11")), text("You've got the dentist at eleven.")], { stream: true });
    const deltas: string[] = [];
    const result = await answerer(llm, googleWith(events).read)({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW, onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Looking at Wednesday 11 November. ", "You've got the dentist at eleven."]);
    expect(result).toEqual(ok({ kind: "answer", text: "Looking at Wednesday 11 November. You've got the dentist at eleven." }));
  });

  it("\"did you check?\" stays in code: answered from what really happened", async () => {
    const { llm, requests } = scripted([text("You have the dentist at eleven.")]);
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
    expect(requests[0]?.tools).toBeUndefined();
    expect(result.ok && result.value.kind === "answer" ? result.value.text : "").toMatch(/^No, I hadn't checked before\. I've checked now/);
  });

  it("without tools (the local brain, or TOOL_CALLING=off), code decides as before", async () => {
    const { llm, requests } = scripted([text("You've got the dentist at eleven.")]);
    const answer = makeBareAnswerer({ llm, calendar: { read: googleWith(events).read, timeZone: TZ, now: () => NOW } });
    await answer({ context: personal, question: "What's on tomorrow?", history: [], memories: [], now: NOW });
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.systemSuffix).toContain("<calendar>");
  });
});
