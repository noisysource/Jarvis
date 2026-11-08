// The chat page's static files (src/web), read once at startup and served
// as-is: no build step.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "./result.js";

export type WebAsset = { readonly body: string; readonly contentType: string };
export type WebAssets = Readonly<Record<string, WebAsset>>;

export const WEB_DIR = "src/web";

const FILES: readonly { path: string; file: string; contentType: string }[] = [
  { path: "/", file: "index.html", contentType: "text/html; charset=utf-8" },
  { path: "/app.js", file: "app.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/chat.js", file: "chat.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/app.css", file: "app.css", contentType: "text/css; charset=utf-8" },
  { path: "/audio.js", file: "audio.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/pcm-lib.js", file: "pcm-lib.js", contentType: "text/javascript; charset=utf-8" },
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
 * only to this server. The microphone is allowed for this page only.
 */
export const WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
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
