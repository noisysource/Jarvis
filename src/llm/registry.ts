// Picks the provider for a configured model. Adding a provider means one new
// module plus one case here (and its name in model-ref.ts).

import { err, ok, type Result } from "../result.js";
import { makeAnthropicLlm } from "./anthropic.js";
import type { ModelRef, Provider } from "./model-ref.js";
import type { LlmCall } from "./types.js";

/** API keys per provider, resolved at startup (see secrets.ts). */
export type ProviderKeys = Readonly<Partial<Record<Provider, string>>>;

export const makeLlm = (ref: ModelRef, keys: ProviderKeys): Result<LlmCall, string> => {
  switch (ref.provider) {
    case "anthropic": {
      const apiKey = keys.anthropic;
      return apiKey ? ok(makeAnthropicLlm({ model: ref.model, apiKey })) : err("No API key for provider anthropic");
    }
  }
};
