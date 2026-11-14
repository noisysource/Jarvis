// Connects one GitHub owner's repos to Jarvis (#125), read-only, on this Mac.
//
//   npm run github:connect -- noisysource
//   npm run github:connect -- <your-username>
//   npm run github:connect -- noisysource --write     (#162, for fixes as pull requests)
//
// --write keeps a second, separate token for fixes: Repository permissions
// Contents and Pull requests: Read and write (nothing else, and not
// Workflows). It's only used after your OK, to push a jarvis/fix-… branch and
// open a draft pull request. It goes to data/github-write-tokens.json.
//
// 1. On GitHub: Settings → Developer settings → Fine-grained tokens → Generate.
//    Resource owner: that account or organisation. Repository access: All.
//    Permissions → Repository, all Read-only: Contents, Issues, Pull requests,
//    Actions, Commit statuses (Metadata is added automatically).
// 2. Run this and paste the token when asked. It isn't shown as you paste.
// 3. It checks the token with one read and saves it to data/github-tokens.json
//    (gitignored, readable only by you). Then set GITHUB=on in .env and
//    restart Jarvis. Run it again with another owner to add their repos.
//
// Nothing here prints the token.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { nodeTokenFiles } from "../src/calendar/oauth.js";
import { loadConfig } from "../src/config.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const owner = process.argv[2] ?? "";
const write = process.argv.slice(3).includes("--write");
if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) fail("Say whose repos: npm run github:connect -- <owner> (your username or an organisation)");

// The features that need GitHub are off here too, or their checks would refuse
// (CODE_AGENT=on needs GITHUB=on): this script only needs the file paths.
const configResult = loadConfig({ ...process.env, GITHUB: "off", CODE_AGENT: "off", CODE_FIX: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("GitHub is local only: run this on your Mac, not in production.");
const path = write ? config.codeAgent.fix.writeTokensPath : config.github.tokensPath;

// Ask for the token without echoing it.
let muted = false;
const output = new Writable({
  write: (chunk: Buffer, _enc, done) => {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const token = await new Promise<string>((resolve) => {
  rl.question(`Paste the ${write ? "write (Contents + Pull requests)" : "read-only"} token for "${owner}" (it won't show): `, (answer) => {
    rl.close();
    process.stdout.write("\n");
    resolve(answer.trim());
  });
  muted = true;
});
if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) fail("That doesn't look like a GitHub token (they start with github_pat_). Nothing was saved.");

// One read to check it: which repos it can see.
const res = await fetch("https://api.github.com/user/repos?per_page=100", {
  headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "jarvis" },
}).catch(() => undefined);
if (!res) fail("Couldn't reach GitHub. Nothing was saved.");
if (res && res.status === 401) fail("GitHub refused the token (wrong, expired or revoked). Nothing was saved.");
if (res && !res.ok) fail(`GitHub answered ${res.status}. Nothing was saved.`);
const repos = res ? ((await res.json().catch(() => [])) as { owner?: { login?: unknown }; private?: unknown }[]) : [];
const own = repos.filter((r) => typeof r.owner?.login === "string" && r.owner.login.toLowerCase() === owner.toLowerCase());

// Keep the other owners' tokens; replace this owner's.
const existing = await nodeTokenFiles.readFile(path).catch(() => "[]");
let list: { owner: string; token: string }[] = [];
try {
  const parsed: unknown = JSON.parse(existing);
  if (Array.isArray(parsed))
    list = parsed.filter((x): x is { owner: string; token: string } => typeof x === "object" && x !== null && typeof (x as { owner?: unknown }).owner === "string" && typeof (x as { token?: unknown }).token === "string");
} catch {
  list = [];
}
list = [...list.filter((t) => t.owner.toLowerCase() !== owner.toLowerCase()), { owner, token }];
await nodeTokenFiles.writeFile(path, JSON.stringify(list, null, 2));

console.log(`✓ Saved the ${owner} token to ${path} (only you can read it; gitignored).`);
console.log(own.length > 0 ? `✓ It can see ${own.length} ${owner} repo(s) (${own.filter((r) => r.private === true).length} private).` : `! It can't see any ${owner} repos yet: check the token's resource owner and repository access.`);
console.log(`  Owners connected: ${list.map((t) => t.owner).join(", ")}.`);
console.log(write ? "\nNow put CODE_FIX=on in .env (with GITHUB=on and CODE_AGENT=on) and restart Jarvis." : "\nNow put GITHUB=on in .env (with BARE_MODE=on) and restart Jarvis.");
