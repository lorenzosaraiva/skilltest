export type ProviderName = "anthropic" | "openai";

export function resolveApiKey(provider: ProviderName, override?: string): string {
  if (override && override.trim() !== "") {
    return override.trim();
  }

  if (provider === "anthropic") {
    const envValue = process.env.ANTHROPIC_API_KEY?.trim();
    if (envValue) {
      return envValue;
    }
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY environment variable or pass --api-key flag."
    );
  }

  const envValue = process.env.OPENAI_API_KEY?.trim();
  if (envValue) {
    return envValue;
  }
  throw new Error("No OpenAI API key found. Set OPENAI_API_KEY environment variable or pass --api-key flag.");
}
