// Code maps (#158), drawn: a studied repo or app as boxes and lines, in a
// dialog. Pick a part to light up what it connects to and read what it is
// and where it lives. Positions come from codemap-lib.js.
//
// Everything shown is from Jarvis's own note on the code (names, paths, one
// line each): set as text, never as HTML.

import { connectionsOf, layoutMap, mapTitle, NODE_H, NODE_W } from "./codemap-lib.js";

/** @typedef {import("./codemap-lib.js").CodeMap} CodeMap */

const SVG_NS = "http://www.w3.org/2000/svg";

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** @param {HTMLDialogElement} dialog */
export const makeCodeMapView = (dialog) => {
  dialog.className = "codemap";
  const head = el("div", "codemap-head");
  const title = el("h2", "");
  const pick = document.createElement("select");
  pick.setAttribute("aria-label", "Which map");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  head.append(title, pick, close);
  const note = el("p", "codemap-note");
  const scroll = el("div", "codemap-scroll");
  const detail = el("div", "codemap-detail");
  detail.setAttribute("aria-live", "polite");
  dialog.replaceChildren(head, note, scroll, detail);

  /** @type {CodeMap[]} */
  let maps = [];
  /** @type {CodeMap | undefined} */
  let current;
  /** @type {string | undefined} */
  let selected;

  const drawDetail = () => {
    detail.replaceChildren();
    const node = current?.nodes.find((n) => n.id === selected);
    if (!current || !node) {
      detail.append(el("p", "codemap-hint", "Pick a part to see what it is, where it lives and what it connects to."));
      return;
    }
    const top = el("div", "codemap-detail-top");
    top.append(el("strong", "", node.label), el("span", "codemap-kind", node.kind));
    detail.append(top);
    if (node.path) detail.append(el("code", "codemap-path", node.path));
    if (node.about) detail.append(el("p", "", node.about));
    const links = connectionsOf(node.id, current.nodes, current.edges);
    if (links.length > 0) {
      const ul = el("ul", "codemap-links");
      for (const l of links) ul.append(el("li", "", `${l.arrow} ${l.label}${l.how ? ` (${l.how})` : ""}`));
      detail.append(ul);
    }
  };

  const draw = () => {
    scroll.replaceChildren();
    if (!current) return;
    title.textContent = mapTitle(current);
    note.textContent = `From Jarvis's study on ${current.studiedAt.slice(0, 10)}${current.partial ? " (it hit its limit, so this may be incomplete)" : ""}. ${current.nodes.length} parts, ${current.edges.length} connections.`;
    if (current.nodes.length === 0) {
      scroll.append(el("p", "codemap-hint", "This study didn't produce a map. Ask him to study it again."));
      drawDetail();
      return;
    }
    const layout = layoutMap(current.nodes, current.edges);
    const canvas = el("div", "codemap-canvas");
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    svg.setAttribute("aria-hidden", "true");
    /** @type {{ path: SVGPathElement, from: string, to: string }[]} */
    const paths = [];
    for (const l of layout.lines) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", l.d);
      svg.append(p);
      paths.push({ path: p, from: l.from, to: l.to });
    }
    canvas.append(svg);
    for (const h of layout.heads) {
      const t = el("span", "codemap-col", h.title);
      t.style.left = `${h.x}px`;
      canvas.append(t);
    }

    /** @type {Map<string, HTMLButtonElement>} */
    const boxes = new Map();
    const light = () => {
      const near = new Set(selected ? [selected] : []);
      for (const p of paths) {
        const on = selected !== undefined && (p.from === selected || p.to === selected);
        p.path.setAttribute("class", selected === undefined ? "" : on ? "on" : "off");
        if (on) {
          near.add(p.from);
          near.add(p.to);
        }
      }
      for (const [id, b] of boxes) {
        b.dataset.lit = selected === undefined ? "" : near.has(id) ? "yes" : "no";
        b.setAttribute("aria-pressed", String(id === selected));
      }
    };
    for (const n of layout.nodes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "codemap-node";
      b.dataset.kind = n.kind;
      b.style.cssText = `left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px`;
      b.textContent = n.label;
      b.title = n.label;
      b.addEventListener("click", () => {
        selected = selected === n.id ? undefined : n.id;
        light();
        drawDetail();
      });
      boxes.set(n.id, b);
      canvas.append(b);
    }
    scroll.append(canvas);
    light();
    drawDetail();
  };

  pick.addEventListener("change", () => {
    current = maps.find((m) => m.key === pick.value);
    selected = undefined;
    draw();
  });

  return {
    /**
     * Opens the maps, on the one asked for (or the first).
     * @param {string} [key] "owner/repo" or "owner/repo:folder"
     */
    open: async (key) => {
      try {
        const res = await fetch("/code/maps", { cache: "no-store" });
        const body = /** @type {{ maps?: CodeMap[] }} */ (res.ok ? await res.json() : {});
        maps = Array.isArray(body.maps) ? body.maps : [];
      } catch {
        maps = [];
      }
      pick.replaceChildren();
      for (const m of maps) {
        const o = document.createElement("option");
        o.value = m.key;
        o.textContent = mapTitle(m);
        pick.append(o);
      }
      current = maps.find((m) => m.key === key) ?? maps[0];
      selected = undefined;
      if (current) pick.value = current.key;
      pick.hidden = maps.length < 2;
      if (!current) {
        title.textContent = "Code maps";
        note.textContent = 'Nothing studied yet. Ask Jarvis to "study" a repo.';
        scroll.replaceChildren();
        detail.replaceChildren();
      } else draw();
      if (!dialog.open) dialog.showModal();
    },
  };
};
