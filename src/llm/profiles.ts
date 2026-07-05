/**
 * Model-family profiles. Families differ in three ways that the harness must
 * adapt to: the plaintext tool-call *leak* format, the default *sampling*, and
 * the server-side vLLM parser flags. The thinking toggle is the SAME on both
 * built-ins (`chat_template_kwargs.enable_thinking`) — only the default and
 * the sampling differ. Select with `modelFamily` in settings; Qwen stays the
 * default so existing configs are unchanged.
 *
 * Families are DATA, not code: the built-ins below are seeds, and settings.json
 * may add or override families under the `families` key (edited via /setup or
 * /families). `registerFamilies` is called by loadSettings at startup and after
 * live edits, so a new family never needs a code change.
 *
 * Verified GLM-4.5-Air values (authoritative sources, 2026-06):
 *   --tool-call-parser glm45, --reasoning-parser glm45   (vLLM blog/recipes, model card)
 *   thinking: chat_template_kwargs {enable_thinking: bool}, DEFAULT ON
 *             (vLLM blog, zai-org/GLM-4.5 issue #42); reasoning in `reasoning_content`
 *   leak format: <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
 *             (vLLM glm4_moe parser, GLM chat_template.jinja, lmstudio #829) — NOT JSON
 *   sampling: temp 0.6 / top_p 0.95 / top_k 40 / min_p 0  (GLM-4.5 issue #12, Z.ai docs)
 */

/** Family names are free strings now that families live in settings; the type
 *  alias survives so existing signatures keep reading naturally. */
export type ModelFamily = string;
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

export const BUILTIN_FAMILIES: Record<string, ModelProfile> = {
  // Qwen3.5/3.6 (the resident Spark models). Non-thinking coding preset is the
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

/** Custom/overriding families from settings.json (`families` key). */
let customFamilies: Record<string, ModelProfile> = {};

/** Install the settings-defined families (custom wins over a same-name built-in).
 *  Called by loadSettings and after live /setup or /families edits. */
export function registerFamilies(families: Record<string, ModelProfile>): void {
  customFamilies = { ...families };
}

/** All known family names, built-ins first (stable order for enum pickers). */
export function familyNames(): string[] {
  return [...new Set([...Object.keys(BUILTIN_FAMILIES), ...Object.keys(customFamilies)])];
}

export function modelProfile(family: ModelFamily): ModelProfile {
  return customFamilies[family] ?? BUILTIN_FAMILIES[family] ?? BUILTIN_FAMILIES["qwen3.5"]!;
}

/** Whether the name resolves to a real (not fallback) family. */
export function isKnownFamily(family: string): boolean {
  return family in customFamilies || family in BUILTIN_FAMILIES;
}
