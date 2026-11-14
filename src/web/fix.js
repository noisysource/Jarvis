// Fixes as pull requests (#162), drawn: after "Prepare it", the card follows
// the job, then shows the diff with the second question, "Open the pull
// request" / "Throw it away". Everything from the job is set as text.

import { diffLines, fixStatusText } from "./fix-lib.js";

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * @param {HTMLElement} card the confirm card
 * @param {string} id the job
 * @param {{ say: (ok: boolean, text: string, url?: string, tool?: string) => void, pending: (waiting: boolean) => void }} deps
 */
export const followFix = (card, id, deps) => {
  const status = el("p", "fix-status");
  status.setAttribute("aria-live", "polite");
  card.append(status);

  /** @param {any} view */
  const showReady = (view) => {
    const box = el("div", "fix-ready");
    if (view.summary) box.append(el("p", "fix-summary", view.summary));
    if (view.stat) box.append(el("pre", "fix-stat", view.stat));
    const pre = el("pre", "fix-diff");
    for (const line of diffLines(typeof view.diff === "string" ? view.diff : "")) {
      const span = el("span", `diff-${line.kind}`, line.text);
      pre.append(span, document.createTextNode("\n"));
    }
    const details = document.createElement("details");
    details.append(el("summary", "", "The diff"), pre);
    box.append(details);
    if (view.truncated) box.append(el("p", "fix-note", "The diff is cut short here; the pull request will have all of it."));
    const choices = el("div", "choices");
    /** @param {"yes" | "no"} decision @param {string} label */
    const button = (decision, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", async () => {
        for (const other of choices.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (other).disabled = true;
        b.classList.add("picked");
        deps.pending(false);
        /** @type {{ ok?: boolean, text?: string, url?: string, tool?: string }} */
        let result;
        try {
          const res = await fetch("/code/fixes/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) });
          result = await res.json().catch(() => ({}));
        } catch {
          result = { ok: false, text: "I can't reach Jarvis, so nothing was pushed." };
        }
        deps.say(result.ok === true, typeof result.text === "string" ? result.text : "Something went wrong, so nothing was pushed.", typeof result.url === "string" ? result.url : undefined, typeof result.tool === "string" ? result.tool : undefined);
      });
      return b;
    };
    choices.append(button("yes", "Open the pull request"), button("no", "Throw it away"));
    box.append(choices);
    card.append(box);
    deps.pending(true);
  };

  const poll = async () => {
    /** @type {any} */
    let view;
    try {
      const res = await fetch(`/code/fixes/${encodeURIComponent(id)}`, { cache: "no-store" });
      view = res.ok ? await res.json() : undefined;
    } catch {
      view = undefined;
    }
    if (!view || typeof view.status !== "string") {
      status.textContent = "I lost track of that fix (Jarvis may have restarted). Nothing was pushed.";
      return;
    }
    const s = fixStatusText(view);
    status.textContent = s.text;
    if (!s.done) {
      setTimeout(() => void poll(), 3000);
      return;
    }
    if (view.status === "ready") showReady(view);
    else deps.say(s.ok, s.text);
  };
  void poll();
};
