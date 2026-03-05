import { LanguageModelProvider, SendMessageOptions } from "./types.js";

type OpenAIClient = {
  chat: {
    completions: {
      create(input: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        max_tokens?: number;
      }): Promise<{
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        }>;
      }>;
    };
  };
};

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

  public async sendMessage(systemPrompt: string, userMessage: string, options: SendMessageOptions): Promise<string> {
    const client = await this.ensureClient();
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await client.chat.completions.create({
          model: options.model,
          max_tokens: 2048,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userMessage
            }
          ]
        });

        const text = (response.choices ?? [])
          .map((choice) => extractTextContent(choice.message?.content))
          .join("\n")
          .trim();

        if (text.length === 0) {
          throw new Error("Model returned an empty response.");
        }

        return text;
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
}
