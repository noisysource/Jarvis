// The configured ears (#74). One provider for now: whisper.cpp on this machine.

import type { SttConfig } from "../config.js";
import { type IsStarting, notStarting } from "../service-starting.js";
import type { SttProvider } from "./types.js";
import { makeWhisperStt } from "./whisper.js";

export const makeSttProvider = (
  config: SttConfig,
  deps: { readonly fetch?: typeof fetch; readonly isStarting?: IsStarting; readonly hints?: () => Promise<{ readonly prompt: string }> } = {},
): SttProvider => {
  const isStarting = deps.isStarting ?? notStarting;
  return makeWhisperStt({
    baseUrl: config.whisperUrl,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.hints ? { hints: deps.hints } : {}),
    isStarting: () => isStarting("whisper"),
  });
};
