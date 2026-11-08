// Streaming helpers shared by every provider and caller.

import type { LlmCall, LlmRequest, LlmStreamed } from "./types.js";

/**
 * Streams if the provider can, otherwise makes one call and yields its text
 * as a single chunk, so callers never need to care which they got.
 */
export const streamOrCall = (llm: LlmCall, request: LlmRequest, signal?: AbortSignal): LlmStreamed => {
  if (llm.stream) return llm.stream(request, signal);
  const result = signal?.aborted
    ? Promise.resolve({ ok: false as const, error: { kind: "aborted" as const, message: "Cancelled", retryable: false } })
    : llm(request);
  return {
    result,
    text: (async function* () {
      const r = await result;
      if (r.ok && r.value.kind !== "json" && r.value.text !== "") yield r.value.text;
    })(),
  };
};

/** A ready-made streamed result, for tests and stubs. */
export const streamedFrom = (chunks: readonly string[], result: Awaited<LlmStreamed["result"]>): LlmStreamed => ({
  result: Promise.resolve(result),
  text: (async function* () {
    for (const c of chunks) yield c;
  })(),
});
