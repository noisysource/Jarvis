// Google sign-in for the calendar (#100), on this Mac only. `npm run
// calendar:connect` does the installed-app OAuth flow once (PKCE, a
// loopback redirect to 127.0.0.1) and keeps the refresh token in a
// gitignored file that only you can read. The server turns it into
// short-lived access tokens as needed.
//
// Tokens and the client secret are never logged, put in errors, or sent
// anywhere but Google's token endpoint. In production the calendar is off
// (secrets there come only from Secret Manager).

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { err, ok, type Result } from "../result.js";
import type { CalendarError } from "./read.js";

/** Read events only, for now. Creating events (#100's next step) asks again for more. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type OAuthClient = { readonly clientId: string; readonly clientSecret: string };
export type StoredTokens = { readonly refreshToken: string; readonly scope: string };

export type TokenFiles = {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
};

export const nodeTokenFiles: TokenFiles = {
  readFile: (path) => fs.readFile(path, "utf8"),
  // Only you can read it.
  writeFile: async (path, text) => {
    await fs.writeFile(path, text, { mode: 0o600 });
    await fs.chmod(path, 0o600);
  },
};

/** The client file Google Cloud gives you for a "Desktop app" OAuth client. */
export const parseClientFile = (text: string): Result<OAuthClient, string> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err("isn't JSON");
  }
  const section = (json as Record<string, unknown> | null)?.installed ?? (json as Record<string, unknown> | null)?.web;
  const { client_id: clientId, client_secret: clientSecret } = (section ?? {}) as Record<string, unknown>;
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || clientId === "" || clientSecret === "") {
    return err('has no "installed" client_id and client_secret (download it for a "Desktop app" OAuth client)');
  }
  return ok({ clientId, clientSecret });
};

export const parseTokensFile = (text: string): Result<StoredTokens, string> => {
  try {
    const { refreshToken, scope } = JSON.parse(text) as Record<string, unknown>;
    if (typeof refreshToken === "string" && refreshToken !== "" && typeof scope === "string") return ok({ refreshToken, scope });
  } catch {
    /* falls through */
  }
  return err("isn't a Jarvis tokens file");
};

/** PKCE: a random verifier and its S256 challenge. */
export const makePkce = (random: (n: number) => Buffer = randomBytes) => {
  const verifier = random(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Where to send you to sign in and allow calendar access. */
export const authorizationUrl = (p: { clientId: string; redirectUri: string; challenge: string; state: string; scope?: string }): string => {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scope ?? CALENDAR_SCOPE,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
};

type TokenResponse = { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown };

const postToken = async (doFetch: typeof fetch, body: Record<string, string>): Promise<Result<TokenResponse, CalendarError>> => {
  let res: Response;
  try {
    res = await doFetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  } catch {
    return err({ code: "network", message: "Couldn't reach Google's sign-in service" });
  }
  // The body may hold tokens: read it, but only ever report the status and Google's error code.
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: unknown };
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error.replace(/[^a-z_]/gi, "").slice(0, 40) : "unknown";
    return err({ code: "auth", message: `Google refused the sign-in (${res.status} ${code})` });
  }
  return ok(json);
};

/** After you allow access: the code for a refresh token. */
export const exchangeCode = async (p: {
  client: OAuthClient;
  code: string;
  verifier: string;
  redirectUri: string;
  fetch?: typeof fetch;
}): Promise<Result<StoredTokens, CalendarError>> => {
  const res = await postToken(p.fetch ?? fetch, {
    code: p.code,
    client_id: p.client.clientId,
    client_secret: p.client.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: "authorization_code",
    code_verifier: p.verifier,
  });
  if (!res.ok) return res;
  const { refresh_token: refreshToken, scope } = res.value;
  if (typeof refreshToken !== "string" || refreshToken === "") return err({ code: "auth", message: "Google didn't give a refresh token" });
  return ok({ refreshToken, scope: typeof scope === "string" ? scope : CALENDAR_SCOPE });
};

/**
 * Access tokens for the calendar, refreshed shortly before they expire.
 * The files are read on first use, so the server starts without them; until
 * you connect, every call says how.
 */
export const makeAccessTokens = (deps: {
  readonly clientPath: string;
  readonly tokensPath: string;
  readonly files?: TokenFiles;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): (() => Promise<Result<string, CalendarError>>) => {
  const files = deps.files ?? nodeTokenFiles;
  const now = deps.now ?? Date.now;
  let current: { token: string; expiresAt: number } | undefined;
  const notConnected: CalendarError = { code: "not_connected", message: "The calendar isn't connected: run npm run calendar:connect" };

  return async () => {
    if (current && current.expiresAt - 60_000 > now()) return ok(current.token);
    const clientText = await files.readFile(deps.clientPath).catch(() => undefined);
    const tokensText = await files.readFile(deps.tokensPath).catch(() => undefined);
    if (clientText === undefined || tokensText === undefined) return err(notConnected);
    const client = parseClientFile(clientText);
    const tokens = parseTokensFile(tokensText);
    if (!client.ok || !tokens.ok) return err({ code: "not_connected", message: `The calendar files aren't valid: run npm run calendar:connect again` });
    const res = await postToken(deps.fetch ?? fetch, {
      client_id: client.value.clientId,
      client_secret: client.value.clientSecret,
      refresh_token: tokens.value.refreshToken,
      grant_type: "refresh_token",
    });
    if (!res.ok) return res;
    const { access_token: token, expires_in: expiresIn } = res.value;
    if (typeof token !== "string" || token === "") return err({ code: "auth", message: "Google didn't give an access token" });
    current = { token, expiresAt: now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000 };
    return ok(token);
  };
};
