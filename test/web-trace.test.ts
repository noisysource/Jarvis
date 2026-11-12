import { describe, expect, it } from "vitest";
import { EMPTY_TRACE, serviceOf, settleTrace, targetOf, traceOfPath, traceReach, traceStep, traceTree } from "../src/web/trace-lib.js";

type Step = Parameters<typeof traceStep>[1];
const tool = (name: string, args: string, extra: Record<string, unknown> = {}): Step => ({ kind: "tool", name, args, by: "model", ok: true, ...extra }) as Step;

describe("reasoning trace (#143)", () => {
  it("knows each tool's service, and splits the account from the arguments", () => {
    expect(serviceOf("gmail_search")).toBe("Gmail");
    expect(serviceOf("calendar_read")).toBe("Calendar");
    expect(serviceOf("memory_recall")).toBe("Memory");
    expect(targetOf("gmail_search", "personal")).toEqual({ target: "personal", detail: "" });
    expect(targetOf("calendar_read", "noisysource · Thu 12 Nov")).toEqual({ target: "noisysource", detail: "Thu 12 Nov" });
    expect(targetOf("calendar_read", "Thu 12 Nov")).toEqual({ target: "all calendars", detail: "Thu 12 Nov" });
  });

  it("grows as he works: reaching first, then the account and what came back", () => {
    let t = traceStep(EMPTY_TRACE, { kind: "tools", offered: ["gmail_search", "gmail_read", "calendar_read"] } as Step);
    t = traceReach(t, "gmail_search");
    expect(traceTree(t).branches).toEqual([{ tool: "gmail_search", service: "Gmail", status: "reaching", leaves: [{ label: "", result: "", status: "reaching" }] }]);
    t = traceStep(t, tool("gmail_search", "personal", { result: "3 emails" }));
    const tree = traceTree(t);
    expect(tree.hub).toBe("Tools · 3");
    expect(tree.branches[0]?.leaves).toEqual([{ label: "personal", result: "3 emails", status: "used" }]);
  });

  it("calls of the same tool share a branch, one leaf each", () => {
    const t = traceOfPath([tool("gmail_read", "personal", { result: "1 email" }), tool("gmail_read", "noisysource", { result: "1 email" }), tool("calendar_read", "Fri 13 Nov", { result: "2 events" })]);
    const tree = traceTree(t);
    expect(tree.branches.map((b) => [b.tool, b.leaves.length])).toEqual([
      ["gmail_read", 2],
      ["calendar_read", 1],
    ]);
  });

  it("a failure or a pending OK shows on its branch and on Tools", () => {
    const failed = traceTree(traceOfPath([tool("calendar_read", "noisysource · Fri 13 Nov", { ok: false, error: "auth" }), tool("gmail_search", "personal", { result: "1 email" })]));
    expect(failed.status).toBe("failed");
    expect(failed.branches[0]).toMatchObject({ status: "failed", leaves: [{ label: "noisysource · Fri 13 Nov", result: "failed: auth", status: "failed" }] });
    const waiting = traceTree(traceOfPath([tool("gmail_draft", "personal", { result: "waiting for your OK", confirm: { id: "x", label: "y" } })]));
    expect(waiting.status).toBe("waiting");
  });

  it("says when it had tools and used none, or had none", () => {
    expect(traceTree(traceOfPath([{ kind: "tools", offered: ["calendar_read", "gmail_search", "gmail_read"] } as Step])).hub).toBe("3 tools offered, none used");
    expect(traceTree(traceOfPath([{ kind: "tools", offered: [] } as Step])).hub).toBe("No tools");
  });

  it("skills and the Kiro handoff", () => {
    const t = traceTree(traceOfPath([{ kind: "skill", name: "Plan a short trip", args: "", by: "model", ok: true } as Step, { kind: "precheck", result: "handoff" } as Step]));
    expect(t.branches[0]).toMatchObject({ tool: "skill", service: "Skills", leaves: [{ label: "Plan a short trip" }] });
    expect(t.handoff).toBe(true);
  });

  it("a call that never finished is shown as failed when the answer ends", () => {
    const t = settleTrace(traceReach(EMPTY_TRACE, "code_ask"));
    expect(t.calls[0]).toMatchObject({ status: "failed", result: "didn't finish" });
  });
});
