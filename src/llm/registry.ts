// Picks the provider for a configured model. Adding a provider means one new
// module plus one case here (and its name in model-ref.ts).

import { err, ok, type Result } from "../result.js";
import { makeAnthropicLlm } from "./anthropic.js";
import { makeOllamaLlm } from "./ollama.js";
import type { ModelRef, Provider } from "./model-ref.js";
import type { LlmCall } from "./types.js";

/** API keys per provider, resolved at startup (see secrets.ts). */
export type ProviderKeys = Readonly<Partial<Record<Provider, string>>>;

/** Where local providers run (#88): always this machine (checked in config). `ollamaThink`: Ollama's `think`. */
export type ProviderUrls = { readonly ollama?: URL; readonly ollamaThink?: boolean };

export const DEFAULT_OLLAMA_URL = new URL("http://127.0.0.1:11434");

export const makeLlm = (ref: ModelRef, keys: ProviderKeys, urls: ProviderUrls = {}): Result<LlmCall, string> => {
  switch (ref.provider) {
    case "anthropic": {
      const apiKey = keys.anthropic;
      return apiKey ? ok(makeAnthropicLlm({ model: ref.model, apiKey })) : err("No API key for provider anthropic");
    }
    case "ollama":
      return ok(
        makeOllamaLlm({
          model: ref.model,
          baseUrl: urls.ollama ?? DEFAULT_OLLAMA_URL,
          ...(urls.ollamaThink !== undefined ? { think: urls.ollamaThink } : {}),
        }),
      );
  }
};
