// Provider-neutral speech-to-text types (#74), the same pattern as TTS:
// everything outside src/stt/ hears only through `SttProvider`.
//
// Audio is always a 16 kHz mono 16-bit WAV, held in memory only.

import type { Result } from "../result.js";
import type { Language } from "../types.js";

export type SttProviderId = "whisper";

export type SttInput = {
  /** A whole WAV file: 16 kHz, mono, 16-bit PCM. */
  readonly wav: Uint8Array;
  readonly language: Language;
};

/** "starting": the local service is down because voice:up is still waiting for it (#80). */
export type SttErrorKind = "unavailable" | "starting" | "failed" | "aborted";

/** `message` is for logs and the page: never what was said. */
export type SttError = { readonly kind: SttErrorKind; readonly message: string };

export type SttProvider = {
  readonly id: SttProviderId;
  /** "" when nothing was said. */
  readonly transcribe: (input: SttInput, signal?: AbortSignal) => Promise<Result<{ readonly text: string }, SttError>>;
  /** Is it up and ready (model loaded)? */
  readonly status: () => Promise<Result<true, SttError>>;
};
