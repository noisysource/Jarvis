// What the code agent is studying in the background (#156): a card under the
// brain that shows the running study (repo or app, step, time, the files
// it's on right now), the queue behind it, what failed and what finished,
// with a Stop button. It polls GET /code/studies while anything is active.
//
// Everything shown is names, counts and file paths: never file content.

/**
 * @typedef {{ repo: string, folder: string, state: "queued" | "running" | "failed", error?: string, startedAt?: string, steps?: number, recent?: { tool: string, target: string }[] }} Active
 * @typedef {{ repo: string, folder: string, finishedAt: string, turns: number, seconds: number, partial: boolean, parts: number }} Done
 * @typedef {{ active: Active[], finished: Done[] }} StudiesView
 */

/** "noisysource/noisysource · apps/kidclub" @param {{ repo: string, folder: string }} s */
export const studyName = (s) => `${s.repo}${s.folder ? ` · ${s.folder}` : ""}`;

/** "2 min 05 s" @param {number} seconds */
export const duration = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};

/**
 * What the card says, as plain data (drawn by makeStudiesView, tested here).
 * @param {StudiesView} view @param {number} now ms
 */
export const studiesSummary = (view, now) => {
  const running = view.active.find((s) => s.state === "running");
  const queued = view.active.filter((s) => s.state === "queued");
  const failed = view.active.filter((s) => s.state === "failed");
  return {
    busy: running !== undefined || queued.length > 0,
    empty: view.active.length === 0 && view.finished.length === 0,
    running: running
      ? {
          name: studyName(running),
          line: `step ${running.steps ?? 0} · ${duration((now - Date.parse(running.startedAt ?? new Date(now).toISOString())) / 1000)}`,
          recent: (running.recent ?? []).map((r) => `${r.tool} ${r.target}`.trim()).reverse(),
        }
      : undefined,
    queued: queued.map(studyName),
    failed: failed.map((s) => ({ name: studyName(s), error: s.error ?? "failed" })),
    finished: view.finished.slice(0, 6).map((d) => ({ name: studyName(d), line: `${d.partial ? "partial · " : ""}${d.turns} steps · ${duration(d.seconds)} · ${d.parts} parts` })),
  };
};

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * @param {HTMLElement} root
 * @param {{ onBusy?: (busy: boolean) => void, onChange?: () => void }} [options] onBusy: a study started or the last one ended; onChange: one finished or failed
 */
export const makeStudiesView = (root, options = {}) => {
  root.className = "studies";
  root.hidden = true;
  let busy = false;
  let seen = "";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @param {StudiesView} view */
  const draw = (view) => {
    const s = studiesSummary(view, Date.now());
    root.hidden = s.empty;
    if (s.empty) return;
    const head = el("div", "studies-head");
    head.append(el("span", "", s.busy ? "Studying in the background" : "Studies"));
    if (s.busy || s.failed.length > 0) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = s.busy ? "Stop" : "Clear";
      stop.addEventListener("click", async () => {
        stop.disabled = true;
        await fetch("/code/studies/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
        void refresh();
      });
      head.append(stop);
    }
    const body = el("div", "studies-body");
    if (s.running) {
      const now = el("div", "studies-running");
      now.append(el("strong", "", s.running.name), el("span", "studies-meta", s.running.line));
      body.append(now);
      if (s.running.recent.length > 0) {
        const log = el("ol", "studies-log");
        for (const line of s.running.recent) log.append(el("li", "", line));
        body.append(log);
      } else body.append(el("p", "studies-meta", "Getting the code…"));
    }
    if (s.queued.length > 0) body.append(el("p", "studies-meta", `Next: ${s.queued.join(", ")}`));
    for (const f of s.failed) body.append(el("p", "studies-failed", `${f.name}: ${f.error}`));
    if (s.finished.length > 0) {
      const list = el("ul", "studies-done");
      for (const d of s.finished) {
        const li = el("li", "");
        li.append(el("span", "", d.name), el("span", "studies-meta", d.line));
        list.append(li);
      }
      body.append(list);
    }
    root.replaceChildren(head, body);
  };

  const refresh = async () => {
    clearTimeout(timer);
    /** @type {StudiesView | undefined} */
    let view;
    try {
      const res = await fetch("/code/studies", { cache: "no-store" });
      if (res.ok) view = /** @type {StudiesView} */ (await res.json());
    } catch {
      view = undefined;
    }
    if (view && Array.isArray(view.active) && Array.isArray(view.finished)) {
      draw(view);
      const nowBusy = view.active.some((s) => s.state !== "failed");
      if (nowBusy !== busy) options.onBusy?.(nowBusy);
      busy = nowBusy;
      // Something finished or failed since last time: the panel's list changed too.
      const mark = `${view.finished.length}:${view.finished[0]?.finishedAt ?? ""}:${view.active.filter((s) => s.state === "failed").length}`;
      if (mark !== seen && seen !== "") options.onChange?.();
      seen = mark;
    }
    // Quick while he's working, slow otherwise (a study can be started from the chat at any time).
    timer = setTimeout(() => void refresh(), busy ? 2000 : 15_000);
  };

  return { refresh };
};
