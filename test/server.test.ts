import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import { makeBackgroundTasks } from "../src/background.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { ok } from "../src/result.js";
import { localHosts, MAX_BODY_BYTES, makeServer } from "../src/server.js";
import { loadVendorAssets, loadWebAssets, WEB_SECURITY_HEADERS, type WebAssets } from "../src/web.js";
import type { Context, ContextId, Deps, MemoryHooks } from "../src/types.js";

const QUESTION = "When is my daughter's birthday?";
const ANSWER = "2 September.";

let contexts: readonly Context[];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

const setup = (
  options: { allowedHosts?: readonly string[]; web?: WebAssets; wrapUp?: MemoryHooks["wrapUp"] } = {},
) => {
  const lines: string[] = [];
  const calls: string[] = [];
  const wrapUps: unknown[] = [];
  const log = makeJsonLogger({ write: (l) => lines.push(l), now: () => new Date("2026-11-06T17:20:00Z") });
  const background = makeBackgroundTasks({ log });
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
    memory: {
      loadMemories: async () => [],
      wrapUp:
        options.wrapUp ??
        (async (input) => {
          wrapUps.push(input);
        }),
    },
    isAnswered: () => true,
    afterReply: background.run,
    now: () => new Date("2026-11-06T17:20:00Z"),
    log,
  };
  let n = 0;
  const app = makeServer(deps, { newRequestId: () => `req-${++n}`, ...options });
  const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request("/ask", { method: "POST", body, headers });
  return { app, post, lines, calls, wrapUps, background };
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

  it("gives the wrap-up the request id and the page's conversation id", async () => {
    const { post, wrapUps, background } = setup();
    await post(JSON.stringify({ question: QUESTION, conversationId: "0f3a9c1e2b4d5e6f" }));
    await background.drain();
    expect(wrapUps[0]).toMatchObject({ requestId: "req-1", conversationId: "0f3a9c1e2b4d5e6f" });
  });

  it("sends the reply before the wrap-up runs, and a slow or failing wrap-up changes nothing", async () => {
    let release: () => void = () => undefined;
    const started: string[] = [];
    const { post, background, lines } = setup({
      wrapUp: async () => {
        started.push("wrapUp");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error(`write failed for ${QUESTION}`);
      },
    });

    const res = await post(JSON.stringify({ question: QUESTION }));
    expect(await res.json()).toEqual({ type: "answer", context: "personal", answer: ANSWER });
    expect(background.pending()).toBe(1); // the reply is out; the wrap-up is still to finish

    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(["wrapUp"]);
    release();
    await background.drain();
    expect(background.pending()).toBe(0);
    const failure = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "background task failed");
    expect(failure).toMatchObject({ task: "memory wrap-up", errorName: "Error" });
    expect(lines.join("\n")).not.toContain(QUESTION);
  });

  it("learns nothing when the page says remember: false", async () => {
    const { post, wrapUps, background } = setup();
    const res = await post(JSON.stringify({ question: QUESTION, remember: false }));
    await background.drain();
    expect(await res.json()).toMatchObject({ type: "answer" });
    expect(wrapUps).toEqual([]);
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

  it("rejects a JSON content type with a body that isn't JSON", async () => {
    const { post } = setup();
    const res = await post("question=hi");
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

describe("Host allowlist (DNS-rebinding guard)", () => {
  const PORT = 8080;
  const guarded = () => setup({ allowedHosts: localHosts(PORT) });
  const get = (app: ReturnType<typeof setup>["app"], host?: string) =>
    app.request(`http://127.0.0.1:${PORT}/healthz`, { headers: host === undefined ? {} : { host } });

  it.each(["127.0.0.1:8080", "localhost:8080", "LOCALHOST:8080", " localhost:8080 "])("allows %s", async (host) => {
    const { app } = guarded();
    expect((await get(app, host)).status).toBe(200);
  });

  it.each([
    ["a rebinding hostname", "evil.example:8080"],
    ["the right name on another port", "localhost:9999"],
    ["no port", "localhost"],
    ["IPv6 loopback", "[::1]:8080"],
    ["a LAN address", "192.168.1.20:8080"],
    ["a lookalike", "localhost.evil.example:8080"],
  ])("rejects %s with 403", async (_label, host) => {
    const { app, calls, lines } = guarded();
    const res = await get(app, host);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ type: "error", message: "This server only accepts requests to localhost." });
    expect(calls).toEqual([]);
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ message: "rejected request", reason: "host_not_allowed" }),
    );
  });

  it("rejects a request with no Host header", async () => {
    const { app, lines } = guarded();
    expect((await get(app)).status).toBe(403);
    expect(lines.join("\n")).toContain('"reason":"missing_host"');
  });

  it("guards POST /ask before reading the body, and 404s too", async () => {
    const { app, calls } = guarded();
    const res = await app.request(`http://127.0.0.1:${PORT}/ask`, {
      method: "POST",
      headers: { host: "evil.example:8080", "content-type": "application/json" },
      body: JSON.stringify({ question: QUESTION }),
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect((await app.request(`http://127.0.0.1:${PORT}/nope`, { headers: { host: "evil.example:8080" } })).status).toBe(403);
  });

  it("answers normally on an allowed host", async () => {
    const { app } = guarded();
    const res = await app.request(`http://127.0.0.1:${PORT}/ask`, {
      method: "POST",
      headers: { host: "localhost:8080", "content-type": "application/json" },
      body: JSON.stringify({ question: QUESTION }),
    });
    expect(await res.json()).toMatchObject({ type: "answer" });
  });

  it("is off when no allowlist is given (production behind Cloud Run IAM)", async () => {
    const { app } = setup();
    expect((await get(app, "jarvis-abc123-ew.a.run.app")).status).toBe(200);
  });
});

describe("POST /ask content type (cross-site guard)", () => {
  it.each([
    ["text/plain", "text/plain"],
    ["a form post", "application/x-www-form-urlencoded"],
    ["multipart", "multipart/form-data; boundary=x"],
    ["a JSON lookalike", "application/json-patch+json"],
  ])("rejects %s with 415", async (_label, contentType) => {
    const { post, calls, lines } = setup();
    const res = await post(JSON.stringify({ question: QUESTION }), { "content-type": contentType });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ type: "error", message: "POST /ask needs Content-Type: application/json." });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).not.toContain(QUESTION);
  });

  it("rejects a missing content type with 415", async () => {
    const { post } = setup();
    expect((await post(JSON.stringify({ question: QUESTION }), {})).status).toBe(415);
  });

  it.each(["application/json; charset=utf-8", "Application/JSON"])("accepts %s", async (contentType) => {
    const { post } = setup();
    const res = await post(JSON.stringify({ question: QUESTION }), { "content-type": contentType });
    expect(res.status).toBe(200);
  });
});

