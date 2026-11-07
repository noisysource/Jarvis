// Work that runs after the reply has gone out (#56), like the memory
// wrap-up, so it never slows an answer. Tasks start on the next turn of the
// event loop, after the handler has returned its response. A failing task is
// logged by name and error class only, never its content, and never
// affects the reply. `drain` waits for whatever is still running, so a
// graceful shutdown doesn't cut a wrap-up off halfway.
//
// On Cloud Run, CPU is throttled between requests unless the service uses
// instance-based billing ("CPU always allocated"); the deploy guide (#18)
// must set that, or background work may stall until the next request.

import type { AfterReply, Logger } from "./types.js";

export type { AfterReply };

export type BackgroundTasks = {
  readonly run: AfterReply;
  /** Resolves once every task started so far has finished (or failed). */
  readonly drain: () => Promise<void>;
  readonly pending: () => number;
};

export const makeBackgroundTasks = (deps: {
  readonly log: Logger;
  /** Defaults to setImmediate: after the current handler has returned. */
  readonly defer?: (start: () => void) => void;
}): BackgroundTasks => {
  const defer = deps.defer ?? ((start) => void setImmediate(start));
  const running = new Set<Promise<void>>();

  return {
    run: (name, task) => {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      running.add(done);
      defer(() => {
        task()
          .catch((e: unknown) => {
            deps.log.warn("background task failed", { task: name, errorName: e instanceof Error ? e.name : typeof e });
          })
          .finally(() => {
            running.delete(done);
            finish();
          });
      });
    },
    drain: async () => {
      while (running.size > 0) await Promise.all([...running]);
    },
    pending: () => running.size,
  };
};
