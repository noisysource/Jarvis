// `npm run jarvis` (#122): one command that starts everything on the Mac.
// The pure parts live here (arguments, what to start, prefixed output); the
// processes are wired in scripts/jarvis.ts.

export type LaunchArgs = { readonly voice: boolean; readonly open: boolean };

export const LAUNCH_USAGE = "npm run jarvis [-- --no-voice] [--no-open]";

export const parseLaunchArgs = (argv: readonly string[]): { ok: true; value: LaunchArgs } | { ok: false; error: string } => {
  let voice = true;
  let open = true;
  for (const a of argv) {
    if (a === "--no-voice") voice = false;
    else if (a === "--no-open") open = false;
    else return { ok: false, error: `Unknown option ${a}. Usage: ${LAUNCH_USAGE}` };
  }
  return { ok: true, value: { voice, open } };
};

/** What's already answering, and what's installed, when the launcher starts. */
export type LaunchState = {
  readonly jarvisUp: boolean;
  readonly voiceUp: boolean;
  readonly voiceInstalled: boolean;
  readonly ollamaUp: boolean;
};

export type LaunchPlan = {
  /** Jarvis already answers: just open the page. */
  readonly alreadyRunning: boolean;
  readonly startVoice: boolean;
  /** Lines to print before starting, one per service. */
  readonly notes: readonly string[];
};

export const planLaunch = (args: LaunchArgs, s: LaunchState): LaunchPlan => {
  if (s.jarvisUp) return { alreadyRunning: true, startVoice: false, notes: ["Jarvis is already running."] };
  const voice = !args.voice
    ? "Voice: off (--no-voice); the page speaks with the browser's voice."
    : s.voiceUp
      ? "Voice: already running."
      : s.voiceInstalled
        ? "Voice: starting Kokoro, Piper and Whisper (the first start takes a minute or two)."
        : "Voice: not set up (npm run voice:setup); starting without it.";
  const ollama = s.ollamaUp ? "Ollama: up (the Local brain works)." : "Ollama: not answering, so the Local brain won't work. Open the Ollama app, or run: ollama serve";
  return { alreadyRunning: false, startVoice: args.voice && !s.voiceUp && s.voiceInstalled, notes: [voice, ollama] };
};

/**
 * Splits a child's output into whole lines, each with a prefix. Keeps a
 * partial last line until the rest arrives; `flush` gives it at the end.
 */
export const makeLinePrefixer = (prefix: string): { readonly push: (chunk: string) => readonly string[]; readonly flush: () => readonly string[] } => {
  let rest = "";
  return {
    push: (chunk) => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop() ?? "";
      return parts.map((line) => `${prefix} ${line}`);
    },
    flush: () => {
      const last = rest;
      rest = "";
      return last === "" ? [] : [`${prefix} ${last}`];
    },
  };
};

/** The page's address: the server listens on 127.0.0.1 locally, so 0.0.0.0 still opens as 127.0.0.1. */
export const pageUrl = (host: string, port: number): string => `http://${host === "0.0.0.0" || host === "" ? "127.0.0.1" : host}:${port}/`;
