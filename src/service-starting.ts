// "Kokoro is starting" rather than "isn't running" (#80).
//
// While `npm run voice:up` waits for a local voice service to answer, it
// keeps `.voice/run/<service>.starting` holding its own PID, and removes it
// once the service is up, gives up, or the script stops. A file whose PID is
// no longer running (voice:up was killed) is ignored.

import { readFile } from "node:fs/promises";
import path from "node:path";

export type LocalService = "kokoro" | "piper" | "whisper";

/** Is voice:up still waiting for this service to come up? */
export type IsStarting = (service: LocalService) => Promise<boolean>;

export const DEFAULT_RUN_DIR = ".voice/run";

/** Signal 0 only checks the process exists; EPERM means it exists but isn't ours. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const makeIsStarting =
  (deps: {
    readonly runDir: string;
    readonly readFile?: (file: string) => Promise<string>;
    readonly isAlive?: (pid: number) => boolean;
  }): IsStarting =>
  async (service) => {
    const read = deps.readFile ?? ((file: string) => readFile(file, "utf8"));
    const isAlive = deps.isAlive ?? isProcessAlive;
    try {
      const pid = Number((await read(path.join(deps.runDir, `${service}.starting`))).trim());
      return Number.isInteger(pid) && pid > 0 && isAlive(pid);
    } catch {
      return false;
    }
  };

export const notStarting: IsStarting = async () => false;
