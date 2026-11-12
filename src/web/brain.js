// The brain view (#131): the core, the nodes around it, and a line to each
// node Jarvis reaches for in the current answer. States come from brain-lib.js;
// this file only draws them.

import { EMPTY, NODES, NODE_TAGS, applyReach, applyStep, connectCommand, isReaching, lineGeometry, mesh, nodePosition, offeredNodes, restOf, settle, stateOfPath } from "./brain-lib.js";

/** @typedef {import("./brain-lib.js").BrainState} BrainState */
/** @typedef {import("./chat.js").PathStep} PathStep */
/**
 * One node as GET /reach describes it (#133): names, on/off and counts only.
 * @typedef {{ id: string, status: string, about: string, tools: { name: string, does: string }[], accounts?: { name: string, connected: boolean }[], hint?: string, waiting?: number }} ReachNode
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Line icons, 24 × 24, drawn with the text colour. @type {Record<string, string[]>} */
const ICONS = {
  profile: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20c0-4 4-6 8-6s8 2 8 6"],
  memory: ["M12 3 3 8l9 5 9-5-9-5z", "m3 13 9 5 9-5", "m3 17.5 9 5 9-5"],
  skills: ["M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"],
  calendar: ["M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M3 10h18M8 3v4M16 3v4"],
  gmail: ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "m3 7 9 6 9-6"],
  github: ["M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M6 7v10M18 10c0 4-4 5-10.5 7.5"],
  code: ["m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"],
  kiro: ["M14 4h6v6M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
};

/** @param {string} id */
const icon = (id) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[id] ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};

/** @param {string} tag @param {string} className */
const el = (tag, className) => {
  const e = document.createElement(tag);
  e.className = className;
  return e;
};

/**
 * Draws the brain into `root` and returns the calls that move it.
 * Clicking a node opens its panel (#133); `open` adds a button there for
 * nodes with a fuller view of their own (Memory, Skills).
 * @param {HTMLElement} root
 * @param {{ open?: Partial<Record<string, { label: string, run: () => void }>> }} [options]
 */
