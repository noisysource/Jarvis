import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeLlm } from "../src/llm/registry.js";
import { makeOllamaLlm, OLLAMA_KEEP_ALIVE, ollamaBody, warmOllama } from "../src/llm/ollama.js";
import { streamOrCall } from "../src/llm/stream.js";
import type { LlmRequest } from "../src/llm/types.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A stand-in Ollama on 127.0.0.1, on a free port. */
const fakeOllama = async (handler: (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void): Promise<URL> => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => handler(req, raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
};

const request: LlmRequest = {
  system: "You are Jarvis.",
  systemSuffix: "Now: Sunday",
  messages: [
    { role: "user", text: "When does my passport expire?" },
    { role: "assistant", text: "In January." },
    { role: "user", text: "And when should I renew it?" },
  ],
  effort: "medium",
  maxTokens: 500,
};

/** Streams NDJSON chunks, split mid-line to test the reader. */
const streamChunks = (res: ServerResponse, parts: string[]) => {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const lines = parts.map((p, i) =>
    JSON.stringify(i < parts.length - 1 ? { message: { role: "assistant", content: p }, done: false } : { message: { role: "assistant", content: p }, done: true, prompt_eval_count: 40, eval_count: 12 }),
  );
  const text = `${lines.join("\n")}\n`;
  let at = 0;
  const step = () => {
    if (at >= text.length) return res.end();
    res.write(text.slice(at, at + 17));
    at += 17;
    setTimeout(step, 2);
  };
  step();
};

describe("Ollama provider (#88)", () => {
  it("streams /api/chat with the system prompt, history, keep_alive and max tokens", async () => {
    let seen: Record<string, unknown> = {};
    const base = await fakeOllama((req, body, res) => {
      seen = { url: req.url, ...body };
      streamChunks(res, ["Renew it ", "by December, ", "to be safe."]);
    });
    const llm = makeOllamaLlm({ model: "llama3.1:8b", baseUrl: base });
    const streamed = streamOrCall(llm, request);
    const deltas: string[] = [];
    for await (const d of streamed.text) deltas.push(d);
    expect(deltas.join("")).toBe("Renew it by December, to be safe.");
    expect(deltas.length).toBeGreaterThan(1); // as it arrives, not at the end
    expect(await streamed.result).toMatchObject({
      ok: true,
      value: { kind: "text", text: "Renew it by December, to be safe.", servedBy: "ollama:llama3.1:8b", usage: { inputTokens: 40, outputTokens: 12 } },
    });
    expect(seen).toEqual({
      url: "/api/chat",
      model: "llama3.1:8b",
      stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: { num_predict: 500 },
      messages: [
        { role: "system", content: "You are Jarvis.\n\nNow: Sunday" },
        { role: "user", content: "When does my passport expire?" },
        { role: "assistant", content: "In January." },
        { role: "user", content: "And when should I renew it?" },
      ],
    });
    expect(ollamaBody("m", request).keep_alive).toBe("30m");
  });

  it("sends think: false when set, so a thinking model like qwen3 answers straight away; drops it if the model refuses it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const base = await fakeOllama((_req, body, res) => {
      bodies.push(body);
      if ("think" in body && body.model === "llama3.1:8b") {
        res.statusCode = 400;
        return res.end('{"error":"\\"llama3.1:8b\\" does not support thinking"}');
      }
      streamChunks(res, ["Hi."]);
    });
    expect(await makeOllamaLlm({ model: "qwen3:8b", baseUrl: base, think: false })(request)).toMatchObject({ ok: true });
    expect(bodies[0]?.think).toBe(false);
    expect(await makeOllamaLlm({ model: "llama3.1:8b", baseUrl: base, think: false })(request)).toMatchObject({ ok: true, value: { text: "Hi." } });
    expect(bodies.slice(1).map((b) => "think" in b)).toEqual([true, false]); // refused, then sent without it
    await makeOllamaLlm({ model: "qwen3:8b", baseUrl: base })(request);
    expect(bodies.at(-1)).not.toHaveProperty("think"); // not set: not sent
  });

  it("works as a plain call too (the stream collected)", async () => {
    const base = await fakeOllama((_req, _b, res) => streamChunks(res, ["Hello ", "there."]));
    expect(await makeOllamaLlm({ model: "m", baseUrl: base })(request)).toMatchObject({ ok: true, value: { text: "Hello there." } });
  });

  it("says plainly when Ollama isn't running, or the model isn't installed", async () => {
    const down = await makeOllamaLlm({ model: "llama3.1:8b", baseUrl: new URL("http://127.0.0.1:9") })(request);
    expect(down).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(!down.ok && down.error.userMessage).toBe(
      `The local brain (Ollama) isn't running at http://127.0.0.1:9. Start it with "ollama serve", or switch to Claude.`,
    );
    const missing = await fakeOllama((_req, _b, res) => {
      res.statusCode = 404;
      res.end('{"error":"model not found"}');
    });
    const notInstalled = await makeOllamaLlm({ model: "qwen3:8b", baseUrl: missing })(request);
    expect(!notInstalled.ok && notInstalled.error.userMessage).toContain('ollama pull qwen3:8b');
  });

  it("refuses JSON output and tools (not supported yet) without calling Ollama", async () => {
    let called = false;
    const base = await fakeOllama((_req, _b, res) => {
      called = true;
      res.end();
    });
    const llm = makeOllamaLlm({ model: "m", baseUrl: base });
    expect(await llm({ ...request, outputSchema: { type: "object", properties: {} } })).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect(called).toBe(false);
  });

  it("cancels when asked", async () => {
    const base = await fakeOllama(() => undefined); // never answers
    const controller = new AbortController();
    const streamed = streamOrCall(makeOllamaLlm({ model: "m", baseUrl: base }), request, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await streamed.result).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });

  it("warms the model up (an empty generate with keep_alive), and the registry builds it from config", async () => {
    let body: Record<string, unknown> = {};
    const base = await fakeOllama((req, b, res) => {
      body = { url: req.url, ...b };
      res.end("{}");
    });
    expect(await warmOllama({ model: "llama3.1:8b", baseUrl: base })).toBe(true);
    expect(body).toEqual({ url: "/api/generate", model: "llama3.1:8b", keep_alive: "30m" });
    expect(await warmOllama({ model: "m", baseUrl: new URL("http://127.0.0.1:9") })).toBe(false);
    expect(makeLlm({ provider: "ollama", model: "llama3.1:8b" }, {}, { ollama: base }).ok).toBe(true);
  });
});
