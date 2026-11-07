import { describe, expect, it, vi } from "vitest";
import { makeBackgroundTasks } from "../src/background.js";
import type { Logger } from "../src/types.js";

const recordingLog = () => {
  const warn = vi.fn<Logger["warn"]>();
  return { log: { info: vi.fn(), warn, error: vi.fn() } satisfies Logger, warn };
};

describe("makeBackgroundTasks", () => {
  it("starts work only after the caller has returned, and drain waits for it", async () => {
    const order: string[] = [];
    const tasks = makeBackgroundTasks({ log: recordingLog().log });
    tasks.run("wrap-up", async () => {
      order.push("task");
    });
    order.push("reply sent");
    expect(tasks.pending()).toBe(1);
    await tasks.drain();
    expect(order).toEqual(["reply sent", "task"]);
    expect(tasks.pending()).toBe(0);
  });

  it("logs a failing task by name and error class only, and keeps going", async () => {
    const { log, warn } = recordingLog();
    const tasks = makeBackgroundTasks({ log });
    const ran: string[] = [];
    tasks.run("memory wrap-up", async () => {
      throw new TypeError("could not save 'Inês swims on Tuesdays'");
    });
    tasks.run("other", async () => {
      ran.push("other");
    });
    await tasks.drain();
    expect(ran).toEqual(["other"]);
    expect(warn).toHaveBeenCalledWith("background task failed", { task: "memory wrap-up", errorName: "TypeError" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Inês");
  });

  it("drain also waits for tasks started while draining", async () => {
    const tasks = makeBackgroundTasks({ log: recordingLog().log });
    const done: string[] = [];
    tasks.run("first", async () => {
      tasks.run("second", async () => {
        done.push("second");
      });
      done.push("first");
    });
    await tasks.drain();
    expect(done).toEqual(["first", "second"]);
  });

  it("uses the given defer, so tests and scripts can control when work starts", async () => {
    const queued: (() => void)[] = [];
    const tasks = makeBackgroundTasks({ log: recordingLog().log, defer: (start) => queued.push(start) });
    let ran = false;
    tasks.run("x", async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    queued.forEach((start) => start());
    await tasks.drain();
    expect(ran).toBe(true);
  });
});
