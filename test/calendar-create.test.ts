// Reach 2: creating calendar events, only after Renato's explicit OK.

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { buildDeps } from "../src/app.js";
import { handleAsk } from "../src/ask.js";
import {
  addedSentence,
  CALENDAR_CREATE_TOOL,
  checkCreateRequest,
  googleEventBody,
  makeGoogleEventCreator,
  makePendingProposals,
  proposalLabel,
  proposalPathLabel,
  type CreatedEvent,
  type Proposal,
} from "../src/calendar/create.js";
import { loadConfig } from "../src/config.js";
import { parseContexts } from "../src/contexts.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import type { Context, Deps, Logger, PathStep } from "../src/types.js";
import { confirmsOf } from "../src/web/chat.js";

const TZ = "Europe/Lisbon";
const TODAY = "2026-11-10";
const NOW = new Date("2026-11-10T17:20:00Z");
const personal = { id: "personal", name: "Personal" } as unknown as Context;
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let isEc: (text: string) => boolean;
let contexts: readonly Context[];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error("contexts.md didn't parse");
  contexts = parsed.value;
  const precheck = makePrecheck(parsed.value);
  isEc = (t) => precheck(t).kind === "handoff";
});

describe("checking a proposed event", () => {
  const check = (v: unknown) => checkCreateRequest(v, TODAY, isEc);

  it("accepts a timed event, and an all-day one; a missing end is an hour after the start", () => {
    expect(check({ title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" })).toEqual(ok({ title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" }));
    expect(check({ title: "Dentist", date: "2026-11-12", start: "10:30" })).toEqual(ok({ title: "Dentist", date: "2026-11-12", start: "10:30", end: "11:30" }));
    expect(check({ title: "Holiday", date: "2026-12-24", all_day: true })).toEqual(ok({ title: "Holiday", date: "2026-12-24" }));
  });

  it("refuses what doesn't make sense", () => {
    expect(check({ title: "", date: "2026-11-11", start: "10:00" })).toEqual(err("no title"));
    expect(check({ title: "x".repeat(121), date: "2026-11-11", start: "10:00" })).toEqual(err("title too long"));
    expect(check({ title: "Work", date: "2026-11-31", start: "10:00" })).toEqual(err("date isn't a real YYYY-MM-DD"));
    expect(check({ title: "Work", date: "2026-11-09", start: "10:00" })).toEqual(err("date is in the past"));
    expect(check({ title: "Work", date: "2028-01-01", start: "10:00" })).toEqual(err("date is too far ahead"));
    expect(check({ title: "Work", date: "2026-11-11" })).toEqual(err("give a start time, or all_day"));
    expect(check({ title: "Work", date: "2026-11-11", start: "25:00" })).toEqual(err("start isn't HH:MM"));
    expect(check({ title: "Work", date: "2026-11-11", start: "10:00", end: "09:00" })).toEqual(err("end isn't after start"));
  });

  it("never puts EC work on the calendar: that's Kiro's", () => {
    expect(check({ title: "UTP standup", date: "2026-11-11", start: "09:00" })).toEqual(err("EC work is for Kiro"));
  });

  it("labels it for the card (with the title) and for the path line (without)", () => {
    const p: Proposal = { title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" };
    expect(proposalLabel(p, TODAY)).toBe("“Work”, Wednesday 11 November, 21:00–22:00");
    expect(proposalPathLabel(p)).toBe("Wed 11 Nov 21:00–22:00");
    expect(proposalPathLabel({ title: "Holiday", date: "2026-12-24" })).toBe("Thu 24 Dec all day");
  });
});

describe("Google", () => {
  it("sends local times with the time zone, so Google works out summer and winter", () => {
    expect(googleEventBody({ title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" }, TZ)).toEqual({
      summary: "Work",
      start: { dateTime: "2026-11-11T21:00:00", timeZone: TZ },
      end: { dateTime: "2026-11-11T22:00:00", timeZone: TZ },
    });
    expect(googleEventBody({ title: "Holiday", date: "2026-12-24" }, TZ)).toEqual({ summary: "Holiday", start: { date: "2026-12-24" }, end: { date: "2026-12-25" } });
  });

  it("creates with one POST and reports what Google says it created", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const create = makeGoogleEventCreator({
      accessToken: async () => ok("tok"),
      timeZone: TZ,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ summary: "Work", start: { dateTime: "2026-11-11T21:00:00Z" }, end: { dateTime: "2026-11-11T22:00:00Z" } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const created = await create({ title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" });
    expect(created).toEqual(ok({ title: "Work", start: "2026-11-11T21:00:00Z", end: "2026-11-11T22:00:00Z", allDay: false }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toContain("/calendars/primary/events");
  });

  it("a read-only connection says how to fix it", async () => {
    const create = makeGoogleEventCreator({ accessToken: async () => ok("tok"), timeZone: TZ, fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch });
    const created = await create({ title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" });
    expect(!created.ok && created.error).toMatchObject({ code: "auth", message: expect.stringContaining("CALENDAR_WRITE=on npm run calendar:connect") });
  });

  it("the confirmation is worded from Google's answer", () => {
    const e: CreatedEvent = { title: "Work", start: "2026-11-11T21:00:00Z", end: "2026-11-11T22:00:00Z", allDay: false };
    expect(addedSentence(e, TZ, TODAY)).toBe("Added “Work” on Wednesday 11 November, 21:00–22:00.");
    expect(addedSentence({ title: "Holiday", start: "2026-12-24", end: "2026-12-25", allDay: true }, TZ, TODAY)).toBe("Added “Holiday” on Thursday 24 December, all day.");
  });
});

describe("pending proposals", () => {
  it("are single use and expire", () => {
    let t = 0;
    let n = 0;
    const pending = makePendingProposals({ now: () => t, ttlMs: 1000, newId: () => `id${++n}` });
    const p: Proposal = { title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" };
    const a = pending.add(p);
    expect(pending.take(a)).toEqual(p);
    expect(pending.take(a)).toBeUndefined(); // used
    const b = pending.add(p);
    t = 1000;
    expect(pending.take(b)).toBeUndefined(); // expired
  });
});

describe("the brain proposes, it never adds", () => {
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
  const answerer = (llm: LlmCall, pending = makePendingProposals({ newId: () => "abc12345" })) =>
    makeBareAnswerer({ llm, tools: true, calendar: { read: async () => ok([]), timeZone: TZ, now: () => NOW, create: { pending, isEc } } });

  it("offers calendar_create, keeps the checked event for the OK, and tells the brain it isn't added", async () => {
    const pending = makePendingProposals({ newId: () => "abc12345" });
    const { llm, requests } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "calendar_create", input: { title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" } }] },
      { ...common, kind: "text", text: "I'd add “Work” tomorrow from nine to ten at night; just confirm." },
    ]);
    const steps: PathStep[] = [];
    const result = await answerer(llm, pending)({ context: personal, question: "Create a meeting tomorrow 9pm called work", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["calendar_read", CALENDAR_CREATE_TOOL.name]);
    expect(requests[0]?.system).toContain("only their yes adds it");
    expect(steps).toEqual([
      {
        kind: "tool",
        name: "calendar_create",
        args: "Wed 11 Nov 21:00–22:00",
        by: "model",
        ok: true,
        result: "waiting for your OK",
        confirm: { id: "abc12345", label: "“Work”, Wednesday 11 November, 21:00–22:00" },
      },
    ]);
    const last = requests[1]?.messages.at(-1);
    expect(last && "toolResults" in last ? last.toolResults[0]?.content : "").toContain("Not added yet.");
    expect(result.ok && result.value.kind === "answer" ? result.value.text : "").toContain("just confirm");
    expect(pending.take("abc12345")).toEqual({ title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" });
  });

  it("an EC event is refused, and the brain is told it's Kiro's", async () => {
    const { llm, requests } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "calendar_create", input: { title: "UTP standup", date: "2026-11-11", start: "09:00" } }] },
      { ...common, kind: "text", text: "That's EC work, so it's for Kiro." },
    ]);
    const steps: PathStep[] = [];
    await answerer(llm)({ context: personal, question: "Add the UTP standup tomorrow at 9", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(steps).toEqual([{ kind: "tool", name: "calendar_create", args: "", by: "model", ok: false, error: "refused: EC work is for Kiro" }]);
    const last = requests[1]?.messages.at(-1);
    expect(last && "toolResults" in last ? last.toolResults[0] : undefined).toMatchObject({ isError: true, content: expect.stringContaining("Kiro") });
  });

  it("without CALENDAR_WRITE, the tool isn't offered", async () => {
    const { llm, requests } = scripted([{ ...common, kind: "text", text: "I can't add events yet." }]);
    await makeBareAnswerer({ llm, tools: true, calendar: { read: async () => ok([]), timeZone: TZ, now: () => NOW } })({ context: personal, question: "Add lunch", history: [], memories: [], now: NOW });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["calendar_read"]);
    expect(requests[0]?.system).toContain("You can't add, move or delete events yet.");
  });

  it("\"I've added it\" is still dropped by the honesty guard: a proposal isn't an action", async () => {
    const deps = {
      contexts,
      precheck: makePrecheck(contexts),
      calendarEnabled: true,
      bare: async (input: Parameters<NonNullable<Deps["bare"]>>[0]) => {
        input.onStep?.({ kind: "tool", name: "calendar_create", args: "Wed 11 Nov 21:00–22:00", by: "model", ok: true, result: "waiting for your OK", confirm: { id: "abc12345", label: "x" } });
        return ok({ kind: "answer" as const, text: "I've added it to your calendar." });
      },
      log: silent,
      now: () => NOW,
    } as unknown as Deps;
    const response = await handleAsk(deps, { question: "Create a meeting tomorrow 9pm called work" });
    expect(response).toMatchObject({ type: "answer" });
    expect(response.type === "answer" ? response.answer : "").not.toContain("I've added it");
  });
});

describe("Renato's answer", () => {
  const configWith = (env: Record<string, string>) => {
    const c = loadConfig(env);
    if (!c.ok) throw new Error(c.error);
    return c.value;
  };
  const build = async (creator: Parameters<typeof buildDeps>[0]["eventCreator"]) => {
    const made = await buildDeps({
      config: configWith({ BARE_MODE: "on", CALENDAR: "on", CALENDAR_WRITE: "on" }),
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      log: silent,
      profileFs: { readFile: async () => "Name: Alex", stat: async () => ({ mtimeMs: 1 }) } as never,
      makeLlm: () => ok((async () => err({ kind: "unknown", message: "unused", retryable: false })) as LlmCall),
      calendarReader: async () => ok([]),
      ...(creator ? { eventCreator: creator } : {}),
      now: () => NOW,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  it("is only offered with CALENDAR_WRITE=on", async () => {
    const made = await buildDeps({
      config: configWith({ BARE_MODE: "on", CALENDAR: "on" }),
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      log: silent,
      profileFs: { readFile: async () => "Name: Alex", stat: async () => ({ mtimeMs: 1 }) } as never,
      makeLlm: () => ok((async () => err({ kind: "unknown", message: "unused", retryable: false })) as LlmCall),
      now: () => NOW,
    });
    if (!made.ok) throw new Error(made.error);
    expect(made.value.calendarConfirm).toBeUndefined();
  });

  it("yes creates it once; no and unknown ids create nothing", async () => {
    const created: Proposal[] = [];
    const deps = await build(async (p) => {
      created.push(p);
      return ok({ title: p.title, start: "2026-11-11T21:00:00Z", end: "2026-11-11T22:00:00Z", allDay: false });
    });
    expect(await deps.calendarConfirm?.("deadbeef", "yes")).toMatchObject({ ok: false });
    expect(created).toEqual([]);
    // A proposal made the way the brain's tool call makes it is used by the confirm route; here, through the server.
    const app = makeServer(deps);
    const confirm = (body: unknown) => app.request("/calendar/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await confirm({ id: "nope" })).status).toBe(400);
    expect((await app.request("/calendar/confirm", { method: "POST", body: "id=1" })).status).toBe(415);
    expect(await (await confirm({ id: "deadbeef", decision: "no" })).json()).toMatchObject({ ok: false });
    expect(created).toEqual([]);
  });

  it("end to end: Claude proposes, nothing is written, then \"yes\" adds it once, worded from Google's answer", async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: null } };
    let round = 0;
    const claude: LlmCall = async () => {
      round += 1;
      return ok(
        round === 1
          ? { ...common, kind: "tool_calls" as const, text: "", calls: [{ id: "t1", name: "calendar_create", input: { title: "Work", date: "2026-11-11", start: "21:00", end: "22:00" } }] }
          : { ...common, kind: "text" as const, text: "I'd add “Work” tomorrow, nine to ten at night. Confirm and it's in." },
      );
    };
    const created: Proposal[] = [];
    const made = await buildDeps({
      config: configWith({ BARE_MODE: "on", CALENDAR: "on", CALENDAR_WRITE: "on", TOOL_ROUTER: "rules" }),
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      log: silent,
      profileFs: { readFile: async () => "Name: Alex", stat: async () => ({ mtimeMs: 1 }) } as never,
      makeLlm: () => ok(claude),
      calendarReader: async () => ok([]),
      eventCreator: async (p) => {
        created.push(p);
        return ok({ title: p.title, start: "2026-11-11T21:00:00Z", end: "2026-11-11T22:00:00Z", allDay: false });
      },
      now: () => NOW,
    });
    if (!made.ok) throw new Error(made.error);
    const response = await handleAsk(made.value, { question: "Create a meeting tomorrow at 9pm called work", brain: "claude" });
    const step = response.type === "answer" ? response.path?.find((s) => s.kind === "tool" && s.name === "calendar_create") : undefined;
    const id = step && step.kind === "tool" ? step.confirm?.id : undefined;
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    expect(created).toEqual([]); // nothing written before the OK
    const app = makeServer(made.value);
    const confirm = async (decision: "yes" | "no") =>
      (await app.request("/calendar/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) })).json();
    expect(await confirm("yes")).toEqual({ ok: true, text: "Added “Work” on Wednesday 11 November, 21:00–22:00.", tool: "calendar_create Wed 11 Nov 21:00–22:00 → added" });
    expect(created).toHaveLength(1);
    expect(await confirm("yes")).toMatchObject({ ok: false }); // single use
    expect(created).toHaveLength(1);
  });
});

describe("the page", () => {
  it("shows a card only for proposals waiting for an OK", () => {
    expect(
      confirmsOf([
        { kind: "tool", name: "calendar_read", args: "Wed 11 Nov", by: "model", ok: true, result: "1 event" },
        { kind: "tool", name: "calendar_create", args: "Wed 11 Nov 21:00–22:00", by: "model", ok: true, result: "waiting for your OK", confirm: { id: "abc12345", label: "“Work”, Wednesday 11 November, 21:00–22:00" } },
        { kind: "tool", name: "calendar_create", args: "", by: "model", ok: false, error: "refused: no title" },
      ]),
    ).toEqual([{ id: "abc12345", label: "“Work”, Wednesday 11 November, 21:00–22:00" }]);
  });
});
