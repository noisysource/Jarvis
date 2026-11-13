// Code maps (#158): where each part of an app sits on the map, and how the
// lines between them run. Pure: codemap.js draws it.
//
// A map comes from a study (#127): nodes (app, module, service, data,
// external) and edges. They're laid out left to right by kind, so a request
// reads from the app, through its modules, to the services, stores and
// outside APIs it depends on. The order inside a column follows the
// neighbours, to keep lines short.

/** @typedef {"app" | "module" | "service" | "data" | "external"} Kind */
/** @typedef {{ id: string, label: string, kind: Kind, path?: string, about?: string }} MapNode */
/** @typedef {{ from: string, to: string, label?: string }} MapEdge */
/** @typedef {{ key: string, repo: string, folder: string, studiedAt: string, partial: boolean, nodes: MapNode[], edges: MapEdge[] }} CodeMap */

/** Left to right. @type {readonly Kind[]} */
export const KINDS = ["app", "module", "service", "data", "external"];

/** @type {Record<Kind, string>} */
export const KIND_TITLES = { app: "Apps", module: "Modules", service: "Services", data: "Data", external: "Outside" };

export const NODE_W = 158;
export const NODE_H = 34;
const ROW_GAP = 10;
const COL_GAP = 56;
const HEAD = 30;
/** A column taller than this splits in two, so the map stays on a screen. */
const MAX_ROWS = 12;

/**
 * @typedef {MapNode & { x: number, y: number, column: number }} Placed
 * @typedef {{ from: string, to: string, label: string, d: string }} Line
 * @typedef {{ nodes: Placed[], lines: Line[], heads: { title: string, x: number }[], width: number, height: number }} Layout
 */

/**
 * @param {readonly MapNode[]} nodes @param {readonly MapEdge[]} edges
 * @returns {Layout}
 */
export const layoutMap = (nodes, edges) => {
  /** Columns in order: each kind's nodes, split when there are many. @type {MapNode[][]} */
  const columns = [];
  /** @type {{ title: string, column: number }[]} */
  const titles = [];
  for (const kind of KINDS) {
    const of = nodes.filter((n) => n.kind === kind);
    if (of.length === 0) continue;
    const parts = Math.ceil(of.length / MAX_ROWS);
    const size = Math.ceil(of.length / parts);
    titles.push({ title: KIND_TITLES[kind], column: columns.length });
    for (let i = 0; i < parts; i += 1) columns.push(of.slice(i * size, (i + 1) * size));
  }

  /** @type {Map<string, Set<string>>} */
  const next = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    next.get(e.from)?.add(e.to);
    next.get(e.to)?.add(e.from);
  }
  /** Row of each node, updated as columns are ordered. @type {Map<string, number>} */
  const row = new Map();
  columns.forEach((c) => c.forEach((n, i) => row.set(n.id, i)));
  // Two sweeps (left to right, then right to left): each node moves towards the average row of its neighbours.
  const order = (/** @type {MapNode[]} */ column) => {
    const score = (/** @type {MapNode} */ n) => {
      const rows = [...(next.get(n.id) ?? [])].map((id) => row.get(id)).filter((r) => r !== undefined);
      return rows.length === 0 ? (row.get(n.id) ?? 0) : rows.reduce((a, b) => a + b, 0) / rows.length;
    };
    const scored = column.map((n, i) => ({ n, s: score(n), i })).sort((a, b) => a.s - b.s || a.i - b.i);
    scored.forEach(({ n }, i) => {
      column[i] = n;
      row.set(n.id, i);
    });
  };
  for (const c of columns) order(c);
  for (const c of [...columns].reverse()) order(c);

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = HEAD + tallest * (NODE_H + ROW_GAP);
  /** @type {Placed[]} */
  const placed = [];
  columns.forEach((c, ci) => {
    // Shorter columns are centred against the tallest.
    const top = HEAD + ((tallest - c.length) * (NODE_H + ROW_GAP)) / 2;
    c.forEach((n, ri) => placed.push({ ...n, column: ci, x: ci * (NODE_W + COL_GAP), y: Math.round(top + ri * (NODE_H + ROW_GAP)) }));
  });
  const at = new Map(placed.map((p) => [p.id, p]));

  /** @type {Line[]} */
  const lines = [];
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const ay = a.y + NODE_H / 2;
    const by = b.y + NODE_H / 2;
    let d;
    if (a.column === b.column) {
      // Same column: a loop out to the right and back.
      const x = a.x + NODE_W;
      d = `M ${x} ${ay} C ${x + COL_GAP * 0.6} ${ay}, ${x + COL_GAP * 0.6} ${by}, ${x} ${by}`;
    } else {
      const forward = a.column < b.column;
      const x1 = forward ? a.x + NODE_W : a.x;
      const x2 = forward ? b.x : b.x + NODE_W;
      const bend = Math.max(30, Math.abs(x2 - x1) / 2);
      d = `M ${x1} ${ay} C ${x1 + (forward ? bend : -bend)} ${ay}, ${x2 + (forward ? -bend : bend)} ${by}, ${x2} ${by}`;
    }
    lines.push({ from: e.from, to: e.to, label: e.label ?? "", d });
  }

  return {
    nodes: placed,
    lines,
    heads: titles.map((t) => ({ title: t.title, x: t.column * (NODE_W + COL_GAP) })),
    width: Math.max(1, columns.length) * (NODE_W + COL_GAP) - COL_GAP,
    height,
  };
};

/**
 * What a part connects to, for its details: "→ Firebase (Firestore)".
 * @param {string} id @param {readonly MapNode[]} nodes @param {readonly MapEdge[]} edges
 * @returns {{ arrow: "→" | "←", label: string, how: string }[]}
 */
export const connectionsOf = (id, nodes, edges) => {
  const name = new Map(nodes.map((n) => [n.id, n.label]));
  /** @type {{ arrow: "→" | "←", label: string, how: string }[]} */
  const out = [];
  for (const e of edges) {
    if (e.from === id) out.push({ arrow: "→", label: name.get(e.to) ?? e.to, how: e.label ?? "" });
    else if (e.to === id) out.push({ arrow: "←", label: name.get(e.from) ?? e.from, how: e.label ?? "" });
  }
  return out;
};

/** "noisysource/noisysource · apps/kidclub" @param {{ repo: string, folder: string }} m */
export const mapTitle = (m) => `${m.repo}${m.folder ? ` · ${m.folder}` : ""}`;
