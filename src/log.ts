// Structured logging: one JSON object per line, with a Cloud Logging
// `severity`. Callers pass metadata only. Questions, answers, profile text
// and keys never go into log fields.

import type { LogFields, Logger } from "./types.js";

type Severity = "INFO" | "WARNING" | "ERROR";

export const makeJsonLogger = (deps: {
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  readonly fields?: LogFields;
} = {}): Logger => {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const entry =
    (severity: Severity) =>
    (message: string, fields?: LogFields): void =>
      write(JSON.stringify({ severity, time: now().toISOString(), message, ...deps.fields, ...fields }));
  return { info: entry("INFO"), warn: entry("WARNING"), error: entry("ERROR") };
};

/** A logger that adds `fields` (e.g. a request id) to every entry. */
export const withLogFields = (log: Logger, fields: LogFields): Logger => ({
  info: (message, extra) => log.info(message, { ...fields, ...extra }),
  warn: (message, extra) => log.warn(message, { ...fields, ...extra }),
  error: (message, extra) => log.error(message, { ...fields, ...extra }),
});
