import OpenAI from "openai";
import type { Settings } from "../config/settings";
import type { ChatMessage, ToolCall, Usage } from "../types";

export interface StreamCallbacks {
  onTextDelta?: (delta: string) => void;
  /** --reasoning-parser qwen3 streams think-block tokens separately */
  onReasoningDelta?: (delta: string) => void;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Rough token estimate (chars/4), recalibrated by real usage when available. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 8;
    if (typeof m.content === "string") total += estimateTokens(m.content);
    if ("tool_calls" in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.type === "function") {
          total += estimateTokens(tc.function.name + tc.function.arguments);
        }
      }
    }
  }
  return total;
}

export class LlmClient {
  private client: OpenAI;
  private settings: Settings;
  /** prompt tokens reported by vLLM for the latest request — feeds the statusline. */
  lastPromptTokens = 0;

  constructor(settings: Settings) {
    this.settings = settings;
    this.client = new OpenAI({
      baseURL: settings.baseURL,
      apiKey: process.env[settings.apiKeyEnv] ?? "none",
      timeout: 600_000,
      maxRetries: 1,
    });
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks = {},
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const s = this.settings;
    const stream = await this.client.chat.completions.create(
      {
        model: s.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: s.temperature,
        top_p: s.topP,
        max_tokens: s.maxTokens,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
        // vLLM extensions, passed through the OpenAI client untyped
        ...(this.vllmExtras() as Record<string, never>),
      },
      { signal },
    );

    let text = "";
    let usage: Usage | null = null;
    // tool call fragments arrive as deltas keyed by index
    const toolFrags = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      // qwen3 reasoning parser: think tokens arrive in a separate field
      // ("reasoning" on current vLLM, "reasoning_content" on older builds);
      // content stays empty until the think block closes — never treat that
      // as an empty reply and never scan it for tool calls
      const d = delta as Record<string, unknown> | undefined;
      const reasoning = d?.["reasoning"] ?? d?.["reasoning_content"];
      if (typeof reasoning === "string" && reasoning) {
        callbacks.onReasoningDelta?.(reasoning);
      }
      if (delta?.content) {
        text += delta.content;
        callbacks.onTextDelta?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const frag = toolFrags.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) frag.id = tc.id;
        if (tc.function?.name) frag.name += tc.function.name;
        if (tc.function?.arguments) frag.args += tc.function.arguments;
        toolFrags.set(tc.index, frag);
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
    }

    if (usage) this.lastPromptTokens = usage.promptTokens;

    const toolCalls: ToolCall[] = [...toolFrags.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, f]) => ({
        id: f.id || `call_${i}`,
        type: "function" as const,
        function: { name: f.name, arguments: f.args },
      }));

    return { text, toolCalls, usage };
  }

  /** Single-shot, no tools, no streaming — used by memory extractor / compactor. */
  async oneShot(system: string, user: string, maxTokens = 4096): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.settings.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
      ...(this.vllmExtras() as Record<string, never>),
    });
    return res.choices[0]?.message?.content ?? "";
  }

  /** vLLM-specific request fields the OpenAI client doesn't type. */
  private vllmExtras(): Record<string, unknown> {
    const s = this.settings;
    return {
      top_k: s.topK,
      presence_penalty: s.presencePenalty,
      repetition_penalty: s.repetitionPenalty,
      chat_template_kwargs: { enable_thinking: s.enableThinking },
    };
  }
}
