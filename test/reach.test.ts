// #133: what each brain-view node can do, for its panel. Names and counts only.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { reachView } from "../src/reach.js";
import { connectCommand, restOf } from "../src/web/brain-lib.js";

const configWith = (env: Record<string, string>) => {
  const c = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", ...env });
  if (!c.ok) throw new Error(c.error);
  return c.value;
};

describe("GET /reach content (#133)", () => {
  it("lists each node's tools and which accounts are connected", async () => {
    const config = configWith({ CALENDAR: "on", CALENDAR_WRITE: "on", GMAIL: "on", MEMORY: "on", PROFILE: "on" });
    const files = new Set(["data/google-tokens.json", "data/google-gmail-personal.json"]);
    const nodes = await reachView({ config, exists: async (p) => files.has(p), draftSkills: async () => 2 });
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(nodes.map((n) => n.id)).toEqual(["profile", "memory", "skills", "calendar", "gmail", "github", "cloud", "code", "kiro"]);
    expect(byId.calendar?.status).toBe("on");
    expect(byId.calendar?.tools.map((t) => t.name)).toEqual(["calendar_read", "calendar_create"]);
    expect(byId.calendar?.accounts).toEqual([
      { name: "personal", connected: true },
      { name: "noisysource", connected: false },
    ]);
    expect(byId.gmail?.accounts).toEqual([
      { name: "personal", connected: true },
      { name: "noisysource", connected: false },
    ]);
    expect(byId.gmail?.tools.map((t) => t.name)).toEqual(["gmail_search", "gmail_read"]);
    expect(byId.skills?.waiting).toBe(2);
    expect(byId.github?.status).toBe("off");
    expect(byId.kiro?.status).toBe("on");
  });

  it("says what's switched off and how to turn it on", async () => {
    const nodes = await reachView({ config: configWith({}), exists: async () => false });
    const calendar = nodes.find((n) => n.id === "calendar");
    expect(calendar?.status).toBe("off");
    expect(calendar?.hint).toBe("CALENDAR=on in .env");
    expect(calendar?.tools.map((t) => t.name)).toEqual(["calendar_read"]);
    expect(nodes.find((n) => n.id === "memory")?.status).toBe("off");
  });

  it("carries no secrets or content: only names, on/off and counts", async () => {
    const config = configWith({ CALENDAR: "on", GMAIL: "on", MEMORY: "on" });
    const json = JSON.stringify(await reachView({ config, exists: async () => true, draftSkills: async () => 1 }));
    expect(json).not.toMatch(/sk-test|token"|@|refresh/i);
  });
});

describe("brain view: panels (#133)", () => {
  it("a node's resting look", () => {
    expect(restOf("calendar", "on")).toBe("idle");
    expect(restOf("calendar", "off")).toBe("off");
    expect(restOf("github", "soon")).toBe("soon");
    expect(restOf("kiro", "on")).toBe("kiro");
  });

  it("how to connect an account", () => {
    expect(connectCommand("calendar", "personal")).toBe("npm run calendar:connect");
    expect(connectCommand("calendar", "noisysource")).toBe("npm run calendar:connect -- noisysource");
    expect(connectCommand("gmail", "personal")).toBe("npm run gmail:connect -- personal");
  });
});
