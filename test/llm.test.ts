import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildParams, makeAnthropicLlm, mapError, mapResponse, type StreamMessage } from "../src/llm/anthropic.js";
import { streamOrCall } from "../src/llm/stream.js";
import { makeLlm } from "../src/llm/registry.js";
import type { LlmRequest } from "../src/llm/types.js";

type Message = Anthropic.Beta.Messages.BetaMessage;

const SECRET_KEY = "sk-ant-test-key-do-not-log";

const message = (overrides: Partial<Message>): Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
    ...overrides,
  }) as unknown as Message;

const base: LlmRequest = {
  system: "You are Jarvis.",
  messages: [{ role: "user", text: "Hi" }],
  maxTokens: 1000,
};

const classifySchema = {
  type: "object",
  properties: { context: { type: "string", enum: ["personal", "unclear"] } },
  required: ["context"],
  additionalProperties: false,
} as const;

describe("buildParams", () => {
  it("builds a plain Haiku request with no fallback parameter", () => {
    const params = buildParams("claude-haiku-5-5", { ...base, effort: "low", outputSchema: classifySchema });
    expect(params).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 1000,
      system: "You are Jarvis.",
      messages: [{ role: "user", content: "Hi" }],
      output_config: { effort: "low", format: { type: "json_schema", schema: classifySchema } },
    });
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("adds the server-side refusal fallback for Sonnet 5.5", () => {
    const params = buildParams("claude-sonnet-5-5", { ...base, effort: "medium" });
    expect(params).toMatchObject({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
    });
  });

  it("omits output_config when there's no effort or schema", () => {
    expect(buildParams("claude-haiku-5-5", base)).not.toHaveProperty("output_config");
  });

  it("marks a cacheable system prompt", () => {
    expect(buildParams("claude-sonnet-5-5", { ...base, cacheSystem: true }).system).toEqual([
      { type: "text", text: "You are Jarvis.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("puts an uncached suffix after the cached system prompt", () => {
    expect(
      buildParams("claude-sonnet-5-5", { ...base, cacheSystem: true, systemSuffix: "Now: Friday" }).system,
    ).toEqual([
      { type: "text", text: "You are Jarvis.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Now: Friday" },
    ]);
    expect(buildParams("claude-sonnet-5-5", { ...base, systemSuffix: "Now: Friday" }).system).toEqual([
      { type: "text", text: "You are Jarvis." },
      { type: "text", text: "Now: Friday" },
    ]);
  });

  it("maps tools as strict tools", () => {
    const params = buildParams("claude-sonnet-5-5", {
      ...base,
      tools: [{ name: "get_invoice", description: "Read one invoice", inputSchema: classifySchema }],
    });
    expect(params.tools).toEqual([
      { name: "get_invoice", description: "Read one invoice", input_schema: classifySchema, strict: true },
    ]);
  });

  it("maps a conversation with tool calls and results", () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "tu_1", name: "get_invoice", input: { id: 7 } },
    ];
    const params = buildParams("claude-sonnet-5-5", {
      ...base,
      messages: [
        { role: "user", text: "Invoice 7?" },
        // Our own earlier turn: sent back unchanged, thinking block included.
        { role: "assistant", text: "", payload: { provider: "anthropic", data: raw } },
        { role: "user", toolResults: [{ callId: "tu_1", content: "not found", isError: true }] },
        // A turn without a payload (e.g. from history): rebuilt from text and tool calls.
        { role: "assistant", text: "Let me check.", toolCalls: [{ id: "tu_2", name: "get_invoice", input: { id: 8 } }] },
        { role: "user", toolResults: [{ callId: "tu_2", content: "{}" }] },
        { role: "assistant", text: "Earlier answer" },
      ],
    });
    expect(params.messages).toEqual([
      { role: "user", content: "Invoice 7?" },
      { role: "assistant", content: raw },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "not found", is_error: true }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu_2", name: "get_invoice", input: { id: 8 } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
    ]);
  });

  it("ignores a payload from another provider", () => {
    const params = buildParams("claude-sonnet-5-5", {
      ...base,
      messages: [{ role: "assistant", text: "Hi", payload: { provider: "gemini", data: [{ x: 1 }] } }],
    });
    expect(params.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Hi" }] }]);
  });
});

