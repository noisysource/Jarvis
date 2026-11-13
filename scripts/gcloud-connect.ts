// Connects one Google Cloud environment to Jarvis (#161), read-only, on this Mac.
//
//   npm run gcloud:connect -- dev ~/Downloads/my-project-dev-1234.json
//
// 1. In the Google Cloud console, in that environment's project:
//    IAM & Admin → Service accounts → Create. Name it "jarvis-read".
//    Give it one role only: Logging → Logs Viewer. No others.
// 2. Open the account → Keys → Add key → Create new key → JSON. A file downloads.
// 3. Run this with the environment's name (dev, staging, prod…) and that file.
//    It checks the key with one read of the logs, then keeps a copy in
//    data/gcloud/<env>.json (gitignored, readable only by you).
// 4. Delete the downloaded file. Set GCLOUD=on in .env and restart Jarvis.
//
// Jarvis only ever asks Google for a logging-read token with this key.
// Nothing here prints the key.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { GCLOUD_ENV, makeGcloudReader, parseKey } from "../src/gcloud/gcloud.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const env = (process.argv[2] ?? "").toLowerCase();
const file = (process.argv[3] ?? "").replace(/^~(?=\/)/, os.homedir());
if (!GCLOUD_ENV.test(env) || file === "") fail("Say which environment and key file: npm run gcloud:connect -- dev ~/Downloads/<key>.json");

const configResult = loadConfig({ ...process.env, GCLOUD: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("Google Cloud reading is local only: run this on your Mac, not in production.");

const text = await readFile(file, "utf8").catch(() => fail(`Couldn't read ${file}.`));
const key = parseKey(text);
if (!key.ok) fail(`${file}: ${key.error}. It should be the JSON key of a service account. Nothing was saved.`);
const parsed = key.ok ? key.value : fail("");

// One read to check it: the newest log entry of the last hour.
const reader = makeGcloudReader({ keys: { envs: async () => [{ env, project: parsed.projectId }], key: async () => parsed } });
const got = await reader.entries({ env, hours: 1, severity: "DEFAULT" }, 1);
if (!got.ok) fail(`${got.error.message}. Nothing was saved.`);

const dir = config.gcloud.keysPath;
await mkdir(dir, { recursive: true, mode: 0o700 });
const target = path.join(dir, `${env}.json`);
await writeFile(target, text, { mode: 0o600 });
await chmod(target, 0o600);

console.log(`✓ ${env} is connected: project ${parsed.projectId}, read-only (logs).`);
console.log(`✓ Key saved to ${target} (only you can read it; gitignored).`);
console.log(`  Now delete ${file}: Jarvis has his own copy.`);
console.log("\nPut GCLOUD=on in .env (with BARE_MODE=on) and restart Jarvis.");