export const makeBrainView = (root, options = {}) => {
  root.replaceChildren();
  const stage = el("div", "brain-stage");

  const net = el("div", "brain-mesh");
  net.setAttribute("aria-hidden", "true");
  const m = mesh();
  for (const l of m.links) {
    const line = el("span", "brain-mesh-link");
    line.style.cssText = `left:${l.left}%;top:${l.top}%;width:${l.length}%;transform:rotate(${l.angle}deg)`;
    net.append(line);
  }
  for (const d of m.dots) {
    const dot = el("span", "brain-mesh-dot");
    dot.style.cssText = `left:${d.left}%;top:${d.top}%`;
    net.append(dot);
  }

  const lines = el("div", "brain-lines");
  lines.setAttribute("aria-hidden", "true");

  const core = el("div", "brain-core");
  core.append(el("span", "brain-ring"), el("span", "brain-ring brain-ring-outer"));
  const face = el("div", "brain-face");
  const name = el("span", "brain-name");
  const sub = el("span", "brain-sub");
  face.append(name, sub);
  core.append(face);

  /** @type {Map<string, { box: HTMLButtonElement, tag: HTMLElement, badge: HTMLElement, rest: import("./brain-lib.js").Rest }>} */
  const nodes = new Map();
  const list = el("ul", "brain-nodes");
  for (const n of NODES) {
    const item = el("li", "brain-node-item");
    const pos = nodePosition(n.angle);
    item.style.cssText = `left:${pos.left}%;top:${pos.top}%`;
    const box = document.createElement("button");
    box.type = "button";
    box.className = "brain-node";
    box.dataset.node = n.id;
    box.dataset.state = n.rest;
    box.setAttribute("aria-expanded", "false");
    box.setAttribute("aria-controls", "brain-panel");
    box.addEventListener("click", () => togglePanel(n.id));
    const disc = el("span", "brain-disc");
    disc.append(icon(n.id));
    const badge = el("span", "brain-badge");
    badge.hidden = true;
    disc.append(badge);
    const label = el("span", "brain-label");
    label.textContent = n.label;
    const tag = el("span", "brain-tag");
    tag.textContent = NODE_TAGS[n.rest];
    box.append(disc, label, tag);
    item.append(box);
    list.append(item);
    nodes.set(n.id, { box, tag, badge, rest: n.rest });
  }

  const panel = el("section", "brain-panel");
  panel.id = "brain-panel";
  panel.hidden = true;

  stage.append(net, lines, core, list);
  root.append(stage, panel);

  /** @type {Map<string, ReachNode>} */
  let known = new Map();
  /** @type {string | undefined} */
  let shown;
  /** Cards waiting for an OK, per node (from the page). @type {Record<string, number>} */
  let pendingCards = {};

  const drawBadges = () => {
    for (const [id, node] of nodes) {
      const count = (pendingCards[id] ?? 0) + (known.get(id)?.waiting ?? 0);
      node.badge.hidden = count === 0;
      node.badge.textContent = String(count);
      const label = NODES.find((x) => x.id === id)?.label ?? id;
      node.box.setAttribute("aria-label", count > 0 ? `${label}, ${count} waiting for you` : label);
    }
  };

  /** @param {string} tag @param {string} className @param {string} text */
  const text = (tag, className, text) => {
    const e = el(tag, className);
    e.textContent = text;
    return e;
  };

  const drawPanel = () => {
    panel.replaceChildren();
    if (!shown) {
      panel.hidden = true;
      return;
    }
    const id = shown;
    const info = known.get(id);
    const label = NODES.find((x) => x.id === id)?.label ?? id;
    panel.hidden = false;
    panel.setAttribute("aria-label", label);

    const head = el("div", "brain-panel-head");
    const title = el("div", "brain-panel-title");
    title.append(text("h2", "", label));
    if (info) title.append(text("span", `brain-status brain-status-${info.status}`, info.status === "on" ? "on" : info.status === "off" ? "off" : "coming"));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "brain-panel-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => togglePanel(id));
    head.append(title, close);
    panel.append(head);

    if (!info) {
      panel.append(text("p", "brain-panel-about", "Couldn't load what this can do. Is Jarvis running?"));
      return;
    }
    panel.append(text("p", "brain-panel-about", info.about));
    if (info.waiting) panel.append(text("p", "brain-panel-waiting", `${info.waiting} waiting for your review.`));

    if (info.tools.length > 0) {
      panel.append(text("h3", "", "Tools"));
      const ul = el("ul", "brain-panel-list");
      for (const t of info.tools) {
        const li = el("li", "");
        li.append(text("code", "", t.name), text("span", "", t.does));
        ul.append(li);
      }
      panel.append(ul);
    }
    if (info.accounts && info.accounts.length > 0) {
      panel.append(text("h3", "", "Accounts"));
      const ul = el("ul", "brain-panel-list");
      for (const a of info.accounts) {
        const li = el("li", a.connected ? "connected" : "not-connected");
        li.append(text("span", "", a.name), text("span", "", a.connected ? "connected" : `not connected: ${connectCommand(id, a.name)}`));
        ul.append(li);
      }
      panel.append(ul);
    }
    if (info.hint && info.status !== "on") panel.append(text("p", "brain-panel-hint", info.hint));
    const open = options.open?.[id];
    if (open && info.status === "on") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = open.label;
      b.addEventListener("click", open.run);
      panel.append(b);
    }
  };

  /** @param {string} id */
  const togglePanel = (id) => {
    shown = shown === id ? undefined : id;
    for (const [nid, node] of nodes) node.box.setAttribute("aria-expanded", String(nid === shown));
    drawPanel();
  };

  /** @type {BrainState} */
  let state = EMPTY;
  let working = false;
  /** #141: the nodes offered this turn; undefined until the answer says. @type {Set<string> | undefined} */
  let offered;

  const draw = () => {
    lines.replaceChildren();
    for (const n of NODES) {
      const reach = state[n.id];
      const node = nodes.get(n.id);
      if (!node) continue;
      const shown = reach ?? node.rest;
      node.box.dataset.state = shown;
      const notOffered = offered !== undefined && !offered.has(n.id) && !reach;
      node.box.dataset.offered = offered === undefined ? "" : notOffered ? "no" : "yes";
      node.tag.textContent = notOffered && (shown === "idle" || shown === "off") ? "not offered" : NODE_TAGS[shown];
      if (!reach) continue;
      const g = lineGeometry(n.angle, reach);
      const line = el("span", `brain-line brain-line-${reach}`);
      line.style.cssText = `left:${g.left}%;top:${g.top}%;width:${g.length}%;transform:rotate(${g.angle}deg)`;
      lines.append(line);
      if (reach === "failed") {
        const mark = el("span", "brain-fail-mark");
        mark.style.cssText = `left:${g.end.left}%;top:${g.end.top}%`;
        lines.append(mark);
      }
    }
    const waiting = Object.values(state).includes("waiting");
    const busy = working || isReaching(state);
    root.dataset.working = String(busy);
    core.dataset.state = busy ? "working" : waiting ? "waiting" : "idle";
    sub.textContent = busy ? "thinking" : waiting ? "waiting" : "ready";
  };

  /** @param {string} brain */
  const setBrain = (brain) => {
    name.textContent = brain;
  };

  setBrain("Jarvis");
  draw();

  return {
    setBrain,
    /**
     * What each node can do and what's connected (GET /reach, #133): the
     * nodes' resting look, the panels and the waiting-for-review badges.
     * @param {readonly ReachNode[]} list
     */
    setReach: (list) => {
      known = new Map(list.map((n) => [n.id, n]));
      for (const n of list) {
        const node = nodes.get(n.id);
        if (node) node.rest = restOf(n.id, n.status);
      }
      draw();
      drawBadges();
      drawPanel();
    },
    /**
     * Cards on the page still waiting for an OK, per node.
     * @param {Record<string, number>} counts
     */
    setPending: (counts) => {
      pendingCards = counts;
      drawBadges();
    },
    /** A new question: the lines of the last answer go. */
    begin: () => {
      state = EMPTY;
      offered = undefined;
      working = true;
      draw();
    },
    /** A tool call started. @param {string} tool */
    reach: (tool) => {
      state = applyReach(state, tool);
      draw();
    },
    /** A step ended. @param {PathStep} step */
    step: (step) => {
      if (step.kind === "tools") offered = offeredNodes(step.offered);
      state = applyStep(state, step);
      draw();
    },
    /**
     * The answer is in. Its final path is the record (the live events may
     * have been missed, e.g. a non-streamed reply).
     * @param {readonly PathStep[]} path
     */
    finish: (path) => {
      working = false;
      state = path.length > 0 ? stateOfPath(path) : settle(state);
      const tools = path.find((s) => s.kind === "tools");
      if (tools && tools.kind === "tools") offered = offeredNodes(tools.offered);
      draw();
    },
  };
};
