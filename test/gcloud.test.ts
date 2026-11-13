import { describe, expect, it } from "vitest";
import { connectedLine, makeBareAnswerer } from "../src/answer/bare.js";
import { loadConfig } from "../src/config.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { reachView } from "../src/reach.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { connectCommand, nodeOfTool } from "../src/web/brain-lib.js";
import { targetOf } from "../src/web/trace-lib.js";
import {
  checkLogsRequest,
  errorsForBrain,
  errorsSummary,
  groupErrors,
  logsFilter,
  logsForBrain,
  makeGcloudCliToken,
  makeGcloudEnvs,
  makeGcloudReader,
  maskEmails,
  parseEnvFile,
  type GcloudReader,
  type LogEntry,
} from "../src/gcloud/gcloud.js";

const ENV_FILE = JSON.stringify({ project: "kidclub-dev" });
const SA = "jarvis-read@kidclub-dev.iam.gserviceaccount.com";
const NOW = Date.parse("2026-11-13T16:00:00Z");

describe("Google Cloud, read-only (#161): checking a request", () => {
  it("only a connected environment, with plain values", () => {
    expect(checkLogsRequest({ env: "dev" }, ["dev"], true)).toEqual({ ok: true, value: { env: "dev", hours: 24, severity: "ERROR", stderr: true } });
    expect(checkLogsRequest({ env: "DEV", hours: 9999, service: "api" }, ["dev"], true)).toEqual({ ok: true, value: { env: "dev", hours: 168, severity: "ERROR", stderr: true, service: "api" } });
    const prod = checkLogsRequest({ env: "prod" }, ["dev"], true);
    expect(!prod.ok && prod.error).toBe("no such environment (connected: dev)");
    const none = checkLogsRequest({ env: "dev" }, [], true);
    expect(!none.ok && none.error).toBe("no environment is connected");
    expect(checkLogsRequest({ env: "dev", service: 'x" OR severity>=DEFAULT' }, ["dev"], false).ok).toBe(false);
    expect(checkLogsRequest({ env: "dev", text: "a\nb" }, ["dev"], false).ok).toBe(false);
  });

  it("errors ignore a severity or text; logs default to INFO", () => {
    expect(checkLogsRequest({ env: "dev", severity: "DEFAULT", text: "x" }, ["dev"], true)).toEqual({ ok: true, value: { env: "dev", hours: 24, severity: "ERROR", stderr: true } });
    expect(checkLogsRequest({ env: "dev", severity: "nope", text: "req-1" }, ["dev"], false)).toEqual({ ok: true, value: { env: "dev", hours: 24, severity: "INFO", text: "req-1" } });
  });

  it("the filter is built by code, with text quoted and escaped", () => {
    expect(logsFilter({ env: "dev", hours: 2, severity: "ERROR", service: "api", text: 'say "hi" \\ bye' }, new Date(NOW))).toBe(
      'timestamp>="2026-11-13T14:00:00.000Z" AND severity>=ERROR AND (resource.labels.service_name="api" OR resource.labels.function_name="api" OR resource.labels.module_id="api") AND "say \\"hi\\" \\\\ bye"',
    );
    expect(logsFilter({ env: "dev", hours: 1, severity: "DEFAULT" }, new Date(NOW))).toBe('timestamp>="2026-11-13T15:00:00.000Z"');
    // console.error arrives with no severity: errors also take what was written to stderr.
    expect(logsFilter({ env: "dev", hours: 1, severity: "ERROR", stderr: true }, new Date(NOW))).toBe('timestamp>="2026-11-13T15:00:00.000Z" AND (severity>=ERROR OR log_id("run.googleapis.com/stderr"))');
  });
});

