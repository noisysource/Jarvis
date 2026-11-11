// Connects one Gmail account to Jarvis (Reach 3), read-only, once, on this Mac.
//
//   npm run gmail:connect -- personal
//   npm run gmail:connect -- noisysource
//
// 1. In Google Cloud, enable the Gmail API on the same project as the
//    calendar (the OAuth client in data/google-oauth-client.json is reused).
//    If the consent screen is "External", add each Gmail address as a test user.
// 2. Run this once per account. It opens Google's sign-in: pick the account
//    you're connecting, and allow reading email. It asks for read-only access
//    (gmail.readonly): Jarvis can't send, delete or label anything.
// 3. The refresh token is saved to data/google-gmail-<account>.json
//    (gitignored, readable only by you). Then set GMAIL=on and restart Jarvis.
//
// Nothing here prints a token, the client secret, or an email's content.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { authorizationUrl, exchangeCode, makeAccessTokens, makePkce, nodeTokenFiles, parseClientFile } from "../src/calendar/oauth.js";
import { loadConfig } from "../src/config.js";
import { GMAIL_ACCOUNTS, GMAIL_SCOPE, isGmailAccount } from "../src/gmail/gmail.js";
import { GMAIL_COMPOSE_SCOPE } from "../src/gmail/send.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const account = process.argv[2];
if (!isGmailAccount(account)) fail(`Say which account: npm run gmail:connect -- ${GMAIL_ACCOUNTS.join(" | ")}`);
const which = isGmailAccount(account) ? account : fail("");

// #120: GMAIL_WRITE=on also asks to write drafts and send them (sending always after your OK).
const write = process.env.GMAIL_WRITE === "on";
const configResult = loadConfig({ ...process.env, CALENDAR: "off", CALENDAR_WRITE: "off", GMAIL: "off", GMAIL_WRITE: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("Gmail is local only: run this on your Mac, not in production.");
const clientPath = config.calendar.clientPath;
const tokensPath = config.gmail.tokensPath(which);

const clientText = await nodeTokenFiles.readFile(clientPath).catch(() =>
  fail(`No OAuth client at ${clientPath}. Set up the calendar's Google Cloud client first (README), and enable the Gmail API on the same project.`),
);
const client = parseClientFile(clientText);
if (!client.ok) fail(`${clientPath} ${client.error}`);
const oauthClient = client.ok ? client.value : fail("");

const { verifier, challenge } = makePkce();
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const url = authorizationUrl({ clientId: oauthClient.clientId, redirectUri, challenge, state, scope: write ? `${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE}` : GMAIL_SCOPE });
console.log(
  write
    ? `Connecting the "${which}" Gmail to read email and write drafts (Jarvis sends only after your "Send it"). On Google's screen, pick that account and tick both boxes.\n`
    : `Connecting the "${which}" Gmail, read-only. On Google's screen, pick that account and allow reading email.\n`,
);
console.log("Opening Google's sign-in in your browser. If it doesn't open, visit:\n");
console.log(`  ${url}\n`);
if (process.platform === "darwin") execFile("open", [url], () => undefined);

const timeout = setTimeout(() => fail("No answer from the browser within 5 minutes. Run it again."), 5 * 60_000);

const code = await new Promise<string>((resolve) => {
  server.on("request", (req, res) => {
    const params = new URL(req.url ?? "/", redirectUri).searchParams;
    const page = (text: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Jarvis</title><p style="font:16px system-ui;margin:2rem">${text}</p>`);
    };
    if (params.get("state") !== state) return page("This isn't the sign-in Jarvis started. Close this tab.");
    const error = params.get("error");
    if (error) {
      page("Access wasn't allowed. You can close this tab.");
      fail(`Google said: ${error.replace(/[^a-z_]/gi, "")}`);
    }
    const got = params.get("code");
    if (!got) return page("No code in the answer. Close this tab and run it again.");
    page("Connected. You can close this tab and go back to the terminal.");
    resolve(got);
  });
});
clearTimeout(timeout);
server.close();

const tokens = await exchangeCode({ client: oauthClient, code, verifier, redirectUri });
if (!tokens.ok) fail(tokens.error.message);
if (tokens.ok && !tokens.value.scope.split(" ").includes(GMAIL_SCOPE))
  fail("Reading email was NOT allowed (the box was probably unticked on Google's screen). Run this again and tick it.");
if (write && tokens.ok && !tokens.value.scope.split(" ").includes(GMAIL_COMPOSE_SCOPE))
  fail("Writing drafts was NOT allowed (the box was probably unticked). Run this again and tick it.");
await nodeTokenFiles.writeFile(tokensPath, JSON.stringify(tokens.ok ? tokens.value : {}, null, 2));
console.log(`✓ Saved the ${which} Gmail's refresh token to ${tokensPath} (only you can read it; gitignored).`);

// A quick check: which address it is, and how many unread. No content.
const token = await makeAccessTokens({ clientPath, tokensPath, what: { name: `The ${which} Gmail`, connect: `npm run gmail:connect -- ${which}` } })();
if (!token.ok) fail(token.error.message);
const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${token.ok ? token.value : ""}` } })
  .then(async (r) => (r.ok ? ((await r.json()) as { emailAddress?: unknown }) : undefined))
  .catch(() => undefined);
console.log(typeof profile?.emailAddress === "string" ? `✓ Connected "${which}" to ${profile.emailAddress}.` : "✗ Couldn't read the account's address; check the Gmail API is enabled.");
console.log(write ? "✓ Drafts and sending allowed (always after your OK)." : "");
console.log("\nNow put GMAIL=on in .env (with BARE_MODE=on) and restart Jarvis: a running Jarvis keeps its old connections until it restarts.");