describe("mapResponse", () => {
  it("maps text, usage, the served model and the payload", () => {
    const m = message({ model: "claude-sonnet-5", content: [{ type: "text", text: " Lisbon. " }] as Message["content"] });
    expect(mapResponse(m, false)).toEqual({
      ok: true,
      value: {
        kind: "text",
        text: "Lisbon.",
        servedBy: "claude-sonnet-5",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 },
        payload: { provider: "anthropic", data: m.content },
      },
    });
  });

  it("ignores thinking and fallback blocks when collecting text", () => {
    const m = message({
      content: [
        { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } },
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "Answer" },
      ] as unknown as Message["content"],
    });
    const result = mapResponse(m, false);
    expect(result.ok && result.value.kind === "text" && result.value.text).toBe("Answer");
  });

  it("parses JSON output", () => {
    const result = mapResponse(message({ content: [{ type: "text", text: '{"context":"personal"}' }] as Message["content"] }), true);
    expect(result.ok && result.value.kind === "json" && result.value.value).toEqual({ context: "personal" });
  });

  it("reports JSON that doesn't parse", () => {
    const result = mapResponse(message({ content: [{ type: "text", text: "personal" }] as Message["content"] }), true);
    expect(!result.ok && result.error.kind).toBe("invalid_output");
  });

  it("maps tool calls", () => {
    const result = mapResponse(
      message({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "tu_1", name: "get_invoice", input: { id: 7 } },
        ] as Message["content"],
      }),
      false,
    );
    expect(result.ok && result.value.kind === "tool_calls" && result.value.calls).toEqual([
      { id: "tu_1", name: "get_invoice", input: { id: 7 } },
    ]);
  });

  it("maps a refusal with its category", () => {
    const result = mapResponse(
      message({ stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: "cyber", explanation: null } } as unknown as Partial<Message>),
      false,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "refused", message: "The model declined (category: cyber)", retryable: false },
    });
  });

  it("maps a cut-off response", () => {
    const result = mapResponse(message({ stop_reason: "max_tokens" }), false);
    expect(!result.ok && result.error.kind).toBe("max_tokens");
  });
});

describe("mapError", () => {
  it.each([
    [new APIConnectionTimeoutError(), "timeout", true],
    [new APIConnectionError({ message: "ECONNRESET" }), "network", true],
    [APIError.generate(429, {}, "rate limited", new Headers()), "rate_limited", true],
    [APIError.generate(401, {}, "bad key", new Headers()), "auth", false],
    [APIError.generate(403, {}, "forbidden", new Headers()), "auth", false],
    [APIError.generate(400, {}, "bad request", new Headers()), "bad_request", false],
    [APIError.generate(404, {}, "no such model", new Headers()), "bad_request", false],
    [APIError.generate(500, {}, "oops", new Headers()), "server", true],
    [APIError.generate(529, {}, "overloaded", new Headers()), "server", true],
    [new Error("boom"), "unknown", false],
  ] as const)("maps %s", (error, kind, retryable) => {
    expect(mapError(error)).toMatchObject({ kind, retryable });
  });
});

