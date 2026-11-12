// The brain view (#131): which node each path step reaches, and the state of
// each node for one answer. Pure: brain.js draws it.
//
// Every line comes from a real step (the live reach/step events, or the
// answer's path): nothing is drawn for show.

/** @typedef {import("./chat.js").PathStep} PathStep */
/** @typedef {"profile" | "memory" | "skills" | "calendar" | "gmail" | "github" | "code" | "kiro"} NodeId */
/** @typedef {"reaching" | "used" | "waiting" | "failed" | "handoff"} Reach */
/** @typedef {"idle" | "off" | "soon" | "kiro"} Rest */

/** Around the core, clockwise from the top. `soon`: not connected yet. */
export const NODES = /** @type {const} */ ([
  { id: "profile", label: "Profile", angle: -90, rest: "idle" },
  { id: "memory", label: "Memory", angle: -45, rest: "idle" },
  { id: "skills", label: "Skills", angle: 0, rest: "idle" },
  { id: "calendar", label: "Calendar", angle: 45, rest: "idle" },
  { id: "gmail", label: "Gmail", angle: 90, rest: "idle" },
  { id: "github", label: "GitHub", angle: 135, rest: "soon" },
  { id: "code", label: "Code agent", angle: 180, rest: "soon" },
  { id: "kiro", label: "Kiro", angle: 225, rest: "kiro" },
]);

/**
 * The node a tool belongs to, by its name. Unknown names reach nothing.
 * @param {string} tool
 * @returns {NodeId | undefined}
 */
export const nodeOfTool = (tool) => {
  if (tool.startsWith("calendar_")) return "calendar";
  if (tool.startsWith("gmail_")) return "gmail";
  if (tool.startsWith("memory_")) return "memory";
  if (tool.startsWith("skill_")) return "skills";
  if (tool.startsWith("github_")) return "github";
  if (tool === "code_ask") return "code";
  return undefined;
};

/**
 * The node a finished step reached, and how. A skill step names the skill
 * (not the tool), so its kind decides.
 * @param {PathStep} step
 * @returns {{ node: NodeId, reach: Reach } | undefined}
 */
export const reachOfStep = (step) => {
  if (step.kind === "precheck") return step.result === "handoff" ? { node: "kiro", reach: "handoff" } : undefined;
  if (step.kind !== "tool" && step.kind !== "skill") return undefined;
  const node = step.kind === "skill" ? "skills" : nodeOfTool(step.name);
  if (!node) return undefined;
  if (!step.ok) return { node, reach: "failed" };
  return { node, reach: step.confirm ? "waiting" : "used" };
};

/** @typedef {Readonly<Partial<Record<NodeId, Reach>>>} BrainState */

/**
 * The nodes whose tools the brain was offered this turn (#141). Profile and
 * Kiro aren't tools: they're never "not offered".
 * @param {readonly string[]} tools
 * @returns {Set<NodeId>}
 */
export const offeredNodes = (tools) => {
  /** @type {Set<NodeId>} */
  const nodes = new Set(["profile", "kiro"]);
  for (const t of tools) {
    const n = nodeOfTool(t);
    if (n) nodes.add(n);
  }
  return nodes;
};

/** @type {BrainState} */
export const EMPTY = {};

/**
 * Reaches that hold for the rest of the answer: an OK still to be given, or
 * the question handed to Kiro. Anything else is replaced by the latest
 * outcome, so a retry that worked shows as used.
 * @param {Reach | undefined} r
 */
const holds = (r) => r === "waiting" || r === "handoff";

/**
 * A tool call started: its node is being reached.
 * @param {BrainState} state @param {string} tool @returns {BrainState}
 */
export const applyReach = (state, tool) => {
  const node = nodeOfTool(tool);
  return node && !holds(state[node]) ? { ...state, [node]: "reaching" } : state;
};

/**
 * A step finished: its node shows the outcome, unless it holds.
 * @param {BrainState} state @param {PathStep} step @returns {BrainState}
 */
export const applyStep = (state, step) => {
  const r = reachOfStep(step);
  if (!r || holds(state[r.node])) return state;
  return { ...state, [r.node]: r.reach };
};

