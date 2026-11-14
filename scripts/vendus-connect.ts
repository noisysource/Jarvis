// Connects KidClub's Vendus to Jarvis (#8), read-only, on this Mac.
//
//   npm run vendus:connect
//
// 1. In Vendus (Configurações → Utilizadores) create a user for Jarvis with
//    the fewest rights Vendus allows: it only needs to see documents.
// 2. Sign in as that user, go to APPS → API, and copy its API key. The key
//    can do only what that user may (https://www.vendus.pt/ws/v1.1/authentication.doc).
// 3. Run this and paste it. It checks the key with one read (today's
//    documents) and keeps it in data/vendus.json (gitignored, only you can read it).
// 4. Set VENDUS=on in .env and restart Jarvis.
//
// Jarvis only ever GETs two paths with it (the list and one document).

import { createInterface } from "node:readline";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { makeVendusGet } from "../src/vendus/vendus.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const configResult = loadConfig({ ...process.env, VENDUS: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("Vendus is local only for now: run this on your Mac, not in production.");

let muted = false;
const output = new Writable({
  write: (chunk: Buffer, _enc, done) => {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const key = await new Promise<string>((resolve) => {
  rl.question("Paste the Vendus API key of Jarvis's Vendus user (it won't show): ", (answer) => {
    rl.close();
    process.stdout.write("\n");
    resolve(answer.trim());
  });
  muted = true;
});
if (!/^[A-Za-z0-9._-]{16,200}$/.test(key)) fail("That doesn't look like a Vendus API key. Nothing was saved.");

const today = new Date().toISOString().slice(0, 10);
const got = await makeVendusGet({ apiKey: async () => key })("/documents/", { since: today, until: today, per_page: "1", page: "1" });
if (!got.ok) fail(`${got.error.message}. Nothing was saved.`);

await mkdir(dirname(config.vendus.keyPath), { recursive: true, mode: 0o700 });
await writeFile(config.vendus.keyPath, JSON.stringify({ apiKey: key }), { mode: 0o600 });
await chmod(config.vendus.keyPath, 0o600);
console.log(`✓ Vendus is connected (read-only in Jarvis). Key saved to ${config.vendus.keyPath} (only you can read it; gitignored).`);
console.log("\nPut VENDUS=on in .env (with BARE_MODE=on) and restart Jarvis.");