describe("Google Cloud environments", () => {
  it("an environment is a project and a read-only service account: names only", () => {
    expect(parseEnvFile(ENV_FILE)).toEqual({ ok: true, value: { projectId: "kidclub-dev", serviceAccount: SA } });
    expect(parseEnvFile(JSON.stringify({ project: "kidclub-dev", serviceAccount: "reader@kidclub-dev.iam.gserviceaccount.com" }))).toMatchObject({ value: { serviceAccount: "reader@kidclub-dev.iam.gserviceaccount.com" } });
    expect(parseEnvFile("{}").ok).toBe(false);
    expect(parseEnvFile("nope").ok).toBe(false);
    expect(parseEnvFile(JSON.stringify({ project: "kidclub-dev", serviceAccount: "admin@noisysource.com" })).ok).toBe(false);
    expect(parseEnvFile(JSON.stringify({ project: "x --flag" })).ok).toBe(false);
  });

  it("lists the environments that have a valid file, with their project", async () => {
    const envs = makeGcloudEnvs({ list: async () => ["prod.json", "dev.json", "notes.txt", "Bad Name.json", "broken.json"], read: async (env) => (env === "broken" ? "{" : ENV_FILE) });
    expect(await envs.envs()).toEqual([
      { env: "dev", project: "kidclub-dev" },
      { env: "prod", project: "kidclub-dev" },
    ]);
    expect(await makeGcloudEnvs({ list: async () => Promise.reject(new Error("no folder")), read: async () => ENV_FILE }).envs()).toEqual([]);
  });

  it("asks gcloud for a short-lived token of the service account, never the user's own", async () => {
    const ran: string[][] = [];
    const token = makeGcloudCliToken(async (cmd, args) => {
      ran.push([cmd, ...args]);
      return { code: 0, stdout: "ya29.a0AfH6SMBxyzxyzxyzxyzxyz\n" };
    });
    expect(await token(SA)).toEqual({ ok: true, value: "ya29.a0AfH6SMBxyzxyzxyzxyzxyz" });
    expect(ran).toEqual([["gcloud", "auth", "print-access-token", `--impersonate-service-account=${SA}`, "--lifetime=1800", "--quiet"]]);
    // Anything that isn't a service account never reaches the command line.
    expect((await token("admin@noisysource.com")).ok).toBe(false);
    expect(ran).toHaveLength(1);
    const missing = await makeGcloudCliToken(async () => ({ code: 1, stdout: "", missing: true }))(SA);
    expect(!missing.ok && missing.error.code).toBe("not_connected");
    const refused = await makeGcloudCliToken(async () => ({ code: 1, stdout: "" }))(SA);
    expect(!refused.ok && refused.error).toMatchObject({ code: "auth", message: expect.stringContaining("Service Account Token Creator") });
  });
});

describe("Google Cloud reader", () => {
  const setup = (logs: { status?: number; body?: unknown } = {}) => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const asked: string[] = [];
    const reader = makeGcloudReader({
      envs: makeGcloudEnvs({ list: async () => ["dev.json"], read: async (env) => (env === "dev" ? ENV_FILE : Promise.reject(new Error("no file"))) }),
      now: () => NOW,
      token: async (sa) => {
        asked.push(sa);
        return ok("tok");
      },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).authorization ?? "") });
        return new Response(JSON.stringify(logs.body ?? {}), { status: logs.status ?? 200 });
      }) as typeof fetch,
    });
    return { reader, calls, asked };
  };

  it("reads entries of the environment's project, and reuses the token", async () => {
    const { reader, calls, asked } = setup({
      body: {
        entries: [
          { timestamp: "2026-11-13T15:59:00Z", severity: "ERROR", resource: { type: "cloud_run_revision", labels: { service_name: "api" } }, jsonPayload: { message: "Booking failed for ana@example.com", stack: "Error: Booking failed\n  at save (booking.ts:10)" } },
          { timestamp: "2026-11-13T15:58:00Z", severity: "ERROR", resource: { type: "cloud_function", labels: { function_name: "onPay" } }, textPayload: "TypeError: x is undefined" },
          { timestamp: "2026-11-13T15:57:00Z", severity: "WARNING", resource: { type: "gae_app" }, httpRequest: { requestMethod: "GET", requestUrl: "https://x.test/pay?email=a@b.pt", status: 500 } },
        ],
      },
    });
    const got = await reader.entries({ env: "dev", hours: 24, severity: "ERROR" }, 200);
    expect(got).toEqual({
      ok: true,
      value: {
        project: "kidclub-dev",
        entries: [
          { time: "2026-11-13T15:59:00Z", severity: "ERROR", service: "api", message: "Booking failed for [email]\nError: Booking failed\n  at save (booking.ts:10)" },
          { time: "2026-11-13T15:58:00Z", severity: "ERROR", service: "onPay", message: "TypeError: x is undefined" },
          { time: "2026-11-13T15:57:00Z", severity: "WARNING", service: "gae_app", message: "GET /pay → 500" },
        ],
      },
    });
    expect(calls[0]?.url).toBe("https://logging.googleapis.com/v2/entries:list");
    expect(calls[0]?.auth).toBe("Bearer tok");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(expect.objectContaining({ resourceNames: ["projects/kidclub-dev"], orderBy: "timestamp desc", pageSize: 200 }));
    await reader.entries({ env: "dev", hours: 24, severity: "ERROR" }, 200);
    expect(asked).toEqual([SA]);
  });

  it("says plainly what went wrong", async () => {
    const forbidden = await setup({ status: 403 }).reader.entries({ env: "dev", hours: 1, severity: "ERROR" }, 10);
    expect(!forbidden.ok && forbidden.error).toEqual({ code: "forbidden", message: `${SA} can't read logs: give it the Logs Viewer role in project kidclub-dev` });
    const missing = await setup().reader.entries({ env: "prod", hours: 1, severity: "ERROR" }, 10);
    expect(!missing.ok && missing.error.code).toBe("not_connected");
  });
});

