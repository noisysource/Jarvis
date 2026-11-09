// @ts-check
// The /voices audition page (#73, dev only): plays the same five sentences
// in every voice, with time to first audio, and shows the .env lines for
// the one you pick. A box takes your own sentence too (#94).

import { playSpeech } from "./audio.js";
import { voicesFor } from "./chat.js";
import { AUDITION_SENTENCES, browserEnglishVoices, envLines, formatMs, median, OWN_SENTENCE_EXAMPLE, ownSentence } from "./voices-lib.js";

/** @param {string} id */
const byId = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const status = byId("status");
const head = byId("voices-head");
const body = byId("voices-body");
const browserBody = byId("browser-body");

// Your own sentence (#94): kept in this browser only, for the next visit.
const ownText = /** @type {HTMLTextAreaElement} */ (byId("own-text"));
const ownAsJarvis = /** @type {HTMLInputElement} */ (byId("own-as-jarvis"));
const OWN_KEY = "jarvis.voices.own";
try {
  ownText.value = localStorage.getItem(OWN_KEY) ?? OWN_SENTENCE_EXAMPLE;
} catch {
  ownText.value = OWN_SENTENCE_EXAMPLE;
}
ownText.addEventListener("input", () => {
  try {
    localStorage.setItem(OWN_KEY, ownText.value);
  } catch {
    /* private mode: it just isn't kept */
  }
});

/** @type {AudioContext | undefined} */
let ctx;
const audio = () => (ctx ??= new AudioContext());
/** @type {AbortController | undefined} */
let playing;
const stopPlaying = () => {
  playing?.abort();
  window.speechSynthesis?.cancel();
};

/** @type {Map<string, number[]>} time to first audio per row */
const timings = new Map();

/**
 * Plays one sentence with one voice; returns the time to first audio in ms.
 * @param {{ provider: string, voice: string }} row @param {string} text
 */
const play = async (row, text) => {
  stopPlaying();
  const controller = new AbortController();
  playing = controller;
  const asked = performance.now();
  if (row.provider === "browser") {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = speechSynthesis.getVoices().find((x) => x.name === row.voice);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
      let first = 0;
      u.onstart = () => (first = performance.now() - asked);
      u.onend = () => resolve(first);
      u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve(first) : reject(new Error(e.error)));
      speechSynthesis.speak(u);
    });
  }
  await audio().resume();
  const res = await fetch("/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, provider: row.provider, voice: row.voice }),
    signal: controller.signal,
  });
  if (!res.ok) {
    const problem = await res.json().catch(() => null);
    throw new Error(problem?.message ?? `status ${res.status}`);
  }
  let firstAt = 0;
  await playSpeech({ ctx: audio(), response: res, signal: controller.signal, onFirstAudio: (at) => (firstAt = at) });
  return firstAt - asked;
};

/**
 * A provider that isn't running, or is still starting (#80): one row, one message.
 * @param {string} provider @param {string} problem @param {boolean} starting
 */
const addUnavailable = (provider, problem, starting) => {
  const tr = document.createElement("tr");
  tr.className = starting ? "unavailable starting" : "unavailable";
  const name = document.createElement("td");
  name.textContent = provider;
  const message = document.createElement("td");
  message.colSpan = AUDITION_SENTENCES.length + 3;
  message.textContent = starting ? `${problem}… this list refreshes when it's up.` : problem;
  tr.append(name, message);
  body.append(tr);
};

