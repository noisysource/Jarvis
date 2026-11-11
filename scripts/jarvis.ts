// One command to start Jarvis on the Mac (#122):
//
//   npm run jarvis                 voice services, the server, then the page
//   npm run jarvis -- --no-voice   without Kokoro / Piper / Whisper
//   npm run jarvis -- --no-open    don't open the browser
//
// It starts the voice services (npm run voice:up) unless they're already
// running, checks Ollama, starts the server, waits for it, and opens the page.
// Output comes in one terminal, each line marked [voice] or [jarvis].
// Ctrl-C stops everything it started; if the server stops, voice stops too.
//
// Local only. It prints no settings or keys: the server reads .env itself.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { makeLinePrefixer, pageUrl, parseLaunchArgs, planLaunch } from "../src/launch.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const say = (line: string) => console.log(`[start] ${line}`);
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const args = parseLaunchArgs(process.argv.slice(2));
if (!args.ok) fail(args.error);
const { voice, open } = args.ok ? args.value : { voice: true, open: true };

const config = loadConfig(process.env);
if (!config.ok) fail(config.error);
const c = config.ok ? config.value : fail("");
if (c.env === "production") fail("npm run jarvis is for your Mac. In production the server starts on its own.");

const url = pageUrl(c.host, c.port);
const answers = async (target: string): Promise<boolean> => {
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
};

const [jarvisUp, voiceUp, ollamaUp] = await Promise.all([
  answers(new URL("/healthz", url).toString()),
  answers(new URL("/health", c.tts.kokoroUrl).toString()),
  answers(new URL("/api/tags", c.ollamaUrl).toString()),
]);
const plan = planLaunch({ voice, open }, { jarvisUp, voiceUp, ollamaUp, voiceInstalled: existsSync(path.join(root, ".voice/kokoro-fastapi/.venv")) });
for (const note of plan.notes) say(note);

const openPage = () => {
  if (!open) return say(`Jarvis is at ${url}`);
  say(`Opening ${url}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => undefined);
};

if (plan.alreadyRunning) {
  openPage();
  process.exit(0);
}

const children: ChildProcess[] = [];
let stopping = false;

const run = (name: string, command: string, argv: readonly string[]): ChildProcess => {
  const child = spawn(command, argv, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`;
  for (const [stream, out] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    const lines = makeLinePrefixer(tag);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      for (const l of lines.push(chunk)) out.write(`${l}\n`);
    });
    stream.on("end", () => {
      for (const l of lines.flush()) out.write(`${l}\n`);
    });
  }
  child.on("exit", (code, signal) => {
    if (!stopping) {
      say(`${name} stopped (${signal ?? `exit ${code ?? 0}`}); stopping the rest.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
  return child;
};

const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  const alive = children.filter((ch) => ch.exitCode === null && ch.signalCode === null);
  for (const ch of alive) ch.kill("SIGTERM");
  // Kokoro can take a moment to let go; don't hang on it.
  const force = setTimeout(() => {
    for (const ch of alive) if (ch.exitCode === null && ch.signalCode === null) ch.kill("SIGKILL");
    process.exit(code);
  }, 8000);
  force.unref();
  void Promise.all(alive.map((ch) => new Promise((resolve) => ch.once("exit", resolve)))).then(() => {
    say("Stopped.");
    process.exit(code);
  });
};

// Ctrl-C reaches the children too (same terminal); this just waits for them.
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

if (plan.startVoice) run("voice", "bash", [path.join(root, "scripts/voice-up.sh")]);
run("jarvis", process.execPath, ["--import", "tsx", path.join(root, "src/main.ts")]);

// Wait for the server (up to a minute), then open the page.
for (let i = 0; i < 60 && !stopping; i++) {
  if (await answers(new URL("/healthz", url).toString())) {
    say("Jarvis is up. Ctrl-C stops everything.");
    openPage();
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
