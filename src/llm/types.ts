// Provider-neutral LLM types. Everything outside src/llm/ talks to models
// only through `LlmCall`, so adding a provider (Gemini, Grok, ...) means
// adding one module and one registry entry. No vendor SDK types appear here.

import type { Result } from "../result.js";

/** A JSON Schema for an object. Tool and output schemas should set `additionalProperties: false`. */
export type JsonObjectSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly [key: string]: unknown;
};

export type LlmTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
};

export type LlmToolCall = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

export type LlmToolResult = {
  readonly callId: string;
  readonly content: string;
  readonly isError?: boolean;
};

/**
 * Opaque provider data on an assistant turn. Pass it back unchanged in the
 * next request (e.g. Anthropic thinking blocks must round-trip as-is in a
 * tool loop). Only the provider that produced it reads it.
 */
export type ProviderPayload = {
  readonly provider: string;
  readonly data: unknown;
};

export type LlmMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "user"; readonly toolResults: readonly LlmToolResult[] }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls?: readonly LlmToolCall[];
      readonly payload?: ProviderPayload;
    };

export type Effort = "low" | "medium" | "high";

export type LlmRequest = {
  readonly system: string;
  /** Mark the system prompt as cacheable (it must be stable across requests). */
  readonly cacheSystem?: boolean;
  /**
   * Text appended after `system` and never cached, for parts that change on
   * every request (e.g. the current time), so they don't break the cache.
   */
  readonly systemSuffix?: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmTool[];
  /** Ask for JSON matching this schema; the response is then `kind: "json"`. */
  readonly outputSchema?: JsonObjectSchema;
  readonly effort?: Effort;
  readonly maxTokens: number;
};

export type LlmUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

type ResponseCommon = {
  /** The model that actually answered (differs from the requested one after a fallback). */
  readonly servedBy: string;
  readonly usage: LlmUsage;
  /** Pass back on the assistant message if the conversation continues. */
  readonly payload: ProviderPayload;
};

export type LlmResponse =
  | (ResponseCommon & { readonly kind: "text"; readonly text: string })
  | (ResponseCommon & { readonly kind: "json"; readonly value: unknown })
  | (ResponseCommon & {
      readonly kind: "tool_calls";
      readonly text: string;
      readonly calls: readonly LlmToolCall[];
    });

export type LlmErrorKind =
  | "refused"
  | "max_tokens"
  | "invalid_output"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "auth"
  | "bad_request"
  /** The caller cancelled the request (e.g. the user interrupted a spoken answer). */
  | "aborted"
  | "unknown";

/** `message` is for logs: it never contains API keys or prompt contents. */
export type LlmError = {
  readonly kind: LlmErrorKind;
  readonly message: string;
  /** Worth retrying later (the SDK has already retried transient errors). */
  readonly retryable: boolean;
  /** Safe to show the person, when the fix is theirs (e.g. "start Ollama"). */
  readonly userMessage?: string;
};

/**
 * A streamed call: `text` yields the answer's text as it arrives, and
 * `result` settles with the full response once it ends (or the error, or
 * `aborted` when `signal` fires). Reading `text` is optional; `result` alone
 * is enough to wait for the end.
 */
export type LlmStreamed = {
  readonly text: AsyncIterable<string>;
  readonly result: Promise<Result<LlmResponse, LlmError>>;
};

export type LlmStream = (request: LlmRequest, signal?: AbortSignal) => LlmStreamed;

/**
 * One model call. Providers that can stream also carry `stream`; callers
 * use `streamOrCall` (src/llm/stream.ts), which falls back to one chunk.
 */
export type LlmCall = ((request: LlmRequest) => Promise<Result<LlmResponse, LlmError>>) & {
  readonly stream?: LlmStream;
};
