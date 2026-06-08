import { GoogleGenAI } from '@google/genai';

export class GeminiChat {
  constructor({ apiKey, model, systemInstruction }) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
    this.systemInstruction = systemInstruction;
  }

  async reply(history, userText) {
    const chat = this.client.chats.create({
      model: this.model,
      history: history.map(toGeminiMessage),
      config: {
        systemInstruction: this.systemInstruction,
      },
    });

    const response = await chat.sendMessage({ message: userText });
    const text = response.text?.trim();

    if (!text) {
      throw new Error('Gemini returned an empty response.');
    }

    return text;
  }
}

function toGeminiMessage(message) {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.text }],
  };
}
