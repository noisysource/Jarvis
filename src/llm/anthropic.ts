// Anthropic provider: maps the provider-neutral LlmRequest to the Messages
// API and back. All Anthropic SDK types stay inside this file.

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { err, ok, type Result } from "../result.js";
import type {
  LlmCall,
  LlmStream,
  LlmError,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  ProviderPayload,
} from "./types.js";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** The one SDK call this provider makes; injected so tests can stub it. */
export type CreateMessage = (params: CreateParams) => Promise<Message>;

/** The streaming SDK call: text deltas as they arrive, then the full message. Injected so tests can stub it. */
export type StreamMessage = (
  params: CreateParams,
  signal?: AbortSignal,
) => { readonly deltas: AsyncIterable<string>; readonly final: () => Promise<Message> };

const PROVIDER = "anthropic";

/**
 * Models that support the server-side refusal fallback (`fallbacks: "default"`).
 * Claude Haiku 5.5 has none, so its requests never carry the parameter.
 */
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const payloadOf = (content: Message["content"]): ProviderPayload => ({ provider: PROVIDER, data: content });

const toMessageParam = (message: LlmMessage): MessageParam => {
  if (message.role === "user") {
    return "text" in message
      ? { role: "user", content: message.text }
      : {
          role: "user",
          content: message.toolResults.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.callId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
  }
  // Our own earlier response: send its content back unchanged (thinking blocks included).
  if (message.payload?.provider === PROVIDER && Array.isArray(message.payload.data)) {
    return { role: "assistant", content: message.payload.data as ContentBlockParam[] };
  }
  const blocks: ContentBlockParam[] = [
    ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
    ...(message.toolCalls ?? []).map((c) => ({
      type: "tool_use" as const,
      id: c.id,
      name: c.name,
      input: c.input as Record<string, unknown>,
    })),
  ];
  return { role: "assistant", content: blocks.length > 0 ? blocks : message.text };
};

export const buildParams = (model: string, request: LlmRequest): CreateParams => ({
  model,
  max_tokens: request.maxTokens,
  system:
    request.cacheSystem || request.systemSuffix
      ? [
          {
            type: "text" as const,
            text: request.system,
            ...(request.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
          ...(request.systemSuffix ? [{ type: "text" as const, text: request.systemSuffix }] : []),
        ]
      : request.system,
  messages: request.messages.map(toMessageParam),
  ...(request.tools && request.tools.length > 0
    ? {
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
          strict: true,
        })),
      }
    : {}),
  ...(request.effort || request.outputSchema
    ? {
        output_config: {
          ...(request.effort ? { effort: request.effort } : {}),
          ...(request.outputSchema
            ? { format: { type: "json_schema" as const, schema: { ...request.outputSchema } } }
            : {}),
        },
      }
    : {}),
  ...(SERVER_FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
});

export const mapResponse = (message: Message, wantsJson: boolean): Result<LlmResponse, LlmError> => {
  const common = {
    servedBy: message.model,
    payload: payloadOf(message.content),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
  const text = message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();

  switch (message.stop_reason) {
    case "refusal": {
      const category = message.stop_details?.category;
      return err({
        kind: "refused",
        message: `The model declined${category ? ` (category: ${category})` : ""}`,
        retryable: false,
      });
    }
    case "max_tokens":
    case "model_context_window_exceeded":
      return err({ kind: "max_tokens", message: `Output was cut off (${message.stop_reason})`, retryable: false });
    case "tool_use": {
      const calls: LlmToolCall[] = message.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      return ok({ ...common, kind: "tool_calls", text, calls });
    }
    case "end_turn":
    case "stop_sequence":
    case null: {
      if (!wantsJson) return ok({ ...common, kind: "text", text });
      try {
        return ok({ ...common, kind: "json", value: JSON.parse(text) as unknown });
      } catch {
        return err({ kind: "invalid_output", message: "The model's JSON output didn't parse", retryable: false });
      }
    }
    default:
      return err({ kind: "unknown", message: `Unexpected stop reason: ${message.stop_reason}`, retryable: false });
  }
};

/** Most specific SDK error class first. Messages never include the API key or prompt. */
export const mapError = (e: unknown): LlmError => {
  if (e instanceof APIUserAbortError) return { kind: "aborted", message: "Cancelled", retryable: false };
  if (e instanceof APIConnectionTimeoutError) return { kind: "timeout", message: "Anthropic API timed out", retryable: true };
  if (e instanceof APIConnectionError) return { kind: "network", message: "Couldn't reach the Anthropic API", retryable: true };
  if (e instanceof RateLimitError) return { kind: "rate_limited", message: "Anthropic API rate limit hit", retryable: true };
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
    return { kind: "auth", message: `Anthropic API rejected the key (${e.status})`, retryable: false };
  }
  if (e instanceof BadRequestError || e instanceof NotFoundError) {
    return { kind: "bad_request", message: `Anthropic API rejected the request (${e.status}): ${e.message}`, retryable: false };
  }
  if (e instanceof InternalServerError) {
    return { kind: "server", message: `Anthropic API error (${e.status})`, retryable: true };
  }
  if (e instanceof APIError) {
    const server = typeof e.status === "number" && e.status >= 500;
    return { kind: server ? "server" : "bad_request", message: `Anthropic API error (${e.status})`, retryable: server };
  }
  return { kind: "unknown", message: e instanceof Error ? e.message : String(e), retryable: false };
};

const ABORTED: LlmError = { kind: "aborted", message: "Cancelled", retryable: false };

export const makeAnthropicLlm = (deps: {
  readonly model: string;
  readonly apiKey?: string;
  /** For tests; defaults to the real SDK client. */
  readonly create?: CreateMessage;
  readonly streamMessage?: StreamMessage;
}): LlmCall => {
  let client: Anthropic | undefined;
  const sdk = (): Anthropic => (client ??= new Anthropic({ apiKey: deps.apiKey, timeout: 60_000, maxRetries: 2 }));
  const create: CreateMessage = deps.create ?? ((params) => sdk().beta.messages.create(params));
  const streamMessage: StreamMessage =
    deps.streamMessage ??
    ((params, signal) => {
      const s = sdk().beta.messages.stream(params, signal ? { signal } : {});
      return {
        deltas: (async function* () {
          for await (const event of s) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
          }
        })(),
        final: () => s.finalMessage(),
      };
    });

  const call = async (request: LlmRequest) => {
    try {
      return mapResponse(await create(buildParams(deps.model, request)), request.outputSchema !== undefined);
    } catch (e) {
      return err(mapError(e));
    }
  };

  const stream: LlmStream = (request, signal) => {
    if (signal?.aborted) {
      return { text: (async function* () {})(), result: Promise.resolve(err(ABORTED)) };
    }
    let run: ReturnType<StreamMessage>;
    try {
      run = streamMessage(buildParams(deps.model, request), signal);
    } catch (e) {
      return { text: (async function* () {})(), result: Promise.resolve(err(mapError(e))) };
    }
    const result = (async () => {
      try {
        return mapResponse(await run.final(), request.outputSchema !== undefined);
      } catch (e) {
        return err(signal?.aborted ? ABORTED : mapError(e));
      }
    })();
    return {
      result,
      // Errors end the text quietly; they're reported once, through `result`.
      text: (async function* () {
        try {
          for await (const delta of run.deltas) yield delta;
        } catch {
          /* see result */
        }
      })(),
    };
  };

  return Object.assign(call, { stream });
};