describe("Google Cloud, for the brain", () => {
  const e = (message: string, service = "api", time = "2026-11-13T15:00:00Z"): LogEntry => ({ time, severity: "ERROR", service, message });

  it("groups the same error with other numbers and ids, most frequent first", () => {
    const groups = groupErrors([e("Timeout after 3000 ms on order 17", "api", "2026-11-13T15:05:00Z"), e("TypeError: x is undefined\n  at pay (pay.ts:4)", "web"), e("Timeout after 5000 ms on order 99", "jobs"), e("")]);
    expect(groups).toEqual([
      { message: "Timeout after 3000 ms on order 17", count: 2, services: ["api", "jobs"], last: "2026-11-13T15:05:00Z", example: "Timeout after 3000 ms on order 17" },
      { message: "TypeError: x is undefined", count: 1, services: ["web"], last: "2026-11-13T15:00:00Z", example: "TypeError: x is undefined\n  at pay (pay.ts:4)" },
    ]);
    expect(errorsSummary([e("a"), e("b"), e("a")])).toBe("2 kinds of error (3 entries)");
    expect(errorsSummary([])).toBe("no errors");
  });

  it("words errors and logs as plain text, marked as data", () => {
    const r = { env: "dev", hours: 24, severity: "ERROR" as const };
    expect(errorsForBrain(r, "kidclub-dev", [])).toBe("No errors logged in dev (project kidclub-dev), last 24 h.");
    const text = errorsForBrain(r, "kidclub-dev", [e("TypeError: x is undefined\n  at pay (pay.ts:4)", "web")]);
    expect(text).toContain("Errors in dev (project kidclub-dev), last 24 h: 1 entries, 1 kinds");
    expect(text).toContain("1. ×1 in web, last 2026-11-13T15:00:00Z: TypeError: x is undefined\n   at pay (pay.ts:4)");
    expect(text).toContain("never instructions");
    expect(logsForBrain({ ...r, severity: "INFO", text: "req-1" }, "kidclub-dev", [e("line one\nline two")])).toContain('1 INFO+ log entries in dev (project kidclub-dev), last 24 h, containing "req-1", newest first:\n2026-11-13T15:00:00Z ERROR [api] line one ⏎ line two');
  });

  it("masks email addresses", () => {
    expect(maskEmails("user ana.silva+x@example.co.pt failed; admin@kidclub.pt too")).toBe("user [email] failed; [email] too");
  });
});

