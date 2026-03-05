import { resolveApiKey } from "../utils/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { LanguageModelProvider, ProviderName } from "./types.js";

export function createProvider(providerName: ProviderName, apiKeyOverride?: string): LanguageModelProvider {
  const apiKey = resolveApiKey(providerName, apiKeyOverride);
  if (providerName === "anthropic") {
    return new AnthropicProvider(apiKey);
  }
  return new OpenAIProvider(apiKey);
}

export type { LanguageModelProvider, ProviderName };
