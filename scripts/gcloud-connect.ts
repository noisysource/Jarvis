// Connects one Google Cloud environment to Jarvis (#161), read-only, on this Mac.
//
//   npm run gcloud:connect -- dev kidclub-dev
//   npm run gcloud:connect -- dev kidclub-dev other-name@kidclub-dev.iam.gserviceaccount.com
//
// No key file: the organisation blocks service account keys. Instead:
// 1. In that project, a service account "jarvis-read" with one role only,
//    Logs Viewer. Your own Google account gets "Service Account Token
//    Creator" on that service account (not on the project).
// 2. The gcloud tool is installed and signed in on this Mac (gcloud auth login).
// 3. Run this with the environment's name (dev, staging, prod…) and the
//    project id. It checks with one read of the logs, then writes
//    data/gcloud/<env>.json: the project and the account's name, nothing secret.
// 4. Set GCLOUD=on in .env and restart Jarvis.

import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { defaultServiceAccount, GCLOUD_ENV, makeGcloudCliToken, makeGcloudReader, parseEnvFile } from "../src/gcloud/gcloud.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const env = (process.argv[2] ?? "").toLowerCase();
const project = process.argv[3] ?? "";
if (!GCLOUD_ENV.test(env) || project === "") fail("Say which environment and project: npm run gcloud:connect -- dev <project-id>");
const text = JSON.stringify({ project, serviceAccount: process.argv[4] ?? defaultServiceAccount(project) }, null, 2);
const parsed = parseEnvFile(text);
const target = parsed.ok ? parsed.value : fail(`${parsed.ok ? "" : parsed.error}. Nothing was saved.`);

const configResult = loadConfig({ ...process.env, GCLOUD: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("Google Cloud reading is local only: run this on your Mac, not in production.");

const run = (cmd: string, args: readonly string[]) =>
  new Promise<{ code: number; stdout: string; missing?: boolean }>((resolve) => {
    execFile(cmd, [...args], { timeout: 60_000 }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout, ...(error && (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : {}) }));
  });

// One read to check it: the newest log entry of the last hour.
const reader = makeGcloudReader({ envs: { envs: async () => [{ env, project: target.projectId }], get: async () => target }, token: makeGcloudCliToken(run) });
const got = await reader.entries({ env, hours: 1, severity: "DEFAULT" }, 1);
if (!got.ok) fail(`${got.error.message}. Nothing was saved.`);

const dir = config.gcloud.keysPath;
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, `${env}.json`);
await writeFile(file, text, { mode: 0o600 });
await chmod(file, 0o600);

console.log(`✓ ${env} is connected: project ${target.projectId}, read-only (logs), as ${target.serviceAccount}.`);
console.log(`✓ Saved to ${file} (names only; no key is stored).`);
console.log("\nPut GCLOUD=on in .env (with BARE_MODE=on) and restart Jarvis.");
