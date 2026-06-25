import OpenAI from "openai";
import type { Settings } from "../config/settings";
import type { InferenceProfile } from "./profiles";
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

/**
 * Stream splitter for models that leak `<think>…</think>` into `content`
 * instead of the separate reasoning field. Text inside think tags is sent to
 * `onReason` (rendered dimmed) and kept out of the answer; a stray `</think>`
 * with no opener is dropped. Tags split across chunk boundaries are buffered:
 * a trailing partial that could begin a tag is held back until the next chunk.
 */
export function makeThinkFilter(onText: (s: string) => void, onReason: (s: string) => void) {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inThink = false;
  let buf = "";
  // longest suffix of `s` that is a nonempty prefix of OPEN or CLOSE — the part
  // we must hold back because it might be the start of a tag finishing next chunk
  const heldTail = (s: string): number => {
    const max = Math.min(s.length, CLOSE.length - 1);
    for (let k = max; k > 0; k--) {
      const suf = s.slice(s.length - k);
      if (OPEN.startsWith(suf) || CLOSE.startsWith(suf)) return k;
    }
    return 0;
  };
  const feed = (chunk: string): void => {
    buf += chunk;
    for (;;) {
      if (inThink) {
        const i = buf.indexOf(CLOSE);
        if (i === -1) {
          const hold = heldTail(buf);
          const emit = buf.slice(0, buf.length - hold);
          if (emit) onReason(emit);
          buf = buf.slice(buf.length - hold);
          return;
        }
        if (i > 0) onReason(buf.slice(0, i));
        buf = buf.slice(i + CLOSE.length);
        inThink = false;
      } else {
        const o = buf.indexOf(OPEN);
        const c = buf.indexOf(CLOSE);
        const next = o === -1 ? c : c === -1 ? o : Math.min(o, c);
        if (next === -1) {
          const hold = heldTail(buf);
          const emit = buf.slice(0, buf.length - hold);
          if (emit) onText(emit);
          buf = buf.slice(buf.length - hold);
          return;
        }
        if (next > 0) onText(buf.slice(0, next));
        if (next === o) {
          buf = buf.slice(o + OPEN.length);
          inThink = true;
        } else {
          // stray </think> with no opener — drop it and carry on
          buf = buf.slice(c + CLOSE.length);
        }
      }
    }
  };
  const flush = (): void => {
    if (!buf) return;
    if (inThink) onReason(buf);
    else onText(buf);
    buf = "";
  };
  return { feed, flush };
}

export class LlmClient {
  private client: OpenAI;
  private settings: Settings;
  /** prompt tokens reported by vLLM for the latest request — feeds the statusline. */
  lastPromptTokens = 0;
  /** running total of completion tokens (for per-step throughput reporting). */
  cumCompletionTokens = 0;
  /** transient per-request sampling+thinking override (set per chain step). */
  private override: InferenceProfile | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.client = this.buildClient();
  }

  private buildClient(): OpenAI {
    return new OpenAI({
      baseURL: this.settings.baseURL,
      apiKey: process.env[this.settings.apiKeyEnv] ?? "none",
      timeout: 600_000,
      maxRetries: 1,
    });
  }

  /** Rebuild the underlying connection after the endpoint (baseURL/apiKeyEnv)
   *  changed in settings — used by /model. model id and sampling are read
   *  fresh per request, so only the transport needs rebuilding. */
  reconfigure(): void {
    this.client = this.buildClient();
    this.lastPromptTokens = 0;
  }

  /** Apply a chain-step inference profile (thinking + sampling, flipped
   *  together) to subsequent requests; pass null to revert to settings. */
  setInferenceProfile(profile: InferenceProfile | null): void {
    this.override = profile;
  }

  /** Effective sampling: the step override wins, else the session settings. */
  private sampling(): { temperature: number; topP: number; topK: number; minP: number; enableThinking: boolean } {
    const o = this.override;
    const s = this.settings;
    return {
      temperature: o ? o.temperature : s.temperature,
      topP: o ? o.topP : s.topP,
      topK: o ? o.topK : s.topK,
      minP: o ? o.minP : s.minP,
      enableThinking: o ? o.enableThinking : s.enableThinking,
    };
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks = {},
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const s = this.settings;
    const samp = this.sampling();
    const stream = await this.client.chat.completions.create(
      {
        model: s.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: samp.temperature,
        top_p: samp.topP,
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
    // some builds (e.g. the Qwen3.6 NVFP4 spin) don't reliably populate the
    // separate reasoning field — they leak <think>…</think> straight into
    // content. Route inline think to the dimmed reasoning channel so it never
    // renders as the answer or gets scanned for tool calls.
    const think = makeThinkFilter(
      (s) => {
        text += s;
        callbacks.onTextDelta?.(s);
      },
      (s) => callbacks.onReasoningDelta?.(s),
    );

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
      if (delta?.content) think.feed(delta.content);
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
    think.flush();

    if (usage) {
      this.lastPromptTokens = usage.promptTokens;
      this.cumCompletionTokens += usage.completionTokens;
    }

    const toolCalls: ToolCall[] = [...toolFrags.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, f]) => ({
        id: f.id || `call_${i}`,
        type: "function" as const,
        function: { name: f.name, arguments: f.args },
      }));

    return { text, toolCalls, usage };
  }

  /** Single-shot, no tools, no streaming — used by memory extractor / compactor.
   *  Always deterministic and thinking-OFF; never inherits a chain-step override. */
  async oneShot(system: string, user: string, maxTokens = 4096): Promise<string> {
    const s = this.settings;
    const res = await this.client.chat.completions.create({
      model: s.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
      ...({
        top_k: s.topK,
        min_p: s.minP,
        presence_penalty: s.presencePenalty,
        repetition_penalty: s.repetitionPenalty,
        chat_template_kwargs: { enable_thinking: false },
      } as unknown as Record<string, never>),
    });
    return res.choices[0]?.message?.content ?? "";
  }

  /** vLLM-specific request fields the OpenAI client doesn't type. */
  private vllmExtras(): Record<string, unknown> {
    const s = this.settings;
    const samp = this.sampling();
    return {
      top_k: samp.topK,
      min_p: samp.minP,
      presence_penalty: s.presencePenalty,
      repetition_penalty: s.repetitionPenalty,
      // same kwarg name on Qwen3.5 and GLM-4.5; the profile sets it per step
      chat_template_kwargs: { enable_thinking: samp.enableThinking },
    };
  }
}
