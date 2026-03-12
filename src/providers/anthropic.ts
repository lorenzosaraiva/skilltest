import Anthropic from "@anthropic-ai/sdk";
import {
  ConversationBlock,
  ConversationContentBlock,
  LanguageModelProvider,
  ProviderToolResponse,
  SendMessageOptions,
  SendWithToolsOptions
} from "./types.js";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string; [key: string]: unknown };

interface AnthropicMessageResponse {
  content: AnthropicResponseBlock[];
  stop_reason: string | null;
}

function isAnthropicTextBlock(block: AnthropicResponseBlock): block is AnthropicTextBlock {
  return block.type === "text";
}

function isAnthropicToolUseBlock(block: AnthropicResponseBlock): block is AnthropicToolUseBlock {
  return block.type === "tool_use";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeStatus = (error as { status?: number }).status;
  if (maybeStatus === 429) {
    return true;
  }

  const maybeMessage = (error as { message?: string }).message;
  if (typeof maybeMessage === "string" && /rate limit/i.test(maybeMessage)) {
    return true;
  }

  return false;
}

export class AnthropicProvider implements LanguageModelProvider {
  public readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  public constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async createMessage(
    request: Record<string, unknown>
  ): Promise<AnthropicMessageResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return (await this.client.messages.create(request as never)) as unknown as AnthropicMessageResponse;
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error) || attempt === 2) {
          break;
        }

        const delay = Math.min(4000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await wait(delay);
      }
    }

    if (lastError instanceof Error) {
      throw new Error(`Anthropic API call failed: ${lastError.message}`);
    }
    throw new Error("Anthropic API call failed with an unknown error.");
  }

  private toAnthropicMessages(messages: ConversationBlock[]): Array<{
    role: "user" | "assistant";
    content: string | ConversationContentBlock[];
  }> {
    return messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
  }

  public async sendMessage(systemPrompt: string, userMessage: string, options: SendMessageOptions): Promise<string> {
    const response = await this.createMessage({
      model: options.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const textBlocks = response.content.filter(isAnthropicTextBlock);
    const text = textBlocks.map((block) => block.text).join("\n").trim();
    if (text.length === 0) {
      throw new Error("Model returned an empty response.");
    }
    return text;
  }

  public async sendWithTools(
    systemPrompt: string,
    messages: ConversationBlock[],
    options: SendWithToolsOptions
  ): Promise<ProviderToolResponse> {
    const response = await this.createMessage({
      model: options.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: this.toAnthropicMessages(messages),
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown> & { type: string }
      }))
    });

    const textContent = response.content
      .filter(isAnthropicTextBlock)
      .map((block) => block.text)
      .join("\n")
      .trim();

    const toolUseBlocks = response.content
      .filter(isAnthropicToolUseBlock)
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input
      }));

    return {
      textContent,
      toolUseBlocks,
      stopReason: response.stop_reason ?? "end_turn"
    };
  }
}
