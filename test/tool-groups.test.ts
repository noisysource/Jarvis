// #175: Claude gets only the tool groups a question needs, chosen locally.

import { describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer, MAX_TOOL_ROUNDS } from "../src/answer/bare.js";
import {
  groupOfTool,
  groupsByWords,
  groupsUsedLately,
  makeToolRouter,
  parseRoute,
  pickGroups,
  toolsMoreTool,
  type ToolGroup,
  type ToolRouter,
} from "../src/answer/tool-groups.js";
import type { GcloudReader } from "../src/gcloud/gcloud.js";
import type { GithubReader } from "../src/github/github.js";
import type { LlmCall, LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { serviceOf } from "../src/web/trace-lib.js";

const NOW = new Date("2026-11-13T23:00:00Z");
const personal = { id: "personal", name: "Personal" } as unknown as Context;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
const text = (t: string): LlmResponse => ({ ...common, kind: "text", text: t });
const calls = (...c: LlmToolCall[]): LlmResponse => ({ ...common, kind: "tool_calls", text: "", calls: c });

describe("tool groups: the words of a question", () => {
  it("points at the groups it's about, in English and Portuguese", () => {
    expect(groupsByWords("What's on tomorrow?")).toEqual(["calendar"]);
    expect(groupsByWords("Tens alguma reunião amanhã?")).toEqual(["calendar"]);
    expect(groupsByWords("Any emails from the school?")).toEqual(["gmail"]);
    expect(groupsByWords("Responde ao email da escola")).toEqual(["gmail"]);
    expect(groupsByWords("Tell Sam I'm running late")).toEqual(["gmail"]);
    expect(groupsByWords("Avisa a Marisa que chego tarde")).toContain("gmail");
    expect(groupsByWords("Tell me a joke")).toEqual([]);
    expect(groupsByWords("Is the CI green on the Jarvis repo?")).toEqual(["github"]);
    expect(groupsByWords("How does the billing module work?")).toEqual(["code"]);
    expect(groupsByWords("What's in the dev database?")).toEqual(["cloud"]);
  });

  it("something failing points at the logs, CI and the code", () => {
    expect(groupsByWords("can you check errors on the kidclub app")).toEqual(["github", "code", "cloud"]);
    expect(groupsByWords("Porque é que isto falha?")).toEqual(["github", "code", "cloud"]);
  });

  it("names of studied apps point at the code", () => {
    expect(groupsByWords("Tell me about kidclub", ["kidclub", "finances"])).toEqual(["github", "code"]);
    expect(groupsByWords("Tell me about kidclub")).toEqual([]);
  });

  it("small talk and general questions get none", () => {
    expect(groupsByWords("hello")).toEqual([]);
    expect(groupsByWords("What do you think about OpenJarvis?")).toEqual([]);
    expect(groupsByWords("Olá, tudo bem?")).toEqual([]);
  });
});

describe("tool groups: follow-ups and the router's word", () => {
  it("the last answers' tools carry over", () => {
    const history = [
      { role: "user" as const, text: "what's on today?" },
      { role: "assistant" as const, text: "...", tools: ["calendar_read today"] },
      { role: "user" as const, text: "and the email?" },
      { role: "assistant" as const, text: "...", tools: ["gmail_search personal", "memory_recall"] },
    ];
    expect(groupsUsedLately(history)).toEqual(["calendar", "gmail"]);
    expect(groupsUsedLately(history, 1)).toEqual(["gmail"]);
    expect(groupsUsedLately([])).toEqual([]);
  });

  it("reads group names from the router's reply, nothing else", () => {
    const all: ToolGroup[] = ["calendar", "gmail", "github", "code", "cloud"];
    expect(parseRoute("calendar gmail", all)).toEqual(["calendar", "gmail"]);
    expect(parseRoute("Cloud, code.", all)).toEqual(["code", "cloud"]);
    expect(parseRoute("none", all)).toEqual([]);
    expect(parseRoute("calendar", ["gmail"])).toEqual([]);
  });

  it("the choice is everything any of them said, kept to what's connected, in a fixed order", () => {
    expect(pickGroups({ available: ["calendar", "gmail", "cloud"], words: ["cloud"], lately: ["calendar"], router: ["gmail", "github"] })).toEqual(["calendar", "gmail", "cloud"]);
    expect(pickGroups({ available: ["calendar"], words: [], lately: [] })).toEqual([]);
  });

  it("tools belong to groups by name; memory and skills are always on", () => {
    expect(groupOfTool("gcloud_db_query")).toBe("cloud");
    expect(groupOfTool("code_notes")).toBe("code");
    expect(groupOfTool("memory_recall")).toBeUndefined();
    expect(groupOfTool("skill_follow")).toBeUndefined();
  });

  it("tools_more offers only the missing groups", () => {
    const tool = toolsMoreTool(["gmail", "cloud"]);
    expect(tool.inputSchema).toMatchObject({ properties: { group: { enum: ["gmail", "cloud"] } }, required: ["group"] });
    expect(tool.description).toContain("gmail (");
    expect(serviceOf("tools_more")).toBe("More tools");
  });
});

describe("the small model's pick", () => {
  const history = [
    { role: "user", text: "x".repeat(1000) },
    { role: "assistant", text: "fine" },
  ];

  it("one short call with no tools; the reply becomes groups", async () => {
    const requests: LlmRequest[] = [];
    const router = makeToolRouter({
      llm: async (r) => {
        requests.push(r);
        return ok(text("calendar cloud"));
      },
    });
    expect(await router({ question: "anything failing before my meeting?", history, available: ["calendar", "gmail", "cloud"] })).toEqual(["calendar", "cloud"]);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.maxTokens).toBe(20);
    expect(requests[0]?.thinking).toBe("off");
    expect(requests[0]?.system).toContain("calendar: his calendars");
    // History is cut short; the question is last.
    const asked = requests[0]?.messages[0];
    expect(asked && "text" in asked ? asked.text : "").toMatch(/Renato: x{300}\nJarvis: fine\n\nNewest question: anything failing before my meeting\?$/);
  });

  it("no answer, a failure or a slow answer: undefined, so the words decide", async () => {
    expect(await makeToolRouter({ llm: async () => err({ kind: "network", message: "down", retryable: true }) })({ question: "q", history: [], available: ["gmail"] })).toBeUndefined();
    expect(await makeToolRouter({ llm: async () => Promise.reject(new Error("boom")) })({ question: "q", history: [], available: ["gmail"] })).toBeUndefined();
    const slow: LlmCall = () => new Promise((resolve) => setTimeout(() => resolve(ok(text("gmail"))), 200));
    expect(await makeToolRouter({ llm: slow, timeoutMs: 20 })({ question: "q", history: [], available: ["gmail"] })).toBeUndefined();
  });

  it("nothing connected: no call", async () => {
    let called = false;
    const router = makeToolRouter({
      llm: async () => {
        called = true;
        return ok(text("gmail"));
      },
    });
    expect(await router({ question: "q", history: [], available: [] })).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("Claude with routed tools", () => {
  const githubReader: GithubReader = {
    owners: async () => ["noisysource"],
    repos: async () => ok([]),
    read: async () => ok({ kind: "dir", entries: [] }),
    issues: async () => ok([]),
    checks: async () => ok({ ref: "main", checks: [] }),
  };
  const cloudReader: GcloudReader = {
    envs: async () => [{ env: "dev", project: "kidclub-dev" }],
    entries: async () => ok({ project: "kidclub-dev", entries: [] }),
  };

  const run = async (question: string, script: readonly LlmResponse[], route: { mode: "model" | "rules" | "all"; router?: ToolRouter }, history: { role: "user" | "assistant"; text: string; tools?: string[] }[] = []) => {
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    const offered: string[][] = [];
    const result = await makeBareAnswerer({ llm, tools: true, github: { reader: githubReader, isEc: () => false }, gcloud: { reader: cloudReader }, route })({
      context: personal,
      question,
      history,
      memories: [],
      now: NOW,
      onStep: (s) => steps.push(s),
      onOffered: (t) => offered.push([...t]),
    });
    return { requests, steps, offered, result };
  };
  const names = (r: LlmRequest | undefined) => (r?.tools ?? []).map((t) => t.name);

  it("small talk gets only tools_more; the prompt says how to ask for more", async () => {
    const { requests } = await run("hello", [text("Hi.")], { mode: "rules" });
    expect(names(requests[0])).toEqual(["tools_more"]);
    expect(requests[0]?.system).toContain("call tools_more with it first");
  });

  it("the words pick the groups", async () => {
    const { requests } = await run("check errors on the kidclub app", [text("None.")], { mode: "rules" });
    expect(names(requests[0])).toEqual(["github_repos", "github_read", "github_issues", "github_checks", "gcloud_errors", "gcloud_logs"]);
  });

  it("the small model's pick is added; its question runs once", async () => {
    let asked = 0;
    const router: ToolRouter = async () => {
      asked += 1;
      return ["cloud"];
    };
    const { requests } = await run("anything I should look at?", [text("No.")], { mode: "model", router });
    expect(asked).toBe(1);
    expect(names(requests[0])).toEqual(["gcloud_errors", "gcloud_logs", "tools_more"]);
  });

  it("a wrong guess costs one step: tools_more adds the group for the next rounds, and that round is free", async () => {
    const { requests, steps, offered, result } = await run(
      "hello",
      [calls({ id: "m1", name: "tools_more", input: { group: "cloud" } }), calls({ id: "e1", name: "gcloud_errors", input: { env: "dev" } }), text("No errors in dev.")],
      { mode: "rules" },
    );
    expect(names(requests[1])).toEqual(["gcloud_errors", "gcloud_logs", "tools_more"]);
    expect(steps[0]).toEqual({ kind: "tool", name: "tools_more", args: "cloud", by: "model", ok: true, result: "2 tools" });
    expect(steps[1]).toMatchObject({ kind: "tool", name: "gcloud_errors", ok: true });
    expect(offered).toEqual([["tools_more"], ["tools_more", "gcloud_errors", "gcloud_logs"]]);
    expect(result.ok && result.value.kind === "answer" && result.value.text).toBe("No errors in dev.");
  });

  it("asking for a group that's already there, or isn't connected, is refused", async () => {
    const { steps } = await run("check the logs", [calls({ id: "m1", name: "tools_more", input: { group: "cloud" } }), calls({ id: "m2", name: "tools_more", input: { group: "calendar" } }), text("ok")], { mode: "rules" });
    expect(steps.map((s) => (s.kind === "tool" ? s.ok : undefined))).toEqual([false, false]);
  });

  it("rounds that only asked for tools don't use up the limit", async () => {
    const script = [
      calls({ id: "m1", name: "tools_more", input: { group: "cloud" } }),
      calls({ id: "m2", name: "tools_more", input: { group: "github" } }),
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => calls({ id: `e${i}`, name: "gcloud_errors", input: { env: "dev" } })),
      text("done"),
    ];
    const { requests } = await run("hello", script, { mode: "rules" });
    // Two free rounds, then the usual rounds with tools, then the last without.
    expect(requests).toHaveLength(2 + MAX_TOOL_ROUNDS + 1);
    expect(requests.at(-1)?.tools).toBeUndefined();
    expect(requests.at(-2)?.tools?.length).toBeGreaterThan(0);
  });

  it("a follow-up keeps the last answer's groups", async () => {
    const { requests } = await run("and yesterday?", [text("ok")], { mode: "rules" }, [
      { role: "user", text: "what failed today?" },
      { role: "assistant", text: "two errors", tools: ["gcloud_errors dev · last 24 h"] },
    ]);
    // "yesterday" is a calendar word, but the calendar isn't connected; the cloud carries over.
    expect(names(requests[0])).toEqual(["gcloud_errors", "gcloud_logs", "tools_more"]);
  });

  it('"all": every connected tool, no tools_more, no routing line', async () => {
    const { requests } = await run("hello", [text("Hi.")], { mode: "all" });
    expect(names(requests[0])).toEqual(["github_repos", "github_read", "github_issues", "github_checks", "gcloud_errors", "gcloud_logs"]);
    expect(requests[0]?.system).not.toContain("tools_more");
  });

  it("tools ran but no words came back: an honest line, never a blank reply", async () => {
    const script = [...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => calls({ id: `e${i}`, name: "gcloud_errors", input: { env: "dev" } })), text("")];
    const { result } = await run("what's failing in dev?", script, { mode: "rules" });
    expect(result.ok && result.value.kind === "answer" && result.value.text).toBe("I ran out of steps before I could answer. I got as far as: gcloud_errors. Ask me again, a bit more narrowly, and I'll pick it up from there.");
  });

  it("the prompt line is part of the cached prompt only when routing", () => {
    expect(barePrompt(undefined, { tools: true, github: true, routed: true })).toContain("tools_more");
    expect(barePrompt(undefined, { tools: true })).not.toContain("tools_more");
  });
});
