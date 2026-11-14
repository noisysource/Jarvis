import { describe, expect, it } from "vitest";
import { EMPTY, NODES, offeredNodes, applyReach, applyStep, isReaching, lineGeometry, mesh, nodeOfTool, nodePosition, reachOfStep, settle, stateOfPath } from "../src/web/brain-lib.js";

type Step = Parameters<typeof applyStep>[1];
const tool = (name: string, ok = true, extra: Record<string, unknown> = {}): Step => ({ kind: "tool", name, args: "", by: "model", ok, ...extra }) as Step;

describe("brain view: which node a step reaches (#131)", () => {
  it("maps tools to their node, and nothing for unknown names", () => {
    expect(nodeOfTool("calendar_read")).toBe("calendar");
    expect(nodeOfTool("calendar_create")).toBe("calendar");
    expect(nodeOfTool("gmail_draft")).toBe("gmail");
    expect(nodeOfTool("memory_recall")).toBe("memory");
    expect(nodeOfTool("skill_follow")).toBe("skills");
    expect(nodeOfTool("github_read")).toBe("github");
    expect(nodeOfTool("code_ask")).toBe("code");
    expect(nodeOfTool("rm_rf")).toBeUndefined();
  });

  it("reads a step's outcome: used, waiting for an OK, failed, or a Kiro handoff", () => {
    expect(reachOfStep(tool("calendar_read"))).toEqual({ node: "calendar", reach: "used" });
    expect(reachOfStep(tool("gmail_draft", true, { confirm: { id: "x", label: "Draft", kind: "email" } }))).toEqual({ node: "gmail", reach: "waiting" });
    expect(reachOfStep(tool("calendar_read", false, { error: "refused" }))).toEqual({ node: "calendar", reach: "failed" });
    expect(reachOfStep({ kind: "skill", name: "Plan a short trip", args: "", by: "model", ok: true } as Step)).toEqual({ node: "skills", reach: "used" });
    expect(reachOfStep({ kind: "precheck", result: "handoff" } as Step)).toEqual({ node: "kiro", reach: "handoff" });
    expect(reachOfStep({ kind: "precheck", result: "none" } as Step)).toBeUndefined();
    expect(reachOfStep({ kind: "brain", brain: "claude" } as Step)).toBeUndefined();
  });
});

describe("brain view: one answer's state (#131)", () => {
  it("reaching while a tool runs, then its outcome", () => {
    let s = applyReach(EMPTY, "gmail_search");
    expect(s).toEqual({ gmail: "reaching" });
    expect(isReaching(s)).toBe(true);
    s = applyStep(s, tool("gmail_search"));
    expect(s).toEqual({ gmail: "used" });
    expect(isReaching(s)).toBe(false);
  });

  it("a node waiting for an OK keeps saying so after a later plain use", () => {
    let s = applyStep(EMPTY, tool("gmail_draft", true, { confirm: { id: "x", label: "Draft" } }));
    s = applyStep(applyReach(s, "gmail_search"), tool("gmail_search"));
    expect(s.gmail).toBe("waiting");
  });

  it("a retry that works shows as used; a new reach is drawn while it runs", () => {
    let s = applyStep(EMPTY, tool("calendar_read", false));
    expect(s.calendar).toBe("failed");
    s = applyReach(s, "calendar_read");
    expect(s.calendar).toBe("reaching");
    expect(applyStep(s, tool("calendar_read")).calendar).toBe("used");
  });

  it("from the final path; anything left reaching becomes failed", () => {
    expect(stateOfPath([{ kind: "precheck", result: "none" } as Step, tool("memory_recall"), tool("calendar_read")])).toEqual({ memory: "used", calendar: "used" });
    expect(settle({ code: "reaching", memory: "used" })).toEqual({ code: "failed", memory: "used" });
  });

  it("ignores tools it can't place", () => {
    expect(applyReach(EMPTY, "web_fetch")).toBe(EMPTY);
    expect(applyStep(EMPTY, tool("web_fetch"))).toBe(EMPTY);
  });
});

describe("brain view: geometry (#131)", () => {
  it("places the nodes evenly around the centre, Profile at the top", () => {
    expect(NODES).toHaveLength(11);
    expect(nodePosition(-90)).toEqual({ left: 50, top: expect.closeTo(14.167, 2) });
    expect(nodePosition(0)).toEqual({ left: expect.closeTo(85.833, 2), top: 50 });
  });

  it("a failed line stops short of its node", () => {
    const used = lineGeometry(0, "used");
    const failed = lineGeometry(0, "failed");
    expect(failed.length).toBeLessThan(used.length);
    expect(failed.end.left).toBeLessThan(used.end.left);
    expect(used.left).toBeCloseTo(63.667, 2);
  });

  it("the mesh is the same on every load", () => {
    expect(mesh()).toEqual(mesh());
    expect(mesh().dots).toHaveLength(22);
  });
});

describe("brain view: what it was offered (#141)", () => {
  it("maps offered tools to nodes; Profile and Kiro always count", () => {
    expect([...offeredNodes(["calendar_read", "gmail_search", "gmail_read"])].sort()).toEqual(["calendar", "gmail", "kiro", "profile"]);
    expect([...offeredNodes([])].sort()).toEqual(["kiro", "profile"]);
  });
});
