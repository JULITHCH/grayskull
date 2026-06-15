/**
 * Model-family profiles. GLM-4.5-Air and Qwen3.5 differ in three ways that the
 * harness must adapt to: the plaintext tool-call *leak* format, the default
 * *sampling*, and the server-side vLLM parser flags. The thinking toggle is the
 * SAME on both (`chat_template_kwargs.enable_thinking`) — only the default and
 * the sampling differ. Select with `modelFamily` in settings; Qwen stays the
 * default so existing configs are unchanged.
 *
 * Verified GLM-4.5-Air values (authoritative sources, 2026-06):
 *   --tool-call-parser glm45, --reasoning-parser glm45   (vLLM blog/recipes, model card)
 *   thinking: chat_template_kwargs {enable_thinking: bool}, DEFAULT ON
 *             (vLLM blog, zai-org/GLM-4.5 issue #42); reasoning in `reasoning_content`
 *   leak format: <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
 *             (vLLM glm4_moe parser, GLM chat_template.jinja, lmstudio #829) — NOT JSON
 *   sampling: temp 0.6 / top_p 0.95 / top_k 40 / min_p 0  (GLM-4.5 issue #12, Z.ai docs)
 */

export type ModelFamily = "qwen3.5" | "glm4.5";
export type LeakDialect = "qwen" | "glm";

/** A step's inference settings: thinking + sampling, always flipped together. */
export interface InferenceProfile {
  enableThinking: boolean;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
}

export interface ModelProfile {
  family: ModelFamily;
  /** vLLM launch flags — recorded for the launch script/docs, not sent per request */
  toolCallParser: string;
  reasoningParser: string;
  /** which plaintext tool-call leakage format to recover (see repair.ts) */
  leakDialect: LeakDialect;
  /** named presets selectable per thinking-chain step */
  presets: Record<"codegen" | "reason", InferenceProfile>;
}

export const PROFILES: Record<ModelFamily, ModelProfile> = {
  // Qwen3.5-122B heretic (the existing server). Non-thinking coding preset is the
  // current default; reason mirrors it with thinking on.
  "qwen3.5": {
    family: "qwen3.5",
    toolCallParser: "qwen3_xml",
    reasoningParser: "qwen3",
    leakDialect: "qwen",
    presets: {
      codegen: { enableThinking: false, temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
      reason: { enableThinking: true, temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
    },
  },
  // GLM-4.5-Air hybrid reasoning. codegen = thinking-off, deterministic for code;
  // reason = thinking-on at GLM's documented default sampling. GLM-4.5-Air does
  // not publish a separate non-thinking coding preset, so codegen lowers the
  // temperature from the documented default (0.6) for stability — tune as needed.
  "glm4.5": {
    family: "glm4.5",
    toolCallParser: "glm45",
    reasoningParser: "glm45",
    leakDialect: "glm",
    presets: {
      codegen: { enableThinking: false, temperature: 0.2, topP: 0.95, topK: 40, minP: 0 },
      reason: { enableThinking: true, temperature: 0.6, topP: 0.95, topK: 40, minP: 0 },
    },
  },
};

export function modelProfile(family: ModelFamily): ModelProfile {
  return PROFILES[family] ?? PROFILES["qwen3.5"];
}
