// Audio plumbing shared by the providers. Pure apart from reading streams.

export type WavFormat = { readonly sampleRate: number; readonly channels: number; readonly bitsPerSample: number; readonly dataOffset: number };

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

/**
 * Reads a WAV header: "more" if the bytes so far don't reach the data chunk
 * yet, an error message if it isn't a WAV we can play.
 */
export const parseWavHeader = (b: Uint8Array): WavFormat | "more" | { readonly error: string } => {
  if (b.length < 12) return "more";
  if (ascii(b, 0) !== "RIFF" || ascii(b, 8) !== "WAVE") return { error: "not a WAV file" };
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let fmt: Omit<WavFormat, "dataOffset"> | undefined;
  while (at + 8 <= b.length) {
    const id = ascii(b, at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      if (at + 8 + 16 > b.length) return "more";
      const audioFormat = view.getUint16(at + 8, true);
      if (audioFormat !== 1) return { error: "not PCM audio" };
      fmt = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true), bitsPerSample: view.getUint16(at + 22, true) };
    }
    if (id === "data") {
      if (!fmt) return { error: "data before format" };
      return { ...fmt, dataOffset: at + 8 };
    }
    at += 8 + size + (size % 2);
  }
  return "more";
};

/** Re-chunks a byte stream so every chunk holds whole 16-bit samples. */
export async function* alignPcm16(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let carry: Uint8Array | undefined;
  for await (const chunk of chunks) {
    const bytes = carry ? concat(carry, chunk) : chunk;
    const even = bytes.length - (bytes.length % 2);
    carry = even < bytes.length ? bytes.slice(even) : undefined;
    if (even > 0) yield bytes.subarray(0, even);
  }
}

export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** A fetch response body as chunks. */
export async function* bodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
