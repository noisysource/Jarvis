// #166: the house now, read-only, from the domotics bridge's state.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { loadConfig } from "../src/config.js";
import type { DbReader } from "../src/gcloud/firestore.js";
import { houseForBrain, houseSummary } from "../src/house/house.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { nodeOfTool } from "../src/web/brain-lib.js";

const TZ = "Europe/Lisbon";
const NOW = new Date("2026-11-14T18:00:00Z");

/** Shaped like domotics_state/tuya as the database reader returns it (plain JSON, timestamps as ISO). */
const state = (over: Record<string, unknown> = {}) => ({
  updatedAt: "2026-11-14T17:58:00Z",
  devices: [
    { id: "p1", name: "Bomba de calor", category: "znrb", online: true, status: [{ code: "switch", value: true }, { code: "temp_current", value: 52 }] },
    { id: "t1", name: "Sala", category: "wk", online: true, status: [{ code: "temp_current", value: 205 }, { code: "temp_set", value: 210 }, { code: "valve_state", value: "open" }] },
    { id: "t2", name: "Quarto", category: "wk", online: false, status: [] },
  ],
  inverter: { online: true, pvPowerW: 0, consumptionW: 2400, batteryPowerW: -800, soc: 64, gridPowerW: -1550, readAt: 0 },
  automation: {
    enabled: true,
    state: "running",
    doing: "Heating for the warm hours from 19:00: the rooms are 0.5 °C short.",
    plan: "Warm 19:00–23:00 at 21 °C; 18 °C the rest of the day.",
    meanRoom: 20.5,
    roomTarget: 21,
    outdoor: 9.2,
    zones: [],
    reasons: [],
    actions: [],
    evaluatedAt: 0,
  },
  ...over,
});

describe("the house, worded", () => {
  it("the automation's own words, temperatures, the pump, thermostats and energy", () => {
    const text = houseForBrain(state(), NOW, TZ);
    expect(text).toContain("The house as of Sat 17:58:");
    expect(text).toContain("Heating now: Heating for the warm hours from 19:00: the rooms are 0.5 °C short.");
    expect(text).toContain("Today's plan: Warm 19:00–23:00 at 21 °C; 18 °C the rest of the day.");
    expect(text).toContain("Temperatures: rooms 20.5 °C on average, target 21.0 °C, outside 9.2 °C.");
    expect(text).toContain("Heat pump: on.");
    // The pump's temp_current is compressor Hz, never shown as a temperature.
    expect(text).not.toContain("52");
    expect(text).toContain("Thermostats: Sala 20.5 °C (set 21.0 °C), heating; Quarto: offline.");
    expect(text).toContain("Energy: solar 0 W, house using 2.4 kW, battery discharging 800 W at 64%, importing 1.6 kW from the grid.");
    expect(text).toContain("You can't change anything in the house yet.");
    expect(houseSummary(state(), NOW)).toBe("pump on · solar 0 W");
  });

  it("a bridge that stopped reporting is said plainly", () => {
    const old = state({ updatedAt: "2026-11-14T15:00:00Z" });
    expect(houseForBrain(old, NOW, TZ)).toMatch(/^The domotics bridge last reported at Sat 15:00, so this is old/);
    expect(houseSummary(old, NOW)).toBe("bridge not reporting");
    expect(houseForBrain(undefined, NOW, TZ)).toContain("has never reported");
  });

  it("the automation switched off, or the inverter down", () => {
    const text = houseForBrain(state({ automation: { enabled: false, state: "off" }, inverter: { online: false } }), NOW, TZ);
    expect(text).toContain("Heating automation: off.");
    expect(text).toContain("The inverter isn't answering.");
  });
});

describe("asking Jarvis", () => {
  it('"is the heating on?" reads the state document, read-only', async () => {
    expect(groupsByWords("Is the heating on?")).toContain("house");
    expect(groupsByWords("Quanto solar estamos a produzir?")).toContain("house");
    expect(nodeOfTool("house_now")).toBe("house");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "h1", name: "house_now", input: {} }] },
      { ...common, kind: "text", text: "Yes, warming up for 19:00." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const asked: string[] = [];
    const db: DbReader = {
      collections: async () => ok([]),
      query: async () => ok([]),
      get: async (r) => {
        asked.push(`${r.env} ${r.path.join("/")}`);
        return ok({ path: "domotics_state/tuya", fields: state(), updated: "" });
      },
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, house: { db, env: "dev", timeZone: TZ }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Is the heating on?",
      history: [],
      memories: [],
      now: NOW,
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["house_now"]);
    expect(requests[0]?.system).toContain("You can see the house right now, read-only, with house_now");
    expect(asked).toEqual(["dev domotics_state/tuya"]);
    expect(steps[0]).toEqual({ kind: "tool", name: "house_now", args: "dev", by: "model", ok: true, result: "pump on · solar 0 W" });
    expect(JSON.stringify(requests[1]?.messages)).toContain("Heat pump: on.");
  });

  it("a database that can't be read is said plainly", async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [{ ...common, kind: "tool_calls", text: "", calls: [{ id: "h1", name: "house_now", input: {} }] }, { ...common, kind: "text", text: "Can't see it." }];
    let i = 0;
    const llm: LlmCall = async () => ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    const db: DbReader = { collections: async () => ok([]), query: async () => ok([]), get: async () => err({ code: "forbidden", message: "no role" }) };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, house: { db, env: "dev", timeZone: TZ } })({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "heating?", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(steps[0]).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("HOUSE=on needs GCLOUD=on", () => {
    const bad = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", HOUSE: "on" });
    expect(!bad.ok && bad.error).toContain("HOUSE: needs GCLOUD=on");
    const good = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", GCLOUD: "on", HOUSE: "on" });
    expect(good.ok && good.value.house).toEqual({ enabled: true, env: "dev" });
  });
});
