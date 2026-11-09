// @ts-check
// Pure helpers for the /voices audition page (#73).

import { speakableNumbers } from "./spoken-numbers.js";

/** The five sentences every voice reads, so they can be compared like for like. */
export const AUDITION_SENTENCES = [
  { id: "greeting", label: "Greeting", text: "Hello! Good to hear from you. What can I do for you today?" },
  { id: "fact", label: "Short answer", text: "Your passport expires on the 10th of January, 2030." },
  { id: "unavailable", label: "Not connected yet", text: "KidClub isn't connected yet, so I can't answer that one." },
  {
    id: "explanation",
    label: "Longer explanation",
    text:
      "I keep what you tell me in a small memory on your Mac. You can see all of it in the Memories panel, and delete anything you like. Nothing leaves your machine except the questions I send to Claude.",
  },
  { id: "question", label: "Question back", text: "Would you like me to remind you about that tomorrow morning?" },
];

/** What /speak accepts at most (MAX_SPEAK_CHARS on the server). */
export const OWN_SENTENCE_MAX = 1000;

/** A starting point for your own sentence (#94): pauses, a dash, CAPITALS and a decimal. */
export const OWN_SENTENCE_EXAMPLE = "Well... I'm not sure — it's REALLY big. About 3.5 km, maybe more.";

/**
 * Your own sentence (#94), ready to play: trimmed and cut to what /speak
 * takes. With `asJarvis`, numbers are in words, the way the chat page
 * sends them to the voice; without it, exactly what you typed.
 * @param {string} raw @param {{ asJarvis: boolean }} options @returns {string}
 */
export const ownSentence = (raw, { asJarvis }) => {
  const text = raw.trim().slice(0, OWN_SENTENCE_MAX);
  return asJarvis ? speakableNumbers(text, "en") : text;
};

/** The .env lines that select a voice. @param {string} provider @param {string} voice */
export const envLines = (provider, voice) => [`TTS_PROVIDER=${provider}`, `TTS_VOICE=${voice}`].join("\n");

/** Median of the numbers given, or null. @param {readonly number[]} values */
export const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** "312 ms", or "—" when there's nothing yet. @param {number | null | undefined} ms */
export const formatMs = (ms) => (ms === null || ms === undefined ? "—" : `${Math.round(ms)} ms`);

/**
 * English system voices for the browser row, best first by the chat page's
 * own ranking (passed in).
 * @template {{ name: string, lang: string }} V
 * @param {readonly V[]} voices @param {(voices: readonly V[], lang: string) => V[]} rank
 */
export const browserEnglishVoices = (voices, rank) => {
  const seen = new Set();
  return [...rank(voices, "en-GB"), ...rank(voices, "en-US")].filter((v) => !seen.has(v.name) && seen.add(v.name));
};
