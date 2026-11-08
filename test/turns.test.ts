import { describe, expect, it, vi } from "vitest";
import { asksExplicitMemoryChange, decideWrapUp, makeTurnRegistry, type HeldTurn } from "../src/turns.js";
import type { Logger } from "../src/types.js";

const turn = (question: string, completed = true): Pick<HeldTurn, "question" | "completed" | "answer"> => ({
  question,
  completed,
  answer: completed ? "Full answer." : "",
});

describe("decideWrapUp", () => {
  it("wraps up on the full answer when it was played to the end", () => {
    expect(decideWrapUp(turn("How old is Inês?"), { interrupted: false, spoken: "Full answer." })).toEqual({ answer: "Full answer." });
  });

  it("skips an interrupted answer…", () => {
    expect(decideWrapUp(turn("How old is Inês?"), { interrupted: true, spoken: "She's" })).toBeNull();
    expect(decideWrapUp(turn("How old is Inês?", false), { interrupted: false, spoken: "" })).toBeNull(); // cancelled mid-stream
  });

  it.each(["Remember that Diniz has football tomorrow", "Lembra-te que tenho dentista na sexta", "Forget that I take espresso", "esquece o dentista"])(
    "…unless the question explicitly asked to remember or forget (%j): then on what was spoken",
    (question) => {
      expect(decideWrapUp(turn(question), { interrupted: true, spoken: "Noted: Diniz has—" })).toEqual({ answer: "Noted: Diniz has—" });
      expect(decideWrapUp(turn(question, false), { interrupted: true, spoken: "" })).toEqual({ answer: "" });
    },
  );

  it("an opt-out wins over remember", () => {
    expect(asksExplicitMemoryChange("Don't save this, but remember I'm tired")).toBe(false);
    expect(decideWrapUp(turn("Off the record: remember I'm job hunting"), { interrupted: true, spoken: "x" })).toBeNull();
  });

  it("with no report: a finished answer counts as heard, a cancelled one as interrupted", () => {
    expect(decideWrapUp(turn("How old is Inês?"), undefined)).toEqual({ answer: "Full answer." });
    expect(decideWrapUp(turn("How old is Inês?", false), undefined)).toBeNull();
    expect(decideWrapUp(turn("Remember the parents' evening", false), undefined)).toEqual({ answer: "" });
  });
});

describe("makeTurnRegistry", () => {
  const setup = () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const info = vi.fn<Logger["info"]>();
    const registry = makeTurnRegistry({
      log: { info, warn: vi.fn(), error: vi.fn() },
      holdMs: 1000,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return { clear: () => (t.cleared = true) };
      },
    });
    const ran: string[] = [];
    const held = (question: string, completed = true): HeldTurn => ({ ...turn(question, completed), run: (a) => ran.push(a) });
    return { registry, timers, ran, held, info };
  };

  it("runs the decided wrap-up once, on the report", () => {
    const { registry, ran, held, timers } = setup();
    registry.hold("turn-0001", held("How old is Inês?"));
    expect(registry.pending()).toBe(1);
    expect(registry.report("turn-0001", { interrupted: false, spoken: "Full answer." })).toBe(true);
    expect(ran).toEqual(["Full answer."]);
    expect(timers[0]?.cleared).toBe(true);
    expect(registry.report("turn-0001", { interrupted: false, spoken: "" })).toBe(false); // already settled
    expect(registry.pending()).toBe(0);
  });

  it("settles on its own when the page never reports", () => {
    const { registry, ran, held, timers } = setup();
    registry.hold("turn-0002", held("How old is Inês?"));
    expect(timers[0]?.ms).toBe(1000);
    timers[0]?.fn();
    expect(ran).toEqual(["Full answer."]);
    expect(registry.pending()).toBe(0);
  });

  it("skips an interrupted, non-explicit turn, and logs no text", () => {
    const { registry, ran, held, info } = setup();
    registry.hold("turn-0003", held("Tell me about Inês's school"));
    registry.report("turn-0003", { interrupted: true, spoken: "Inês goes to" });
    expect(ran).toEqual([]);
    expect(info).toHaveBeenCalledWith("spoken turn settled", { reported: true, interrupted: true, wrapUp: "skipped" });
    expect(JSON.stringify(info.mock.calls)).not.toContain("Inês");
  });

  it("settles every held turn as unreported on shutdown, clearing their timers", () => {
    const { registry, ran, held, timers } = setup();
    registry.hold("turn-0004", held("How old is Inês?")); // finished: counts as heard
    registry.hold("turn-0005", held("Tell me about the school", false)); // cancelled: skipped
    registry.hold("turn-0006", held("Remember Diniz has football tomorrow", false)); // cancelled, explicit: question only
    expect(registry.settleAll()).toBe(3);
    expect(ran).toEqual(["Full answer.", ""]);
    expect(registry.pending()).toBe(0);
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect(registry.settleAll()).toBe(0);
  });

  it("caps how many turns it holds", () => {
    const { registry, held } = setup();
    for (let i = 0; i < 105; i += 1) registry.hold(`turn-${String(i).padStart(4, "0")}`, held("q"));
    expect(registry.pending()).toBe(100);
  });
});
