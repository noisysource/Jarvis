// The reasoning trace (#143): what Jarvis did for one answer, as a tree that
// grows while he works: brain → Tools → the tool → the service → the account
// (with what came back). Pure: brain.js draws it.
//
// Built only from real events (reach, step, and the final path). Steps
// carry no content: tool names, accounts, dates and counts.

import { nodeOfTool } from "./brain-lib.js";

/** @typedef {import("./chat.js").PathStep} PathStep */
/** @typedef {"reaching" | "used" | "waiting" | "failed"} CallStatus */
/**
 * One tool or skill call. `target`: the account or skill it reached; `detail`: the rest of its arguments.
 * @typedef {{ tool: string, service: string, target: string, detail: string, result: string, status: CallStatus }} Call
 */
/**
 * @typedef {{ offered: readonly string[] | undefined, calls: readonly Call[], handoff: boolean }} Trace
 */

/** @type {Trace} */
export const EMPTY_TRACE = { offered: undefined, calls: [], handoff: false };

/** @type {Record<string, string>} */
const SERVICES = { calendar: "Calendar", gmail: "Gmail", memory: "Memory", skills: "Skills", github: "GitHub", cloud: "Google Cloud", vendus: "Vendus", code: "Code agent" };

/** The service a tool reaches: "Gmail" for gmail_search. @param {string} tool */
export const serviceOf = (tool) => (tool === "tools_more" ? "More tools" : (SERVICES[nodeOfTool(tool) ?? ""] ?? "Unknown"));

const ACCOUNT = /^(personal|noisysource)(?: · (.*))?$/;

/**
 * Splits a step's checked arguments into the account and the rest:
 * "noisysource · Thu 12 Nov" → noisysource, Thu 12 Nov. A calendar read
 * without an account read them all.
 * @param {string} tool @param {string} args
 */
export const targetOf = (tool, args) => {
  const m = ACCOUNT.exec(args);
  if (m) return { target: m[1] ?? args, detail: m[2] ?? "" };
  if (tool === "calendar_read" && args !== "") return { target: "all calendars", detail: args };
  // #125: "owner/repo · path" → the repo, then the rest.
  if (tool.startsWith("code_") && args !== "") return { target: args, detail: "" };
  if ((tool.startsWith("github_") || tool.startsWith("gcloud_")) && args !== "") {
    const [repo, ...rest] = args.split(" · ");
    return { target: repo ?? args, detail: rest.join(" · ") };
  }
  return { target: "", detail: args };
};

/**
 * A tool call started: a new branch, still reaching.
 * @param {Trace} trace @param {string} tool @returns {Trace}
 */
export const traceReach = (trace, tool) => ({
  ...trace,
  calls: [...trace.calls, { tool, service: serviceOf(tool), target: "", detail: "", result: "", status: "reaching" }],
});

/**
 * A step ended. A tool step completes the oldest matching call still
 * reaching (or adds one, if its start was missed); a skill step is a call
 * of its own; the offered tools and a Kiro handoff are noted.
 * @param {Trace} trace @param {PathStep} step @returns {Trace}
 */
export const traceStep = (trace, step) => {
  if (step.kind === "tools") return { ...trace, offered: step.offered };
  if (step.kind === "precheck") return step.result === "handoff" ? { ...trace, handoff: true } : trace;
  if (step.kind !== "tool" && step.kind !== "skill") return trace;
  const tool = step.kind === "skill" ? "skill" : step.name;
  const { target, detail } = step.kind === "skill" ? { target: step.name, detail: "" } : targetOf(step.name, step.args);
  /** @type {Call} */
  const done = {
    tool,
    service: step.kind === "skill" ? "Skills" : serviceOf(step.name),
    target,
    detail,
    result: step.ok ? (step.result ?? "ok") : `failed: ${step.error ?? "error"}`,
    status: !step.ok ? "failed" : step.confirm ? "waiting" : "used",
  };
  const i = trace.calls.findIndex((c) => c.status === "reaching" && c.tool === tool);
  const calls = i === -1 ? [...trace.calls, done] : trace.calls.map((c, j) => (j === i ? done : c));
  return { ...trace, calls };
};

/** The whole trace from an answer's final path. @param {readonly PathStep[]} path @returns {Trace} */
export const traceOfPath = (path) => path.reduce(traceStep, EMPTY_TRACE);

/** Anything still reaching when the answer ended didn't finish. @param {Trace} trace @returns {Trace} */
export const settleTrace = (trace) => ({
  ...trace,
  calls: trace.calls.map((c) => (c.status === "reaching" ? { ...c, status: "failed", result: "didn't finish" } : c)),
});

/**
 * The tree to draw: one branch per tool name, in the order first used, each
 * with its service and one leaf per call. A branch is as bad as its worst
 * leaf, so a failure or a pending OK shows all the way back to Tools.
 * @param {Trace} trace
 */
export const traceTree = (trace) => {
  /** @type {Map<string, Call[]>} */
  const byTool = new Map();
  for (const c of trace.calls) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
  /** @type {Record<CallStatus, number>} */
  const weight = { used: 0, reaching: 1, waiting: 2, failed: 3 };
  /** @param {readonly Call[]} calls @returns {CallStatus} */
  const worst = (calls) => calls.reduce((w, c) => (weight[c.status] > weight[w] ? c.status : w), /** @type {CallStatus} */ ("used"));
  const branches = [...byTool].map(([tool, calls]) => ({
    tool,
    service: calls[0]?.service ?? "Unknown",
    status: worst(calls),
    leaves: calls.map((c) => ({ label: [c.target, c.detail].filter(Boolean).join(" · "), result: c.result, status: c.status })),
  }));
  const offered = trace.offered?.length;
  const hub =
    offered === undefined
      ? "Tools"
      : offered === 0
        ? "No tools"
        : branches.length === 0
          ? `${offered} ${offered === 1 ? "tool" : "tools"} offered, none used`
          : `Tools · ${offered}`;
  return { hub, status: branches.length === 0 ? "idle" : worst(trace.calls), branches, handoff: trace.handoff };
};
