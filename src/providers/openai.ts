import { LanguageModelProvider, SendMessageOptions } from "./types.js";

export class OpenAIProvider implements LanguageModelProvider {
  public readonly name = "openai" as const;
  private readonly _apiKey: string;

  public constructor(apiKey: string) {
    this._apiKey = apiKey;
  }

  public async sendMessage(_systemPrompt: string, _userMessage: string, _options: SendMessageOptions): Promise<string> {
    void this._apiKey;
    throw new Error("OpenAI provider coming soon.");
  }
}
