export type ProviderName = "anthropic" | "openai";

export interface SendMessageOptions {
  model: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
}

export interface SendWithToolsOptions extends SendMessageOptions {
  tools: ToolDefinition[];
}

export interface ProviderToolResponse {
  textContent: string;
  toolUseBlocks: ToolUseBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | string;
}

export interface ConversationContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface ConversationBlock {
  role: "user" | "assistant";
  content: string | ConversationContentBlock[];
}

export interface LanguageModelProvider {
  readonly name: ProviderName;
  sendMessage(systemPrompt: string, userMessage: string, options: SendMessageOptions): Promise<string>;
  sendWithTools(
    systemPrompt: string,
    messages: ConversationBlock[],
    options: SendWithToolsOptions
  ): Promise<ProviderToolResponse>;
}