describe("POST /latency (#76)", () => {
  const report = {
    browser: "safari 18",
    spoken: true,
    voice: "kokoro",
    route: "classifier",
    endOfTurnMs: 512,
    whisperMs: 300,
    routeMs: 280,
    firstTokenMs: 640,
    firstSentenceMs: 670,
    voiceFirstAudioMs: 250,
    fillerMs: 810,
    firstChunkChars: 58,
    echoPeak: 62,
    echoRunMs: 96,
    speculative: "used",
    totalMs: 1760,
  };
  it("logs a turn's numbers with the browser", async () => {
    const { app, lines } = setup({ allowedHosts: localHosts(8080) });
    const res = await app.request("/latency", {
      method: "POST",
      headers: { host: "127.0.0.1:8080", "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(res.status).toBe(200);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "latency");
    expect(logged).toMatchObject(report);
  });

  it("takes numbers only: no text fields, no strings in number fields, behind the guards", async () => {
    const { app, lines } = setup({ allowedHosts: localHosts(8080) });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      app.request("/latency", { method: "POST", headers: { host: "127.0.0.1:8080", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({ ...report, question: "When does my passport expire?" })).status).toBe(400);
    expect((await post({ ...report, totalMs: "fast" })).status).toBe(400);
    expect((await post({ ...report, browser: "When does my passport expire?" })).status).toBe(400);
    expect((await post(report, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(report, { host: "evil.example" })).status).toBe(403);
    expect(lines.join("\n")).not.toContain("passport");
  });
});

describe("POST /warm (#76)", () => {
  it("warms the model connection when asked, behind the Host guard", async () => {
    let warmed = 0;
    const { app } = setup({ allowedHosts: localHosts(8080) });
    const deps = { contexts, precheck: makePrecheck(contexts), log: makeJsonLogger({ write: () => undefined }) } as unknown as Deps;
    const withWarm = makeServer(deps, { allowedHosts: localHosts(8080), warm: () => (warmed += 1) });
    expect((await withWarm.request("/warm", { method: "POST", headers: { host: "127.0.0.1:8080" } })).status).toBe(200);
    expect((await withWarm.request("/warm", { method: "POST", headers: { host: "evil.example" } })).status).toBe(403);
    expect(warmed).toBe(1);
    expect((await app.request("/warm", { method: "POST", headers: { host: "127.0.0.1:8080" } })).status).toBe(404); // not set up: no route
  });
});

describe("GET /voice-settings (#75)", () => {
  it("gives the page the end of turn and barge-in mode per browser", async () => {
    const lines: string[] = [];
    const deps = { contexts, precheck: makePrecheck(contexts), log: makeJsonLogger({ write: (l) => lines.push(l) }) } as unknown as Deps;
    const turn = {
      endOfTurnMs: 650,
      bargeIn: { chrome: "vad", safari: "push", other: "strict" },
      spokenThinking: "off",
      classifierThinking: "off",
      stickyContext: false,
      speculativeAnswer: false,
      firstChunkChars: 60,
      spokenSentences: 3,
      punctuationStyle: false,
    } as const;
    const app = makeServer(deps, { allowedHosts: localHosts(8080), turn, dev: true });
    const res = await app.request("/voice-settings", { headers: { host: "127.0.0.1:8080" } });
    // Only what the page needs; the server-side tuning stays on the server.
    expect(await res.json()).toEqual({ language: "en", endOfTurnMs: 650, bargeIn: turn.bargeIn, dev: true, reactionFirst: false });
    // Bare mode: replies open with their own short reaction (#92), so the page waits longer before a filler.
    const bare = makeServer(deps, { allowedHosts: localHosts(8080), turn, reactionFirst: true });
    expect(await (await bare.request("/voice-settings", { headers: { host: "127.0.0.1:8080" } })).json()).toMatchObject({ reactionFirst: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/voice-settings", { headers: { host: "evil.example" } })).status).toBe(403);
  });
});

describe("GET /brains (#88)", () => {
  it("lists the two brains by id and label, for the page's switch", async () => {
    const deps = { contexts, precheck: makePrecheck(contexts), log: makeJsonLogger({ write: () => undefined }) } as unknown as Deps;
    const app = makeServer(deps, { brains: { default: "local", labels: { local: "Local · llama3.1:8b", claude: "Claude · claude-sonnet-5-5" } } });
    expect(await (await app.request("/brains")).json()).toEqual({
      default: "local",
      brains: [
        { id: "local", label: "Local · llama3.1:8b" },
        { id: "claude", label: "Claude · claude-sonnet-5-5" },
      ],
    });
  });
});

describe("chat page", () => {
  const webSetup = async () => {
    const web = await loadWebAssets();
    if (!web.ok) throw new Error(web.error);
    return setup({ web: web.value, allowedHosts: localHosts(8080) });
  };
  const get = (app: ReturnType<typeof setup>["app"], path: string) =>
    app.request(`http://127.0.0.1:8080${path}`, { headers: { host: "127.0.0.1:8080" } });

  it.each([
    ["/", "text/html", "<title>Jarvis</title>"],
    ["/app.js", "text/javascript", 'from "./chat.js"'],
    ["/chat.js", "text/javascript", "export const replyView"],
    ["/app.css", "text/css", "prefers-color-scheme"],
  ])("serves %s as %s with the security headers", async (path, type, snippet) => {
    const { app } = await webSetup();
    const res = await get(app, path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(await res.text()).toContain(snippet);
  });

  it("is behind the Host guard too", async () => {
    const { app } = await webSetup();
    const res = await app.request("http://127.0.0.1:8080/", { headers: { host: "evil.example:8080" } });
    expect(res.status).toBe(403);
  });

  it("loads only local scripts and styles", async () => {
    const { app } = await webSetup();
    const html = await (await get(app, "/")).text();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it("serves the /voices audition page in development only (#73)", async () => {
    const prod = await loadWebAssets();
    const dev = await loadWebAssets(undefined, undefined, { dev: true });
    expect(prod.ok && Object.keys(prod.value)).not.toContain("/voices");
    expect(dev.ok && Object.keys(dev.value)).toEqual(expect.arrayContaining(["/voices", "/voices.js", "/voices-lib.js", "/voices.css", "/audio.js", "/pcm-lib.js"]));
    const html = dev.ok ? (dev.value["/voices"]?.body ?? "") : "";
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it("hosts voice detection itself (#75): the ONNX runtime's WebAssembly and the Silero model, no CDN", async () => {
    const vendor = await loadVendorAssets();
    if (!vendor.ok) throw new Error(vendor.error);
    const web = await loadWebAssets();
    if (!web.ok) throw new Error(web.error);
    const { app } = setup({ web: { ...web.value, ...vendor.value }, allowedHosts: localHosts(8080) });
    const wasm = await get(app, "/vendor/ort/ort-wasm-simd-threaded.wasm");
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("cache-control")).toBe("private, max-age=3600");
    const bytes = new Uint8Array(await wasm.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]); // "\0asm"
    const model = await get(app, "/vendor/silero_vad_v5.onnx");
    expect((await model.arrayBuffer()).byteLength).toBeGreaterThan(1_000_000);
    expect((await get(app, "/vendor/ort/ort.wasm.min.mjs")).headers.get("content-type")).toContain("text/javascript");
    // The page may compile WebAssembly, but still not eval() JavaScript or load anything from elsewhere.
    const csp = WEB_SECURITY_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'|https?:/);
    for (const [path, asset] of Object.entries(web.value)) {
      if (path.endsWith(".js")) expect(String(asset.body), path).not.toMatch(/from\s+["']https?:|import\(["']https?:/);
    }
  });

  it("fails clearly when a page file is missing", async () => {
    const result = await loadWebAssets(async (p) => {
      if (p.endsWith("app.css")) throw new Error("ENOENT");
      return "x";
    });
    expect(result).toEqual({ ok: false, error: "Couldn't read the chat page file src/web/app.css" });
  });
});
