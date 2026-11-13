// #158: code maps: laying out a study's parts and connections.

import { describe, expect, it } from "vitest";
import { mapViews, type CodeNote } from "../src/code/study.js";
import { connectionsOf, layoutMap, mapTitle, NODE_H, NODE_W } from "../src/web/codemap-lib.js";

type N = Parameters<typeof layoutMap>[0][number];
const node = (id: string, kind: N["kind"]): N => ({ id, label: id.toUpperCase(), kind });

describe("laying out a code map", () => {
  const nodes = [node("web", "app"), node("auth", "module"), node("pay", "module"), node("fn", "service"), node("db", "data"), node("vendus", "external")];
  const edges = [
    { from: "web", to: "auth" },
    { from: "web", to: "pay" },
    { from: "pay", to: "fn", label: "callable" },
    { from: "fn", to: "vendus", label: "invoices" },
    { from: "auth", to: "db" },
    { from: "ghost", to: "db" },
  ];

  it("columns run left to right by kind, with a heading each", () => {
    const l = layoutMap(nodes, edges);
    const x = (id: string) => l.nodes.find((n) => n.id === id)?.x ?? -1;
    expect(x("web")).toBeLessThan(x("auth"));
    expect(x("auth")).toBe(x("pay"));
    expect(x("pay")).toBeLessThan(x("fn"));
    expect(x("fn")).toBeLessThan(x("db"));
    expect(x("db")).toBeLessThan(x("vendus"));
    expect(l.heads.map((h) => h.title)).toEqual(["Apps", "Modules", "Services", "Data", "Outside"]);
    expect(l.width).toBeGreaterThan(5 * NODE_W);
  });

  it("no two parts overlap, and everything fits inside the canvas", () => {
    const l = layoutMap(nodes, edges);
    for (const a of l.nodes) {
      expect(a.x + NODE_W).toBeLessThanOrEqual(l.width);
      expect(a.y + NODE_H).toBeLessThanOrEqual(l.height);
      for (const b of l.nodes) if (a !== b && a.x === b.x) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(NODE_H);
    }
  });

  it("draws a line per connection between known parts, and none for unknown ones", () => {
    const l = layoutMap(nodes, edges);
    expect(l.lines).toHaveLength(5);
    expect(l.lines.every((x) => x.d.startsWith("M "))).toBe(true);
    expect(l.lines.find((x) => x.from === "pay")?.label).toBe("callable");
  });

  it("a long column splits so the map stays on a screen", () => {
    const many = Array.from({ length: 30 }, (_, i) => node(`m${i}`, "module"));
    const l = layoutMap(many, []);
    expect(new Set(l.nodes.map((n) => n.x)).size).toBe(3);
    expect(Math.max(...l.nodes.map((n) => n.y))).toBeLessThan(12 * (NODE_H + 10) + 30);
    expect(l.heads).toHaveLength(1);
  });

  it("parts sit near what they connect to", () => {
    const l = layoutMap(
      [node("a", "app"), node("b", "app"), node("x", "module"), node("y", "module")],
      [
        { from: "a", to: "y" },
        { from: "b", to: "x" },
      ],
    );
    const y = (id: string) => l.nodes.find((n) => n.id === id)?.y ?? -1;
    // a–y and b–x: the pairs end up on the same rows, so the lines don't cross.
    expect(y("a") < y("b")).toBe(y("y") < y("x"));
  });

  it("an empty map has a size and nothing in it", () => {
    expect(layoutMap([], [])).toMatchObject({ nodes: [], lines: [], heads: [] });
  });

  it("a part's connections, both ways", () => {
    expect(connectionsOf("fn", nodes, edges)).toEqual([
      { arrow: "←", label: "PAY", how: "callable" },
      { arrow: "→", label: "VENDUS", how: "invoices" },
    ]);
    expect(mapTitle({ repo: "noisysource/noisysource", folder: "apps/kidclub" })).toBe("noisysource/noisysource · apps/kidclub");
  });
});

describe("what the page gets", () => {
  it("the parts and connections of each note, never the note's text", () => {
    const note: CodeNote = { repo: "a/b", folder: "apps/x", studiedAt: "2026-11-13T09:00:00Z", text: "## Summary\nPrivate details.", map: { nodes: [{ id: "web", label: "Web", kind: "app" }], edges: [] }, partial: false, turns: 3, costUsd: 0 };
    const views = mapViews([note]);
    expect(views).toEqual([{ key: "a/b:apps/x", repo: "a/b", folder: "apps/x", studiedAt: "2026-11-13T09:00:00Z", partial: false, nodes: [{ id: "web", label: "Web", kind: "app" }], edges: [] }]);
    expect(JSON.stringify(views)).not.toContain("Private details");
  });
});
