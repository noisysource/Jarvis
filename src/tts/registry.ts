// The configured voices (#73). The browser provider has no server-side
// audio: the page speaks with the system voice itself.

import { err, ok } from "../result.js";
import { makeKokoroTts } from "./kokoro.js";
import { makePiperTts } from "./piper.js";
import type { TtsProvider, TtsProviderId } from "./types.js";

export const browserTts: TtsProvider = {
  id: "browser",
  speak: async () => err({ kind: "bad_voice", message: "The browser voice plays in the page, not on the server" }),
  listVoices: async () => ok([]),
};

export type TtsProviders = Readonly<Record<TtsProviderId, TtsProvider>>;

export const makeTtsProviders = (deps: { readonly kokoroUrl: URL; readonly piperUrl: URL; readonly fetch?: typeof fetch }): TtsProviders => ({
  kokoro: makeKokoroTts({ baseUrl: deps.kokoroUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
  piper: makePiperTts({ baseUrl: deps.piperUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
  browser: browserTts,
});
