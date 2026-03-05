import Anthropic from "@anthropic-ai/sdk";
import { LanguageModelProvider, SendMessageOptions } from "./types.js";

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

  public async sendMessage(systemPrompt: string, userMessage: string, options: SendMessageOptions): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.client.messages.create({
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

        const textBlocks = response.content.filter((block) => block.type === "text");
        const text = textBlocks.map((block) => block.text).join("\n").trim();
        if (text.length === 0) {
          throw new Error("Model returned an empty response.");
        }
        return text;
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
}
