// "provider:model" strings from config, e.g. "anthropic:claude-haiku-5-5".
// Adding a provider (Gemini, Grok, ...) means adding it here and writing its
// provider module (#10); nothing else reads provider names.

import { err, ok, type Result } from "../result.js";

export const PROVIDERS = ["anthropic", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

export type ModelRef = {
  readonly provider: Provider;
  readonly model: string;
};

const isProvider = (value: string): value is Provider =>
  (PROVIDERS as readonly string[]).includes(value);

export const parseModelRef = (value: string): Result<ModelRef, string> => {
  const separator = value.indexOf(":");
  const provider = separator === -1 ? "" : value.slice(0, separator).trim();
  const model = separator === -1 ? "" : value.slice(separator + 1).trim();

  if (provider === "" || model === "") {
    return err(`expected "provider:model" (e.g. "anthropic:claude-sonnet-5-5"), got "${value}"`);
  }
  if (!isProvider(provider)) {
    return err(`unknown provider "${provider}" (known: ${PROVIDERS.join(", ")})`);
  }
  if (/\s/.test(model)) {
    return err(`model name can't contain spaces, got "${model}"`);
  }
  return ok({ provider, model });
};

export const formatModelRef = (ref: ModelRef): string => `${ref.provider}:${ref.model}`;
