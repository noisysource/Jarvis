// HTTP for the model APIs (#76).
//
// Keep-alive: Node's built-in fetch closes an idle connection after about 4
// s, so a classifier call after a pause paid a fresh TCP + TLS handshake. This
// keeps connections to the API open for 30 s of quiet.
//
// Attempt log: the Anthropic SDK reports each HTTP attempt at "info" level
// ("POST … succeeded with status 200 in 812ms", "… failed with status 529 …
// - retrying"). Only the numbers are taken from those lines and logged, so a
// slow call shows whether it was a retry. The SDK's own text is never passed on.

import { Agent, fetch as undiciFetch } from "undici";
import type { Logger } from "../types.js";

const agent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000 });

export const keepAliveFetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;

type SdkLogFn = (message: string, ...rest: unknown[]) => void;
export type SdkLogger = { readonly error: SdkLogFn; readonly warn: SdkLogFn; readonly info: SdkLogFn; readonly debug: SdkLogFn };

/** One HTTP attempt, from an SDK log line: numbers only, or null if the line isn't one. */
export const parseAttempt = (message: string): { status?: number; ms?: number; retrying: boolean } | null => {
  const done = /(?:succeeded|failed) with status (\d{3}) in (\d+)ms/.exec(message);
  const retrying = /retrying, \d+ attempts? remaining/.test(message);
  if (!done && !retrying) return null;
  return { ...(done ? { status: Number(done[1]), ms: Number(done[2]) } : {}), retrying };
};

export const makeSdkLogger = (log: Logger, model: string): SdkLogger => {
  const attempt = (message: string): void => {
    const a = typeof message === "string" ? parseAttempt(message) : null;
    if (a) (a.retrying ? log.warn : log.info)("anthropic http", { model, ...a });
  };
  return {
    error: () => log.error("anthropic sdk error", { model }),
    warn: () => log.warn("anthropic sdk warning", { model }),
    info: attempt,
    debug: () => {},
  };
};