/** @param {{ provider: string, voice: string, label: string, available: boolean, problem?: string }} row @param {HTMLElement} [into] */
const addRow = (row, into = body) => {
  const key = `${row.provider}:${row.voice}`;
  const tr = document.createElement("tr");
  if (!row.available) tr.className = "unavailable";
  const name = document.createElement("td");
  name.textContent = `${row.provider} · ${row.label}`;
  tr.append(name);
  /** @type {HTMLElement[]} */
  const cells = [];
  for (const sentence of AUDITION_SENTENCES) {
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "▶";
    button.disabled = !row.available;
    button.setAttribute("aria-label", `${row.label}: ${sentence.label}`);
    const time = document.createElement("span");
    time.className = "ttfa";
    time.textContent = row.available ? "" : row.problem ?? "not available";
    button.addEventListener("click", async () => {
      status.textContent = `Playing ${row.label}…`;
      try {
        const ms = await play(row, sentence.text);
        time.textContent = formatMs(ms);
        timings.set(key, [...(timings.get(key) ?? []), ms]);
        medianCell.textContent = formatMs(median(timings.get(key) ?? []));
        status.textContent = "";
      } catch (e) {
        time.textContent = "failed";
        status.textContent = `${row.label}: ${e instanceof Error ? e.message : "failed"}`;
      }
    });
    td.append(button, time);
    tr.append(td);
    cells.push(button);
  }
  // Your own sentence (#94): not part of the median, since it's different text.
  const own = document.createElement("td");
  const ownButton = document.createElement("button");
  ownButton.type = "button";
  ownButton.textContent = "▶";
  ownButton.disabled = !row.available;
  ownButton.setAttribute("aria-label", `${row.label}: your sentence`);
  const ownTime = document.createElement("span");
  ownTime.className = "ttfa";
  ownButton.addEventListener("click", async () => {
    const text = ownSentence(ownText.value, { asJarvis: ownAsJarvis.checked });
    if (text === "") {
      status.textContent = "Type a sentence first.";
      return;
    }
    status.textContent = `Playing ${row.label}…`;
    try {
      ownTime.textContent = formatMs(await play(row, text));
      status.textContent = "";
    } catch (e) {
      ownTime.textContent = "failed";
      status.textContent = `${row.label}: ${e instanceof Error ? e.message : "failed"}`;
    }
  });
  own.append(ownButton, ownTime);
  tr.append(own);
  const all = document.createElement("td");
  const playAll = document.createElement("button");
  playAll.type = "button";
  playAll.textContent = "Play all 5";
  playAll.disabled = !row.available;
  playAll.addEventListener("click", async () => {
    for (const b of cells) {
      b.click();
      // Wait for this sentence to finish before the next one.
      await new Promise((r) => setTimeout(r, 300));
      while (status.textContent?.startsWith("Playing")) await new Promise((r) => setTimeout(r, 100));
    }
  });
  const medianCell = document.createElement("span");
  medianCell.className = "ttfa";
  all.append(playAll, medianCell);
  const use = document.createElement("td");
  const choose = document.createElement("button");
  choose.type = "button";
  choose.textContent = "Use this voice";
  choose.disabled = !row.available;
  choose.addEventListener("click", () => {
    for (const r of body.querySelectorAll("tr")) r.classList.remove("chosen");
    tr.classList.add("chosen");
    byId("choice-lines").textContent = envLines(row.provider, row.voice);
    byId("choice").hidden = false;
  });
  use.append(choose);
  tr.append(all, use);
  into.append(tr);
};

const STARTING_POLL_MS = 3000;
let lastShown = "";

/** Kokoro and Piper rows; while one is starting, asks again until it's up. */
const loadServerVoices = async () => {
  const res = await fetch("/tts");
  const info = await res.json();
  byId("current").textContent = `Now: ${info.provider}${info.voice ? ` · ${info.voice}` : ""} (${info.language})`;
  // Rebuilt only when something changed, so a voice being auditioned isn't wiped by the refresh.
  const shown = JSON.stringify(info.providers);
  if (shown !== lastShown) {
    lastShown = shown;
    body.replaceChildren();
    for (const p of info.providers) {
      if (p.id === "browser") continue;
      if (!p.available) addUnavailable(p.id, p.problem ?? "not available", p.starting === true);
      for (const v of p.voices) addRow({ provider: p.id, voice: v.id, label: v.label, available: true });
    }
  }
  if (info.providers.some((/** @type {{ starting?: boolean }} */ p) => p.starting)) {
    setTimeout(() => void loadServerVoices(), STARTING_POLL_MS);
  }
};

const load = async () => {
  const headCells = ["Voice", ...AUDITION_SENTENCES.map((s) => s.label), "Your sentence", "All (median)", ""];
  head.replaceChildren(...headCells.map((t) => Object.assign(document.createElement("th"), { textContent: t })));
  status.textContent = "Loading voices…";
  await loadServerVoices();
  const addBrowser = () => {
    for (const v of browserEnglishVoices(speechSynthesis.getVoices(), voicesFor)) {
      addRow({ provider: "browser", voice: v.name, label: `${v.name} (${v.lang})`, available: true }, browserBody);
    }
  };
  if (speechSynthesis.getVoices().length > 0) addBrowser();
  else speechSynthesis.addEventListener("voiceschanged", addBrowser, { once: true });
  status.textContent = "";
};

void load();
