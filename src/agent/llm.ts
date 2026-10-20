/** Minimal OpenAI-compatible chat types (OpenRouter speaks this shape). */

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Always false: one tool call at a time keeps every mutation sequential and auditable. */
  parallelToolCalls: false;
};

export type ChatResponse = {
  content: string;
  toolCalls: ToolCall[];
  modelName: string;
  message: ChatMessage;
  costUsd?: number;
};

export type ChatClient = (request: ChatRequest) => Promise<ChatResponse>;

export function assistantMessage(content: string, toolCalls: ToolCall[] = []): ChatMessage {
  return toolCalls.length ? { role: "assistant", content, tool_calls: toolCalls } : { role: "assistant", content };
}
