export type ProviderName = "anthropic" | "openai";

export interface SendMessageOptions {
  model: string;
}

export interface LanguageModelProvider {
  readonly name: ProviderName;
  sendMessage(systemPrompt: string, userMessage: string, options: SendMessageOptions): Promise<string>;
}
