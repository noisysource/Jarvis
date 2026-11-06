import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { ok } from "../src/result.js";
import { MAX_BODY_BYTES, makeServer } from "../src/server.js";
import type { Context, ContextId, Deps } from "../src/types.js";

const QUESTION = "When is my daughter's birthday?";
const ANSWER = "2 September.";

let contexts: readonly Context[];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

const setup = () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const deps: Deps = {
    contexts,
    precheck: makePrecheck(contexts),
    classify: async () => {
      calls.push("classify");
      return { kind: "context", contextId: "personal" as ContextId };
    },
    answer: async () => {
      calls.push("answer");
      return ok({ kind: "answer", text: ANSWER });
    },
    memory: { loadMemories: async () => [], wrapUp: async () => undefined },
    now: () => new Date("2026-11-06T17:20:00Z"),
    log: makeJsonLogger({ write: (l) => lines.push(l), now: () => new Date("2026-11-06T17:20:00Z") }),
  };
  let n = 0;
  const app = makeServer(deps, { newRequestId: () => `req-${++n}` });
  const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request("/ask", { method: "POST", body, headers });
  return { app, post, lines, calls };
};

describe("GET /healthz", () => {
  it("answers ok without touching the models", async () => {
    const { app, calls } = setup();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(calls).toEqual([]);
  });
});

describe("POST /ask", () => {
  it("answers a valid question", async () => {
    const { post } = setup();
    const res = await post(JSON.stringify({ question: QUESTION }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(await res.json()).toEqual({ type: "answer", context: "personal", answer: ANSWER });
  });

  it("passes history and a picked context through", async () => {
    const { post, calls } = setup();
    const res = await post(
      JSON.stringify({
        question: "And her birthday?",
        context: "personal",
        history: [
          { role: "user", text: "What's my daughter's name?" },
          { role: "assistant", text: "Inês." },
        ],
      }),
    );
    expect(await res.json()).toMatchObject({ type: "answer" });
    expect(calls).toEqual(["answer"]); // picked context: no classifier
  });

  it("hands EC/HRT questions to Kiro", async () => {
    const { post, calls } = setup();
    const res = await post(JSON.stringify({ question: "Summarise the UTP standup", context: "personal" }));
    expect(await res.json()).toMatchObject({ type: "handoff", context: "ec-hrt" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an empty question", JSON.stringify({ question: "" }), "question: question is empty"],
    ["a missing question", JSON.stringify({}), "question"],
    ["too much history", JSON.stringify({ question: "q", history: Array.from({ length: 21 }, () => ({ role: "user", text: "x" })) }), "more than 20 turns"],
    ["an unknown field", JSON.stringify({ question: "q", role: "system" }), "role"],
  ])("rejects %s with 400", async (_label, body, message) => {
    const { post, calls } = setup();
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { type: string; message: string };
    expect(json.type).toBe("error");
    expect(json.message).toContain(message);
    expect(calls).toEqual([]);
  });

  it("rejects a body that isn't JSON", async () => {
    const { post } = setup();
    const res = await post("question=hi", { "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: "error", message: "The request body must be JSON." });
  });

  it("rejects malformed JSON", async () => {
    const { post } = setup();
    const res = await post("{ question: ");
    expect(res.status).toBe(400);
  });

  it("rejects a body over the size limit with 413", async () => {
    const { post, calls } = setup();
    const res = await post(JSON.stringify({ question: "x".repeat(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ type: "error", message: "The request is too large." });
    expect(calls).toEqual([]);
  });
});

describe("other routes", () => {
  it("return 404 JSON", async () => {
    const { app } = setup();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ type: "error", message: "Not found." });
  });

  it("GET /ask isn't a route", async () => {
    const { app } = setup();
    expect((await app.request("/ask")).status).toBe(404);
  });
});

describe("logging", () => {
  it("writes one JSON access line per request, with the request id and no question or answer", async () => {
    const { post, lines } = setup();
    await post(JSON.stringify({ question: QUESTION }));

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries).toContainEqual({
      severity: "INFO",
      time: "2026-11-06T17:20:00.000Z",
      message: "request",
      requestId: "req-1",
      method: "POST",
      path: "/ask",
      status: 200,
      ms: expect.any(Number),
    });
    // The handler's own log line carries the same request id.
    expect(entries).toContainEqual(
      expect.objectContaining({ message: "ask", requestId: "req-1", context: "personal", outcome: "answer" }),
    );
    const all = lines.join("\n");
    expect(all).not.toContain(QUESTION);
    expect(all).not.toContain(ANSWER);
  });
});