describe("makeAnthropicLlm", () => {
  it("calls the SDK with the built params and maps the result", async () => {
    const create = vi.fn(async () => message({}));
    const llm = makeAnthropicLlm({ model: "claude-haiku-5-5", create });

    const result = await llm({ ...base, effort: "low" });

    expect(create).toHaveBeenCalledWith(buildParams("claude-haiku-5-5", { ...base, effort: "low" }));
    expect(result.ok && result.value.kind === "text" && result.value.text).toBe("Hello");
  });

  it("returns SDK errors as values without the key", async () => {
    const llm = makeAnthropicLlm({
      model: "claude-haiku-5-5",
      apiKey: SECRET_KEY,
      create: async () => {
        throw APIError.generate(401, {}, "invalid x-api-key", new Headers());
      },
    });
    const result = await llm(base);
    expect(!result.ok && result.error.kind).toBe("auth");
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });
});

describe("makeLlm", () => {
  it("builds the Anthropic provider when its key is present", () => {
    expect(makeLlm({ provider: "anthropic", model: "claude-haiku-5-5" }, { anthropic: SECRET_KEY }).ok).toBe(true);
  });

  it("refuses without a key", () => {
    expect(makeLlm({ provider: "anthropic", model: "claude-haiku-5-5" }, {})).toEqual({
      ok: false,
      error: "No API key for provider anthropic",
    });
  });
});

describe("streaming (#72)", () => {
  const collect = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const d of it) out.push(d);
    return out;
  };

  it("yields text deltas as they arrive, then the full response", async () => {
    const streamMessage = vi.fn<StreamMessage>(() => ({
      deltas: (async function* () {
        yield "Hel";
        yield "lo there.";
      })(),
      final: async () => message({ content: [{ type: "text", text: "Hello there." }] } as Partial<Message>),
    }));
    const llm = makeAnthropicLlm({ model: "claude-sonnet-5-5", streamMessage });
    expect(llm.stream).toBeDefined();
    const streamed = llm.stream?.(base);
    expect(await collect(streamed?.text ?? (async function* () {})())).toEqual(["Hel", "lo there."]);
    expect(await streamed?.result).toMatchObject({ ok: true, value: { kind: "text", text: "Hello there." } });
    expect(streamMessage.mock.calls[0]?.[0]).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default" });
  });

  it("reports an abort as `aborted`, and an already-aborted signal makes no call", async () => {
    const controller = new AbortController();
    const streamMessage = vi.fn<StreamMessage>(() => ({
      deltas: (async function* () {
        yield "Hel";
        throw new Error("stream torn down");
      })(),
      final: async () => {
        throw new Error("aborted by the client");
      },
    }));
    const llm = makeAnthropicLlm({ model: "claude-sonnet-5-5", streamMessage });
    const streamed = llm.stream?.(base, controller.signal);
    controller.abort();
    expect(await collect(streamed?.text ?? (async function* () {})())).toEqual(["Hel"]); // errors end the text quietly
    expect(await streamed?.result).toEqual({ ok: false, error: { kind: "aborted", message: "Cancelled", retryable: false } });

    const before = llm.stream?.(base, controller.signal);
    expect(await before?.result).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(streamMessage).toHaveBeenCalledTimes(1);
  });

  it("maps other stream errors like a normal call, and never includes the key", async () => {
    const llm = makeAnthropicLlm({
      model: "claude-sonnet-5-5",
      apiKey: SECRET_KEY,
      streamMessage: () => ({
        deltas: (async function* () {})(),
        final: async () => {
          throw new APIConnectionError({ message: "down" });
        },
      }),
    });
    const result = await llm.stream?.(base).result;
    expect(result).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it("streamOrCall falls back to one chunk for a provider without streaming", async () => {
    const plain = Object.assign(async () => ({ ok: true as const, value: { kind: "text" as const, text: "Whole answer.", servedBy: "x", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "x", data: null } } }), {});
    const streamed = streamOrCall(plain, base);
    expect(await collect(streamed.text)).toEqual(["Whole answer."]);
    expect(await streamed.result).toMatchObject({ ok: true });
    const aborted = new AbortController();
    aborted.abort();
    expect(await streamOrCall(plain, base, aborted.signal).result).toMatchObject({ ok: false, error: { kind: "aborted" } });
  });
});
