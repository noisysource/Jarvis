// The brain view (#131): the core, the nodes around it, and a line to each
// node Jarvis reaches for in the current answer. States come from brain-lib.js;
// this file only draws them.

import { EMPTY, NODES, NODE_TAGS, applyReach, applyStep, isReaching, lineGeometry, mesh, nodePosition, settle, stateOfPath } from "./brain-lib.js";

/** @typedef {import("./brain-lib.js").BrainState} BrainState */
/** @typedef {import("./chat.js").PathStep} PathStep */

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
 * `open`: what clicking a node does, for the nodes that have something to open.
 * @param {HTMLElement} root
 * @param {{ open?: Partial<Record<string, () => void>> }} [options]
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

  /** @type {Map<string, { box: HTMLElement, tag: HTMLElement, rest: import("./brain-lib.js").Rest }>} */
  const nodes = new Map();
  const list = el("ul", "brain-nodes");
  for (const n of NODES) {
    const item = el("li", "brain-node-item");
    const pos = nodePosition(n.angle);
    item.style.cssText = `left:${pos.left}%;top:${pos.top}%`;
    const open = options.open?.[n.id];
    const box = /** @type {HTMLElement} */ (open ? document.createElement("button") : document.createElement("div"));
    box.className = "brain-node";
    box.dataset.node = n.id;
    box.dataset.state = n.rest;
    if (open && box instanceof HTMLButtonElement) {
      box.type = "button";
      box.addEventListener("click", open);
    }
    const disc = el("span", "brain-disc");
    disc.append(icon(n.id));
    const label = el("span", "brain-label");
    label.textContent = n.label;
    const tag = el("span", "brain-tag");
    tag.textContent = NODE_TAGS[n.rest];
    box.append(disc, label, tag);
    item.append(box);
    list.append(item);
    nodes.set(n.id, { box, tag, rest: n.rest });
  }

  stage.append(net, lines, core, list);
  root.append(stage);

  /** @type {BrainState} */
  let state = EMPTY;
  let working = false;

  const draw = () => {
    lines.replaceChildren();
    for (const n of NODES) {
      const reach = state[n.id];
      const node = nodes.get(n.id);
      if (!node) continue;
      const shown = reach ?? node.rest;
      node.box.dataset.state = shown;
      node.tag.textContent = NODE_TAGS[shown];
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
    /** A new question: the lines of the last answer go. */
    begin: () => {
      state = EMPTY;
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
      draw();
    },
  };
};
