// The morning brief (#177), on the page: a card above the conversation with
// today's brief, until he dismisses it for the day. Set as text, never HTML.
// The dismissal is kept in this browser only (a convenience).

const KEY = "jarvis.brief.dismissed";

/** @param {string} key */
const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
/** @param {string} key @param {string} value */
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows: the card just comes back next load.
  }
};

/** "2026-11-14" → "Saturday 14 November" @param {string} day */
export const dayLabel = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
};

/** @param {HTMLElement} before the element the card goes above */
export const showMorningBrief = async (before) => {
  /** @type {{ day: string, text: string, summary: string } | null} */
  let brief = null;
  try {
    const res = await fetch("/brief/today", { cache: "no-store" });
    if (res.ok) brief = /** @type {{ brief: any }} */ (await res.json()).brief ?? null;
  } catch {
    brief = null;
  }
  if (!brief || typeof brief.text !== "string" || typeof brief.day !== "string" || read(KEY) === brief.day) return;
  const card = document.createElement("section");
  card.className = "morning";
  card.setAttribute("aria-label", "Morning brief");
  const head = document.createElement("div");
  head.className = "morning-head";
  const title = document.createElement("h2");
  title.textContent = `☀️ ${dayLabel(brief.day)}`;
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = "Got it";
  const day = brief.day;
  done.addEventListener("click", () => {
    write(KEY, day);
    card.remove();
  });
  head.append(title, done);
  card.append(head);
  for (const para of brief.text.split(/\n\s*\n/)) {
    const p = document.createElement("p");
    p.textContent = para.trim();
    if (p.textContent) card.append(p);
  }
  if (typeof brief.summary === "string" && brief.summary) {
    const small = document.createElement("p");
    small.className = "morning-summary";
    small.textContent = brief.summary;
    card.append(small);
  }
  before.before(card);
};
