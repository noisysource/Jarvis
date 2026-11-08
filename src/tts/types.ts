// Provider-neutral text-to-speech types (#73), the same pattern as the LLM
// interface: everything outside src/tts/ talks to voices only through
// `TtsProvider`, so adding one (a cloud provider later, say) means one
// module and one registry entry.
//
// Every provider returns the same audio: 16-bit little-endian mono PCM at
// the provider's sample rate, streamed, so the page needs one player.

import type { Result } from "../result.js";
import type { Language } from "../types.js";

export type TtsProviderId = "kokoro" | "piper" | "browser";

export type TtsVoice = {
  readonly id: string;
  /** For people: "bm_george (British, male)". */
  readonly label: string;
};

export type TtsAudio = {
  readonly format: "pcm_s16le";
  readonly sampleRate: number;
  readonly channels: 1;
  readonly chunks: AsyncIterable<Uint8Array>;
};

export type TtsErrorKind = "unavailable" | "bad_voice" | "failed" | "aborted";

/** `message` is for logs and the /voices page: never the text being spoken. */
export type TtsError = { readonly kind: TtsErrorKind; readonly message: string };

export type SpeakInput = {
  readonly text: string;
  readonly language: Language;
  readonly voice: string;
};

export type TtsProvider = {
  readonly id: TtsProviderId;
  /** Server-side audio. The browser provider has none: the page speaks itself. */
  readonly speak: (input: SpeakInput, signal?: AbortSignal) => Promise<Result<TtsAudio, TtsError>>;
  readonly listVoices: (language: Language) => Promise<Result<readonly TtsVoice[], TtsError>>;
};
