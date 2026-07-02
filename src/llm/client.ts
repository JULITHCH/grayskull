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
  /** vLLM finish reason — "length" means the output was truncated at max_tokens */
  finishReason: string | null;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type StreamParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

/** Abort errors thrown out of streamOnce carry whether any output was already
 *  delivered to the callbacks — decides if a stall may be retried silently. */
interface StallError extends Error {
  emittedOutput?: boolean;
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
  /** decode throughput of the latest request (completion tok/s) — feeds the
   *  statusline; updated live while streaming, finalized from vLLM usage. */
  lastTokensPerSec = 0;
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
    this.lastTokensPerSec = 0;
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
    // clamp output tokens so prompt + output fits the model's context window —
    // small-context models (e.g. nemotron @ 8192) 400 otherwise. Tool schemas
    // count toward the prompt too, and the estimate runs low on dense code, so
    // fudge up 20% + a fixed margin before subtracting from the window.
    let estTools = 0;
    for (const t of tools) estTools += estimateTokens(t.name + t.description + JSON.stringify(t.parameters));
    const estPrompt = Math.ceil((estimateMessagesTokens(messages) + estTools) * 1.2) + 384;
    const MIN_OUTPUT = 256;
    const room = s.contextWindow - estPrompt;
    if (room < MIN_OUTPUT) {
      // no point sending a doomed request — fail with an actionable message
      throw new Error(
        `prompt (~${estPrompt} tokens incl. tool schemas) leaves no room for output in ` +
          `${s.model}'s ${s.contextWindow}-token context — switch this step to a larger-context model`,
      );
    }
    const maxOut = Math.min(s.maxTokens, room);
    const params: StreamParams = {
      model: s.model,
      messages,
      stream: true as const,
      stream_options: { include_usage: true },
      temperature: samp.temperature,
      top_p: samp.topP,
      max_tokens: maxOut,
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
    };

    // Stall watchdog: the SDK timeout only bounds time-to-headers; a stream
    // that stops producing chunks (wedged vLLM, silent VPN drop) would hang
    // the `for await` forever. Abort when no chunk arrives for stallMs. A
    // stall before any output is retried once (nothing reached the UI yet);
    // a mid-stream stall surfaces as an error the turn can report.
    const stallMs = Math.max(10, s.streamStallSeconds) * 1000;
    for (let attempt = 1; ; attempt++) {
      const ac = new AbortController();
      const onParentAbort = () => ac.abort();
      signal?.addEventListener("abort", onParentAbort, { once: true });
      let stalled = false;
      let timer = setTimeout(() => {
        stalled = true;
        ac.abort();
      }, stallMs);
      const poke = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          ac.abort();
        }, stallMs);
      };
      try {
        return await this.streamOnce(params, ac.signal, callbacks, poke);
      } catch (err) {
        if (signal?.aborted) throw err; // real user interrupt
        if (!stalled) throw err;
        const stalledEmpty = (err as StallError).emittedOutput === false;
        if (stalledEmpty && attempt === 1) continue; // silent retry, UI saw nothing
        throw new Error(
          `model stream stalled — no data from ${s.baseURL} for ${stallMs / 1000}s` +
            (stalledEmpty ? " (no output received)" : " (mid-response)"),
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
      }
    }
  }

  /** One streaming request + chunk pump. `poke` is the watchdog reset, called
   *  on every chunk. Throws StallError-augmented abort errors so `complete`
   *  can tell whether anything already reached the callbacks. */
  private async streamOnce(
    params: StreamParams,
    signal: AbortSignal,
    callbacks: StreamCallbacks,
    poke: () => void,
  ): Promise<CompletionResult> {
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

    // decode-rate tracking: time from the first generated token to the last,
    // counting reasoning + content + tool-arg tokens (estimated live, then
    // replaced by vLLM's exact completion count). prefill latency is excluded
    // so the figure reflects pure generation speed.
    let firstTokenAt = 0;
    let lastTokenAt = 0;
    let estGen = 0;
    let emitted = false;
    const bumpGen = (s: string): void => {
      if (!s) return;
      emitted = true;
      const now = Date.now();
      if (firstTokenAt === 0) firstTokenAt = now;
      lastTokenAt = now;
      estGen += estimateTokens(s);
      const secs = (lastTokenAt - firstTokenAt) / 1000;
      if (secs >= 0.05) this.lastTokensPerSec = estGen / secs;
    };

    let finishReason: string | null = null;
    try {
      const stream = await this.client.chat.completions.create(params, { signal });
      for await (const chunk of stream) {
        poke();
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      // qwen3 reasoning parser: think tokens arrive in a separate field
      // ("reasoning" on current vLLM, "reasoning_content" on older builds);
      // content stays empty until the think block closes — never treat that
      // as an empty reply and never scan it for tool calls
        const d = delta as Record<string, unknown> | undefined;
        const reasoning = d?.["reasoning"] ?? d?.["reasoning_content"];
        if (typeof reasoning === "string" && reasoning) {
          callbacks.onReasoningDelta?.(reasoning);
          bumpGen(reasoning);
        }
        if (delta?.content) {
          think.feed(delta.content);
          bumpGen(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const frag = toolFrags.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) frag.id = tc.id;
          if (tc.function?.name) frag.name += tc.function.name;
          if (tc.function?.arguments) frag.args += tc.function.arguments;
          toolFrags.set(tc.index, frag);
          bumpGen((tc.function?.name ?? "") + (tc.function?.arguments ?? ""));
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
      }
      // the SDK's Stream ends iteration *gracefully* on abort — without this a
      // watchdog abort would return the partial text as a normal completion
      if (signal.aborted) throw new Error("stream aborted");
    } catch (err) {
      // let the watchdog's retry logic know whether the UI already saw output
      (err as StallError).emittedOutput = emitted;
      throw err;
    }
    think.flush();

    if (usage) {
      this.lastPromptTokens = usage.promptTokens;
      this.cumCompletionTokens += usage.completionTokens;
      // finalize tok/s from the authoritative completion count
      const secs = (lastTokenAt - firstTokenAt) / 1000;
      if (secs >= 0.05) this.lastTokensPerSec = usage.completionTokens / secs;
    }

    const toolCalls: ToolCall[] = [...toolFrags.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, f]) => ({
        id: f.id || `call_${i}`,
        type: "function" as const,
        function: { name: f.name, arguments: f.args },
      }));

    return { text, toolCalls, usage, finishReason };
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
