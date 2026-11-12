// The reasoning trace (#143), drawn: a tree that grows left to right while
// Jarvis works (brain → Tools → tool → service → account · result) and
// stays until the next question. States come from trace-lib.js.

import { EMPTY_TRACE, settleTrace, traceOfPath, traceReach, traceStep, traceTree } from "./trace-lib.js";

/** @typedef {import("./chat.js").PathStep} PathStep */
/** @typedef {import("./trace-lib.js").Trace} Trace */

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** @param {HTMLElement} root */
export const makeTraceView = (root) => {
  root.className = "trace";
  root.hidden = true;
  const head = el("div", "trace-head", "How he got there");
  const scroll = el("div", "trace-scroll");
  root.replaceChildren(head, scroll);

  /** @type {Trace} */
  let trace = EMPTY_TRACE;
  let brain = "Jarvis";
  let working = false;
  /** Parts already on screen: only new ones pop in. @type {Set<string>} */
  let seen = new Set();

  /**
   * A tree item: its box, and the list its children go in.
   * @param {string} key @param {string} status @param {HTMLElement} box
   */
  const item = (key, status, box) => {
    const li = el("li", "");
    li.dataset.status = status;
    if (!seen.has(key)) {
      box.classList.add("t-new");
      seen.add(key);
    }
    li.append(box);
    return li;
  };

  /** @param {HTMLElement} li */
  const children = (li) => {
    const ul = el("ul", "t-children");
    li.append(ul);
    return ul;
  };

  const draw = () => {
    const tree = traceTree(trace);
    const top = el("ul", "t-tree");
    const brainBox = el("span", `t-node t-brain${working ? " t-working" : ""}`, brain);
    const brainItem = item("brain", working ? "reaching" : "used", brainBox);
    top.append(brainItem);
    const under = children(brainItem);

    if (tree.handoff) under.append(item("kiro", "handoff", el("span", "t-node t-hub", "EC → Kiro (no model, no tools)")));
    if (trace.offered !== undefined || tree.branches.length > 0) {
      const hub = item("hub", tree.status, el("span", "t-node t-hub", tree.hub));
      under.append(hub);
      if (tree.branches.length > 0) {
        const tools = children(hub);
        for (const b of tree.branches) {
          const toolItem = item(`tool:${b.tool}`, b.status, el("code", "t-node t-tool", b.tool === "skill" ? "skill" : b.tool));
          tools.append(toolItem);
          const serviceItem = item(`service:${b.tool}`, b.status, el("span", "t-node t-service", b.service));
          children(toolItem).append(serviceItem);
          const leaves = children(serviceItem);
          b.leaves.forEach((leaf, i) => {
            const box = el("span", "t-node t-leaf");
            if (leaf.status === "reaching") box.textContent = "reaching…";
            else {
              if (leaf.label) box.append(el("span", "t-target", leaf.label));
              box.append(el("span", "t-result", leaf.result));
            }
            leaves.append(item(`leaf:${b.tool}:${i}`, leaf.status, box));
          });
        }
      }
    } else if (working) {
      under.append(item("thinking", "reaching", el("span", "t-node t-hub", "thinking…")));
    }
    scroll.replaceChildren(top);
    root.hidden = false;
  };

  return {
    /** A new question: the last trace goes. @param {string} name the brain's name */
    begin: (name) => {
      brain = name;
      trace = EMPTY_TRACE;
      seen = new Set();
      working = true;
      draw();
    },
    /** @param {string} tool */
    reach: (tool) => {
      trace = traceReach(trace, tool);
      draw();
    },
    /** @param {PathStep} step */
    step: (step) => {
      trace = traceStep(trace, step);
      draw();
    },
    /**
     * The answer is in: its final path is the record (live events may have
     * been missed), and anything unfinished is marked so.
     * @param {readonly PathStep[]} path
     */
    finish: (path) => {
      working = false;
      const brainStep = path.find((s) => s.kind === "brain");
      if (brainStep && brainStep.kind === "brain") brain = brainStep.brain === "claude" ? "Claude" : "Local";
      trace = path.length > 0 ? traceOfPath(path) : settleTrace(trace);
      draw();
    },
  };
};