/**
 * The whole answer's state, from its final path. Anything still "reaching"
 * didn't finish: it shows as failed.
 * @param {readonly PathStep[]} path @returns {BrainState}
 */
export const stateOfPath = (path) => settle(path.reduce(applyStep, EMPTY));

/** @param {BrainState} state @returns {BrainState} */
export const settle = (state) =>
  Object.fromEntries(Object.entries(state).map(([node, reach]) => [node, reach === "reaching" ? "failed" : reach]));

/** True while any node is still being reached. @param {BrainState} state */
export const isReaching = (state) => Object.values(state).includes("reaching");

// Geometry, in a 600 × 600 box with the core at the centre; positions are
// percentages of the box, so the view scales with its width.
const NODE_R = 215;
const LINE_FROM = 82;
const LINE_TO = 182;
const FAILED_TO = 137;

/** @param {number} n */
const fx = (n) => Math.round(n * 1000) / 1000;

/**
 * Where a node sits. @param {number} angle degrees, 0 = right, clockwise
 * @returns {{ left: number, top: number }}
 */
export const nodePosition = (angle) => {
  const a = (angle * Math.PI) / 180;
  return { left: fx(50 + (Math.cos(a) * NODE_R) / 6), top: fx(50 + (Math.sin(a) * NODE_R) / 6) };
};

/**
 * A line from the core towards a node: start, length and angle. A failed
 * reach stops short, with its mark at the end.
 * @param {number} angle @param {Reach} reach
 * @returns {{ left: number, top: number, length: number, angle: number, end: { left: number, top: number } }}
 */
export const lineGeometry = (angle, reach) => {
  const a = (angle * Math.PI) / 180;
  const to = reach === "failed" ? FAILED_TO : LINE_TO;
  return {
    left: fx(50 + (Math.cos(a) * LINE_FROM) / 6),
    top: fx(50 + (Math.sin(a) * LINE_FROM) / 6),
    length: fx((to - LINE_FROM) / 6),
    angle,
    end: { left: fx(50 + (Math.cos(a) * to) / 6), top: fx(50 + (Math.sin(a) * to) / 6) },
  };
};

/** The words under a node. @type {Record<Reach | Rest, string>} */
export const NODE_TAGS = {
  reaching: "reaching…",
  used: "used",
  waiting: "waiting for OK",
  failed: "failed",
  handoff: "handed to Kiro",
  idle: "",
  off: "off",
  soon: "coming",
  kiro: "EC → Kiro",
};

/**
 * A node at rest, from what /reach says about it (#133).
 * @param {string} id @param {string} status "on" | "off" | "soon"
 * @returns {Rest}
 */
export const restOf = (id, status) => (id === "kiro" ? "kiro" : status === "soon" ? "soon" : status === "off" ? "off" : "idle");

/**
 * The command that connects an account, for a panel. Personal is the
 * calendar's first connection, so it needs no name.
 * @param {string} node @param {string} account
 */
export const connectCommand = (node, account) =>
  node === "gmail" ? `npm run gmail:connect -- ${account}` : account === "personal" ? "npm run calendar:connect" : `npm run calendar:connect -- ${account}`;

/**
 * A faint network inside the brain: fixed dots and links (no randomness at
 * run time, so it looks the same on every load).
 * @returns {{ dots: { left: number, top: number }[], links: { left: number, top: number, length: number, angle: number }[] }}
 */
export const mesh = () => {
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  /** @type {{ x: number, y: number }[]} */
  const points = [];
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 96 + rnd() * 74;
    points.push({ x: 300 + Math.cos(a) * d, y: 300 + Math.sin(a) * d });
  }
  /** @type {{ left: number, top: number, length: number, angle: number }[]} */
  const links = [];
  points.forEach((p, i) => {
    points
      .map((q, j) => ({ j, d: Math.hypot(q.x - p.x, q.y - p.y) }))
      .filter((o) => o.j > i && o.d < 120)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach((o) => {
        const q = points[o.j];
        if (q) links.push({ left: fx(p.x / 6), top: fx(p.y / 6), length: fx(o.d / 6), angle: fx((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI) });
      });
  });
  return { dots: points.map((p) => ({ left: fx(p.x / 6), top: fx(p.y / 6) })), links };
};
