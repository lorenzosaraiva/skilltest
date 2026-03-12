import {
  ConversationBlock,
  ConversationContentBlock,
  LanguageModelProvider,
  ProviderToolResponse,
  SendMessageOptions,
  SendWithToolsOptions
} from "./types.js";

type OpenAIClient = {
  chat: {
    completions: {
      create(input: {
        model: string;
        messages: OpenAIMessage[];
        max_tokens?: number;
        tools?: Array<{
          type: "function";
          function: {
            name: string;
            description: string;
            parameters?: Record<string, unknown>;
          };
        }>;
      }): Promise<{
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
            tool_calls?: Array<{
              id?: string;
              function?: {
                name?: string;
                arguments?: string;
              };
            }>;
          };
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
};

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: OpenAIAssistantToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetriableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeStatus = (error as { status?: number }).status;
  if (maybeStatus === 429 || (typeof maybeStatus === "number" && maybeStatus >= 500)) {
    return true;
  }

  const maybeCode = (error as { code?: string }).code;
  if (typeof maybeCode === "string" && /timeout|econnreset|enotfound|eai_again/i.test(maybeCode)) {
    return true;
  }

  const maybeMessage = (error as { message?: string }).message;
  if (typeof maybeMessage === "string" && /(rate limit|timeout|temporarily unavailable|connection)/i.test(maybeMessage)) {
    return true;
  }

  return false;
}

function extractTextContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content.trim();
  }

  const text = content
    .map((item) => (item.type === "text" || !item.type ? item.text ?? "" : ""))
    .join("\n")
    .trim();
  return text;
}

function parseToolArguments(raw: string | undefined, toolName: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI tool call arguments for '${toolName}' were not valid JSON: ${message}`);
  }
}

function getBlockText(blocks: ConversationContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
}

function mapAssistantBlocksToMessage(blocks: ConversationContentBlock[]): OpenAIMessage {
  const textContent = getBlockText(blocks);
  const toolCalls = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: String(block.id ?? ""),
      type: "function" as const,
      function: {
        name: String(block.name ?? ""),
        arguments: JSON.stringify(block.input ?? {})
      }
    }));

  return {
    role: "assistant",
    content: textContent.length > 0 ? textContent : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

function mapUserBlocksToMessages(blocks: ConversationContentBlock[]): OpenAIMessage[] {
  const toolResults = blocks.filter((block) => block.type === "tool_result");
  if (toolResults.length > 0) {
    return toolResults.map((block) => ({
      role: "tool",
      tool_call_id: String(block.tool_use_id ?? ""),
      content: String(block.content ?? "")
    }));
  }

  const textContent = getBlockText(blocks);
  return [
    {
      role: "user",
      content: textContent
    }
  ];
}

function mapConversationBlockToMessages(block: ConversationBlock): OpenAIMessage[] {
  if (typeof block.content === "string") {
    return [
      {
        role: block.role,
        content: block.content
      }
    ];
  }

  if (block.role === "assistant") {
    return [mapAssistantBlocksToMessage(block.content)];
  }

  return mapUserBlocksToMessages(block.content);
}

export class OpenAIProvider implements LanguageModelProvider {
  public readonly name = "openai" as const;
  private readonly apiKey: string;
  private client: OpenAIClient | null;

  public constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = null;
  }

  private async ensureClient(): Promise<OpenAIClient> {
    if (this.client) {
      return this.client;
    }

    let openAiModule: unknown;
    try {
      const moduleName = "openai";
      openAiModule = await import(moduleName);
    } catch {
      throw new Error(
        "OpenAI SDK is not installed. Install optional dependency 'openai' or run 'npm install' with optional dependencies enabled."
      );
    }

    const OpenAIConstructor = (openAiModule as { default?: new (config: { apiKey: string }) => OpenAIClient }).default;
    if (!OpenAIConstructor) {
      throw new Error("OpenAI SDK loaded but no default client export was found.");
    }

    this.client = new OpenAIConstructor({ apiKey: this.apiKey });
    return this.client;
  }

  private async createCompletion(
    input: Parameters<OpenAIClient["chat"]["completions"]["create"]>[0]
  ): Promise<Awaited<ReturnType<OpenAIClient["chat"]["completions"]["create"]>>> {
    const client = await this.ensureClient();
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.chat.completions.create(input);
      } catch (error) {
        lastError = error;
        if (!isRetriableError(error) || attempt === 2) {
          break;
        }

        const delay = Math.min(4000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await wait(delay);
      }
    }

    if (lastError instanceof Error) {
      throw new Error(`OpenAI API call failed: ${lastError.message}`);
    }
    throw new Error("OpenAI API call failed with an unknown error.");
  }

  private toOpenAiMessages(systemPrompt: string, messages: ConversationBlock[]): OpenAIMessage[] {
    return [
      {
        role: "system",
        content: systemPrompt
      },
      ...messages.flatMap((message) => mapConversationBlockToMessages(message))
    ];
  }

  public async sendMessage(systemPrompt: string, userMessage: string, options: SendMessageOptions): Promise<string> {
    const response = await this.createCompletion({
      model: options.model,
      max_tokens: 2048,
      messages: this.toOpenAiMessages(systemPrompt, [{ role: "user", content: userMessage }])
    });

    const text = (response.choices ?? [])
      .map((choice) => extractTextContent(choice.message?.content))
      .join("\n")
      .trim();

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
    const response = await this.createCompletion({
      model: options.model,
      max_tokens: 2048,
      messages: this.toOpenAiMessages(systemPrompt, messages),
      tools: options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
    });

    const choice = response.choices?.[0];
    const message = choice?.message;
    const toolUseBlocks = (message?.tool_calls ?? []).map((toolCall, index) => {
      const toolName = toolCall.function?.name ?? `tool-${index + 1}`;
      return {
        id: toolCall.id ?? `${toolName}-${index + 1}`,
        name: toolName,
        arguments: parseToolArguments(toolCall.function?.arguments, toolName)
      };
    });

    return {
      textContent: extractTextContent(message?.content),
      toolUseBlocks,
      stopReason:
        choice?.finish_reason === "stop"
          ? "end_turn"
          : choice?.finish_reason === "tool_calls"
            ? "tool_use"
            : choice?.finish_reason ?? "end_turn"
    };
  }
}
