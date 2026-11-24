/** The one thing the agent needs from a model. WebLLM implements it in the browser; tests use a script. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  /** When set, decoding is constrained to JSON matching this schema. */
  schema?: object;
  temperature?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  prefillTokensPerS: number;
  decodeTokensPerS: number;
  seconds: number;
}

export interface ChatResult {
  text: string;
  finish: "stop" | "length" | "other";
  usage: ChatUsage;
}

export interface LLM {
  readonly model: string;
  chat(req: ChatRequest, onToken?: (soFar: string) => void): Promise<ChatResult>;
}

/** Thrown by an LLM when the prompt doesn't fit the context window. The agent retries with less. */
export class ContextOverflow extends Error {}
