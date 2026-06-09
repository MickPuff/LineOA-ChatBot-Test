import { GoogleGenAI } from '@google/genai';

export class GeminiChat {
  constructor({ apiKey, model }) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async reply(history, userText, systemInstruction) {
    const chat = this.client.chats.create({
      model: this.model,
      history: history.map(toGeminiMessage),
      config: {
        systemInstruction,
      },
    });

    const response = await chat.sendMessage({ message: userText });
    const text = response.text?.trim();

    if (!text) {
      throw new Error('Gemini returned an empty response.');
    }

    return {
      text,
      usage: normalizeUsage(response.usageMetadata),
    };
  }
}

function toGeminiMessage(message) {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.text }],
  };
}

function normalizeUsage(usageMetadata = {}) {
  const inputTokens = Number(usageMetadata.promptTokenCount || 0);
  const outputTokens = Number(usageMetadata.candidatesTokenCount || 0);
  const totalTokens = Number(usageMetadata.totalTokenCount || inputTokens + outputTokens || 0);

  if (!inputTokens && !outputTokens && !totalTokens) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}
