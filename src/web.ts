// The chat page's static files (src/web), read once at startup and served
// as-is: no build step.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "./result.js";

export type WebAsset = {
  readonly body: string | Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  /** Overrides the default no-store (the large, versioned voice-detection files). */
  readonly cacheControl?: string;
};
export type WebAssets = Readonly<Record<string, WebAsset>>;

export const WEB_DIR = "src/web";

const FILES: readonly { path: string; file: string; contentType: string }[] = [
  { path: "/", file: "index.html", contentType: "text/html; charset=utf-8" },
  { path: "/app.js", file: "app.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/chat.js", file: "chat.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/brain.js", file: "brain.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/brain-lib.js", file: "brain-lib.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/app.css", file: "app.css", contentType: "text/css; charset=utf-8" },
  { path: "/audio.js", file: "audio.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/pcm-lib.js", file: "pcm-lib.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/mic.js", file: "mic.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/mic-lib.js", file: "mic-lib.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/mic-worklet.js", file: "mic-worklet.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/speaker.js", file: "speaker.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/spoken-numbers.js", file: "spoken-numbers.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/turn-lib.js", file: "turn-lib.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/silero.js", file: "silero.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/vad.js", file: "vad.js", contentType: "text/javascript; charset=utf-8" },
];

/**
 * Voice detection (#75), served by this server rather than a CDN: the ONNX
 * runtime's WebAssembly build and the Silero v5 model, from the pinned npm
 * packages. Binary, and cached for an hour (they're 14 MB).
 */
export const VENDOR_FILES: readonly { path: string; file: string; contentType: string }[] = [
  { path: "/vendor/ort/ort.wasm.min.mjs", file: "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", contentType: "text/javascript; charset=utf-8" },
  {
    path: "/vendor/ort/ort-wasm-simd-threaded.mjs",
    file: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
  { path: "/vendor/ort/ort-wasm-simd-threaded.wasm", file: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", contentType: "application/wasm" },
  { path: "/vendor/silero_vad_v5.onnx", file: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", contentType: "application/octet-stream" },
];

/** Dev-only pages (#73): never served in production. */
const DEV_FILES: readonly { path: string; file: string; contentType: string }[] = [
  { path: "/voices", file: "voices.html", contentType: "text/html; charset=utf-8" },
  { path: "/voices.js", file: "voices.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/voices-lib.js", file: "voices-lib.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/voices.css", file: "voices.css", contentType: "text/css; charset=utf-8" },
];

/**
 * Same-origin only. No inline scripts, no external anything; the page talks
 * only to this server. 'wasm-unsafe-eval' lets the page compile the voice
 * detector's WebAssembly (#75); it doesn't allow eval() of JavaScript. The microphone is allowed for this page only.
 */
export const WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Cache-Control": "no-store",
};

export const loadWebAssets = async (
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  dir: string = WEB_DIR,
  options: { readonly dev?: boolean } = {},
): Promise<Result<WebAssets, string>> => {
  const entries: [string, WebAsset][] = [];
  for (const f of [...FILES, ...(options.dev ? DEV_FILES : [])]) {
    const path = join(dir, f.file);
    try {
      entries.push([f.path, { body: await read(path), contentType: f.contentType }]);
    } catch {
      return err(`Couldn't read the chat page file ${path}`);
    }
  }
  return ok(Object.fromEntries(entries));
};

/** Reads the voice-detection files (#75) from node_modules. */
export const loadVendorAssets = async (
  read: (path: string) => Promise<Uint8Array> = (p) => readFile(p),
): Promise<Result<WebAssets, string>> => {
  const entries: [string, WebAsset][] = [];
  for (const f of VENDOR_FILES) {
    try {
      const bytes = await read(f.file);
      entries.push([f.path, { body: new Uint8Array(bytes), contentType: f.contentType, cacheControl: "private, max-age=3600" }]);
    } catch {
      return err(`Couldn't read ${f.file} (run npm install)`);
    }
  }
  return ok(Object.fromEntries(entries));
};
