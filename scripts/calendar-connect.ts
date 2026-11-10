// Connects your Google Calendar to Jarvis (#100), once, on this Mac.
//
//   npm run calendar:connect
//
// 1. In Google Cloud, create an OAuth client of type "Desktop app" with the
//    Google Calendar API enabled, download its JSON, and save it as
//    data/google-oauth-client.json (gitignored).
// 2. Run this. It opens Google's sign-in in your browser and listens on
//    127.0.0.1 for the answer. Allow read access to your calendar's events.
// 3. The refresh token is saved to data/google-tokens.json (gitignored,
//    readable only by you). Then set CALENDAR=on and restart Jarvis.
//
// Nothing here prints a token, the client secret, or an event's title.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeGoogleCalendarReader } from "../src/calendar/google.js";
import { authorizationUrl, exchangeCode, makeAccessTokens, makePkce, nodeTokenFiles, parseClientFile } from "../src/calendar/oauth.js";
import { localDate } from "../src/calendar/read.js";
import { loadConfig } from "../src/config.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const configResult = loadConfig({ ...process.env, CALENDAR: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("The calendar is local only: run this on your Mac, not in production.");
const { clientPath, tokensPath } = config.calendar;

const clientText = await nodeTokenFiles.readFile(clientPath).catch(() =>
  fail(`No OAuth client at ${clientPath}. In Google Cloud: enable the Google Calendar API, create an OAuth client ID of type "Desktop app", download its JSON and save it there.`),
);
const client = parseClientFile(clientText);
if (!client.ok) fail(`${clientPath} ${client.error}`);
const oauthClient = client.ok ? client.value : fail("");

const { verifier, challenge } = makePkce();
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const url = authorizationUrl({ clientId: oauthClient.clientId, redirectUri, challenge, state });

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
await nodeTokenFiles.writeFile(tokensPath, JSON.stringify(tokens.ok ? tokens.value : {}, null, 2));
console.log(`✓ Saved the calendar's refresh token to ${tokensPath} (only you can read it; gitignored).`);

// A quick read of today, counting only: no titles.
const read = makeGoogleCalendarReader({
  accessToken: makeAccessTokens({ clientPath, tokensPath }),
  timeZone: config.timeZone,
  isEc: () => false,
});
const today = localDate(new Date(), config.timeZone);
const events = await read({ from: today, to: today });
console.log(events.ok ? `✓ Read today's calendar: ${events.value.length} event(s).` : `✗ Reading it failed: ${events.error.message}`);
console.log("\nNow put CALENDAR=on in .env (with BARE_MODE=on) and restart Jarvis.");