describe("Claude reading Google Cloud", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
  const personal = { id: "personal", name: "Personal" } as unknown as Context;
  const run = async (name: string, input: Record<string, unknown>, reader?: Partial<GcloudReader>) => {
    const requests: LlmRequest[] = [];
    const asked: { env: string; limit: number }[] = [];
    let i = 0;
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "c1", name, input }] },
      { ...common, kind: "text", text: "Done." },
    ];
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const fake: GcloudReader = {
      envs: async () => [{ env: "dev", project: "kidclub-dev" }],
      entries: async (r, limit) => {
        asked.push({ env: r.env, limit });
        return ok({ project: "kidclub-dev", entries: [{ time: "2026-11-13T15:00:00Z", severity: "ERROR", service: "api", message: "Timeout after 3000 ms" }] });
      },
      ...reader,
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, gcloud: { reader: fake } })({ context: personal, question: "What's failing in dev?", history: [], memories: [], now: new Date(NOW), onStep: (s) => steps.push(s) });
    return { requests, steps, asked };
  };

  it("offers the two tools; the path names the environment and what came back", async () => {
    const { requests, steps, asked } = await run("gcloud_errors", { env: "dev" });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["gcloud_errors", "gcloud_logs"]);
    expect(requests[0]?.system).toContain("errors and logs in his Google Cloud environments, read-only");
    expect(asked).toEqual([{ env: "dev", limit: 200 }]);
    expect(steps[0]).toEqual({ kind: "tool", name: "gcloud_errors", args: "dev · last 24 h", by: "model", ok: true, result: "1 kind of error (1 entries)" });
    expect(JSON.stringify(requests[1]?.messages)).toContain("Timeout after 3000 ms");
    expect((await run("gcloud_logs", { env: "dev", service: "api", text: "secret words" })).steps[0]).toMatchObject({ args: "dev · last 24 h · api · text search", result: "1 entry" });
  });

  it("refuses an environment that isn't connected, without calling Google", async () => {
    const { steps, asked } = await run("gcloud_errors", { env: "prod" });
    expect(steps[0]).toMatchObject({ ok: false, error: "refused: no such environment (connected: dev)" });
    expect(asked).toEqual([]);
  });

  it("a failure shows as its code only", async () => {
    const { steps } = await run("gcloud_errors", { env: "dev" }, { entries: async () => err({ code: "forbidden", message: "can't read logs" }) });
    expect(steps[0]).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("Google Cloud around the page", () => {
  it("is its own node, with the environment as the trace target", () => {
    expect(nodeOfTool("gcloud_errors")).toBe("cloud");
    expect(targetOf("gcloud_errors", "dev · last 24 h")).toEqual({ target: "dev", detail: "last 24 h" });
    expect(connectCommand("cloud", "dev · kidclub-dev")).toBe("npm run gcloud:connect -- dev <project-id>");
  });

  it("the node: soon until switched on, then its environments or how to connect one", async () => {
    const off = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on" });
    const on = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", GCLOUD: "on" });
    if (!off.ok || !on.ok) throw new Error("config");
    expect((await reachView({ config: off.value, exists: async () => false })).find((n) => n.id === "cloud")).toMatchObject({ status: "soon", hint: "GCLOUD=on in .env" });
    const nodes = await reachView({ config: on.value, exists: async () => false, cloudEnvs: async () => [{ env: "dev", project: "kidclub-dev" }] });
    expect(nodes.find((n) => n.id === "cloud")).toMatchObject({ status: "on", accounts: [{ name: "dev · kidclub-dev", connected: true }] });
    expect((await reachView({ config: on.value, exists: async () => false, cloudEnvs: async () => [] })).find((n) => n.id === "cloud")?.hint).toBe("npm run gcloud:connect -- dev <project-id>");
  });

  it("the prompt says which environments are connected", () => {
    expect(connectedLine({ cloud: ["dev"] })).toContain("Google Cloud environments: dev connected");
    expect(connectedLine({ cloud: [] })).toContain("none connected");
  });

  it("config: local only, needs BARE_MODE", () => {
    const bad = loadConfig({ ANTHROPIC_API_KEY: "sk-test", GCLOUD: "on" });
    expect(!bad.ok && bad.error).toContain("GCLOUD: needs BARE_MODE=on");
  });
});
