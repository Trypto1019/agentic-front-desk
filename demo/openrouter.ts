import type { ChatClient, ChatMessage, ToolCall } from "../src/agent/llm.ts";

/**
 * Optional real-model client (OpenRouter, OpenAI-compatible API).
 * Used only when OPENROUTER_API_KEY is set and --mock is not passed.
 */
export function openRouterChat(apiKey: string, baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"): ChatClient {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          parallel_tool_calls: request.parallelToolCalls,
        }),
      });
      if (!response.ok) throw new Error(`openrouter_http_${response.status}`);
      const data = (await response.json()) as { model: string; choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }> };
      const message = data.choices[0]?.message ?? { content: "" };
      const toolCalls = message.tool_calls ?? [];
      const content = message.content ?? "";
      const assistant: ChatMessage = toolCalls.length ? { role: "assistant", content, tool_calls: toolCalls } : { role: "assistant", content };
      return { content, toolCalls, modelName: data.model, message: assistant };
    } finally {
      clearTimeout(timer);
    }
  };
}
