// Local services (TTS, STT) must be on this machine (#73, #74): Jarvis
// refuses to start if a service URL points anywhere else, so no audio or
// text can be sent off the machine by a config mistake.

import { err, ok, type Result } from "./result.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export const parseLocalUrl = (value: string): Result<URL, string> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(`"${value}" isn't a URL`);
  }
  if (url.protocol !== "http:") return err(`"${value}" must be http:// on this machine`);
  if (!LOOPBACK.has(url.hostname)) return err(`"${value}" must point at this machine (127.0.0.1 or localhost)`);
  if (url.username || url.password) return err(`"${value}" must not contain credentials`);
  return ok(url);
};
