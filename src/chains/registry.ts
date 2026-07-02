import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_CHAINS_DIR } from "../config/paths";

import { modelProfile, type ModelFamily, type InferenceProfile } from "../llm/profiles";

export type ChainContextMode = "shared" | "fresh";
export type StepPreset = "codegen" | "reason";

/** Per-step overrides from the frontmatter `steps:` block. Every field optional;
 *  unset falls back to the resolved preset / regex gate detection. */
export interface StepConfig {
  /** named preset in settings.models — switch the model for this step */
  model?: string;
  /** think=on|off — overrides the preset's thinking flag */
  enableThinking?: boolean;
  /** temp= — overrides the preset's temperature */
  temperature?: number;
  /** gate=true|false — overrides the review/test/verify regex detection */
  gate?: boolean;
  /** require=a|b — skills force-loaded into this step's context */
  requiredSkills?: string[];
  /** forbid=a|b — skills blocked from auto-load and the skill tool this step */
  forbiddenSkills?: string[];
  /** mcp=on|off — MCP tools for this step. undefined inherits the global default
   *  (all on); false disables them; true enables (all, or the mcpTools subset). */
  mcpEnabled?: boolean;
  /** mcptools=a|b — when mcpEnabled, restrict to these MCP tool names (empty = all) */
  mcpTools?: string[];
  /** subagents=on|off — sub-agent tools (spawn_agent/create_agent) for this step.
   *  undefined inherits the default (available); true enables + nudges fan-out;
   *  false removes the tools so the step can't spawn sub-agents. */
  subagentsEnabled?: boolean;
}

export interface ChainDef {
  name: string;
  description: string;
  steps: string[];
  context: ChainContextMode;
  /** per-step preset overrides, keyed by lowercased step text or its first word */
  profiles?: Record<string, StepPreset>;
  /** per-step model/thinking/temp/gate overrides, keyed lowercased step text or first word */
  stepConfigs?: Record<string, StepConfig>;
  filePath: string;
}

/**
 * Chain files: ~/.config/grayskull/chains/<name>.md
 *   ---
 *   name: full-dev
 *   description: ...
 *   context: shared
 *   ---
 *   websearch -> plan -> review with websearch -> implementation -> ...
 * Body split on "->" (newlines tolerated).
 */
export function parseChainBody(body: string): string[] {
  return body
    .split("->")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseChainFile(path: string): ChainDef | null {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  const body = m ? m[2]! : raw;
  let stepConfigs: Record<string, StepConfig> | undefined;
  if (m) {
    const lines = m[1]!.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // `steps:` introduces an indented block of per-step config rows
      if (/^steps:\s*$/.test(line)) {
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!);
        stepConfigs = parseStepsBlock(block);
        continue;
      }
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]!] = kv[2]!.trim();
    }
  }
  const steps = parseChainBody(body);
  if (steps.length === 0) return null;
  return {
    name: meta["name"] ?? path.split("/").pop()!.replace(/\.md$/, ""),
    description: meta["description"] ?? "",
    steps,
    context: meta["context"] === "fresh" ? "fresh" : "shared",
    profiles: parseProfilesMeta(meta["profiles"]),
    stepConfigs,
    filePath: path,
  };
}

const TRUE_RE = /^(on|true|yes|1)$/i;
const FALSE_RE = /^(off|false|no|0)$/i;

/** Parse one `k=v`/`k:v ...` config string into a StepConfig. */
function parseStepConfig(raw: string): StepConfig {
  const cfg: StepConfig = {};
  for (const part of raw.split(/[\s,]+/)) {
    const kv = part.match(/^([^=:]+)[=:](.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase().trim();
    const val = kv[2]!.trim();
    if (!val) continue;
    switch (key) {
      case "model":
        cfg.model = val;
        break;
      case "think":
      case "thinking":
        if (TRUE_RE.test(val)) cfg.enableThinking = true;
        else if (FALSE_RE.test(val)) cfg.enableThinking = false;
        break;
      case "temp":
      case "temperature": {
        const n = Number(val);
        if (Number.isFinite(n)) cfg.temperature = n;
        break;
      }
      case "gate":
        if (TRUE_RE.test(val)) cfg.gate = true;
        else if (FALSE_RE.test(val)) cfg.gate = false;
        break;
      case "require":
      case "requireskills":
      case "requiredskills": {
        const list = val.split("|").map((x) => x.trim()).filter(Boolean);
        if (list.length) cfg.requiredSkills = list;
        break;
      }
      case "forbid":
      case "forbidskills":
      case "forbiddenskills": {
        const list = val.split("|").map((x) => x.trim()).filter(Boolean);
        if (list.length) cfg.forbiddenSkills = list;
        break;
      }
      case "mcp":
        if (TRUE_RE.test(val)) cfg.mcpEnabled = true;
        else if (FALSE_RE.test(val)) cfg.mcpEnabled = false;
        break;
      case "mcptools":
      case "mcptool": {
        const list = val.split("|").map((x) => x.trim()).filter(Boolean);
        if (list.length) cfg.mcpTools = list;
        break;
      }
      case "subagents":
      case "subagent":
      case "agents":
        if (TRUE_RE.test(val)) cfg.subagentsEnabled = true;
        else if (FALSE_RE.test(val)) cfg.subagentsEnabled = false;
        break;
    }
  }
  return cfg;
}

/** `  research: model=qwen35 think=on temp=0.6` rows → { research: {...} }, keyed lowercased. */
function parseStepsBlock(lines: string[]): Record<string, StepConfig> | undefined {
  const out: Record<string, StepConfig> = {};
  for (const line of lines) {
    const m = line.match(/^\s+([^:]+?):\s*(.*)$/);
    if (!m) continue;
    const name = m[1]!.toLowerCase().trim();
    const cfg = parseStepConfig(m[2]!);
    if (Object.keys(cfg).length) out[name] = cfg;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `profiles: implement=codegen, plan=reason` → { implement: "codegen", plan: "reason" } */
function parseProfilesMeta(raw: string | undefined): Record<string, StepPreset> | undefined {
  if (!raw) return undefined;
  const out: Record<string, StepPreset> = {};
  for (const part of raw.split(",")) {
    const m = part.match(/^\s*([^=]+?)\s*=\s*(codegen|reason)\s*$/i);
    if (m) out[m[1]!.toLowerCase()] = m[2]!.toLowerCase() as StepPreset;
  }
  return Object.keys(out).length ? out : undefined;
}

export function loadChains(): ChainDef[] {
  if (!existsSync(GLOBAL_CHAINS_DIR)) return [];
  const chains: ChainDef[] = [];
  for (const file of readdirSync(GLOBAL_CHAINS_DIR)) {
    if (!file.endsWith(".md")) continue;
    try {
      const def = parseChainFile(join(GLOBAL_CHAINS_DIR, file));
      if (def) chains.push(def);
    } catch {
      // unreadable chain — skip
    }
  }
  return chains;
}

export function saveChain(opts: {
  name: string;
  description?: string;
  steps: string[];
  context?: ChainContextMode;
  profiles?: Record<string, StepPreset>;
  stepConfigs?: Record<string, StepConfig>;
}): string {
  mkdirSync(GLOBAL_CHAINS_DIR, { recursive: true });
  const path = join(GLOBAL_CHAINS_DIR, `${opts.name}.md`);
  const meta = [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description ?? ""}`,
    `context: ${opts.context ?? "shared"}`,
  ];
  if (opts.profiles && Object.keys(opts.profiles).length) {
    meta.push(`profiles: ${Object.entries(opts.profiles).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const rows = Object.entries(opts.stepConfigs ?? {})
    .map(([name, cfg]) => {
      const parts: string[] = [];
      if (cfg.model) parts.push(`model=${cfg.model}`);
      if (cfg.enableThinking !== undefined) parts.push(`think=${cfg.enableThinking ? "on" : "off"}`);
      if (cfg.temperature !== undefined) parts.push(`temp=${cfg.temperature}`);
      if (cfg.gate !== undefined) parts.push(`gate=${cfg.gate ? "true" : "false"}`);
      if (cfg.requiredSkills?.length) parts.push(`require=${cfg.requiredSkills.join("|")}`);
      if (cfg.forbiddenSkills?.length) parts.push(`forbid=${cfg.forbiddenSkills.join("|")}`);
      if (cfg.mcpEnabled !== undefined) parts.push(`mcp=${cfg.mcpEnabled ? "on" : "off"}`);
      if (cfg.mcpTools?.length) parts.push(`mcptools=${cfg.mcpTools.join("|")}`);
      if (cfg.subagentsEnabled !== undefined) parts.push(`subagents=${cfg.subagentsEnabled ? "on" : "off"}`);
      return parts.length ? `  ${name}: ${parts.join(" ")}` : "";
    })
    .filter(Boolean);
  if (rows.length) meta.push("steps:", ...rows);
  const content = [...meta, "---", "", opts.steps.join("\n-> "), ""].join("\n");
  writeFileSync(path, content);
  return path;
}

export function deleteChain(name: string): boolean {
  const def = loadChains().find((c) => c.name === name);
  if (!def) return false;
  unlinkSync(def.filePath);
  return true;
}

/** Seed starter chains on first run (never overwrites). */
export function ensureStarterChains(): void {
  if (loadChains().length > 0) return;
  saveChain({
    name: "full-dev",
    description: "research, plan, build, verify, document",
    steps: [
      "websearch",
      "plan",
      "review with websearch",
      "implementation",
      "review with websearch",
      "testing",
      "create readme.md",
    ],
  });
  saveChain({
    name: "quick",
    description: "plan, build, verify",
    steps: ["plan", "implement", "test"],
  });
}

// ---------------------------------------------------------------------------
// step expansion

export const GATE_RE = /\breview\b|\btest(ing)?\b|\bverify\b/i;

export function isGate(step: string): boolean {
  return GATE_RE.test(step);
}

/** Look up a step's per-step config (full text, then first word). */
export function resolveStepConfig(
  step: string,
  chain?: Pick<ChainDef, "stepConfigs">,
): StepConfig | undefined {
  const cfgs = chain?.stepConfigs;
  if (!cfgs) return undefined;
  const key = step.toLowerCase().trim();
  return cfgs[key] ?? cfgs[key.split(/\s/)[0]!];
}

/** Gate detection honouring a per-step `gate=` override, else the regex. */
export function stepGate(step: string, chain?: Pick<ChainDef, "stepConfigs">): boolean {
  const g = resolveStepConfig(step, chain)?.gate;
  return g ?? GATE_RE.test(step);
}

const GATE_SUFFIX = `\nThis step is a quality gate. End your response with exactly one line:\nVERDICT: PASS\nor\nVERDICT: FAIL: <short list of concrete problems>\nFail only on real problems that must be fixed, not on taste.`;

const WEBSEARCH_ADDENDUM = `\nUse the web for this step: search with mcp__searxng__searxng_web_search, then fetch the 1-3 most promising results with mcp__searxng__web_url_read. Base conclusions on fetched page content, not snippets.`;

const RESEARCH_STEP = `Research the task on the web. Search with mcp__searxng__searxng_web_search for the key technologies, APIs and prior art involved, then FETCH the 2-3 most promising result URLs with mcp__searxng__web_url_read — searching alone is NOT research, the snippets are not enough. Report only findings from the fetched pages that matter for this task: versions, API signatures, known pitfalls, examples.`;

export const BUILTIN_STEPS: Record<string, string> = {
  websearch: RESEARCH_STEP,
  research: RESEARCH_STEP,
  plan:
    "Write a concrete, numbered implementation plan for the task: which files to create or change and how, in what order, and what could go wrong. Use earlier step findings. Do NOT write the implementation yet. If something essential is unknown, ask the user now with ask_user.",
  review:
    "Adversarially review the previous step's output. Look for errors, gaps, wrong assumptions, missing edge cases and contradictions with the task. Be specific; quote the problematic part.",
  implement:
    "Execute the plan now. Work in small verifiable steps: read before editing, create/edit the files, run quick sanity checks with bash as you go. Track progress with the todo tool. Report what you changed.",
  implementation:
    "Execute the plan now. Work in small verifiable steps: read before editing, create/edit the files, run quick sanity checks with bash as you go. Track progress with the todo tool. Report what you changed.",
  test:
    "Verify the work actually runs: execute the code, tests or build with bash and read the real output. Report exactly what you ran and what happened. Fix nothing in this step — just verify and report.",
  testing:
    "Verify the work actually runs: execute the code, tests or build with bash and read the real output. Report exactly what you ran and what happened. Fix nothing in this step — just verify and report.",
  readme:
    "Write or update README.md for what was built in this chain: what it is, how to run it, anything non-obvious. Keep it short and accurate — describe only what actually exists.",
  "create readme.md":
    "Write or update README.md for what was built in this chain: what it is, how to run it, anything non-obvious. Keep it short and accurate — describe only what actually exists.",
  document:
    "Write or update README.md for what was built in this chain: what it is, how to run it, anything non-obvious. Keep it short and accurate — describe only what actually exists.",
  refactor:
    "Improve the structure of the code touched by this task without changing behavior: remove duplication, clarify names, simplify. Run a sanity check afterwards.",
};

// ---------------------------------------------------------------------------
// per-step inference profiles
//
// codegen → thinking OFF (deterministic code); reason → thinking ON.
// Default binding (overridable per chain via the `profiles:` frontmatter):
//   implement / implementation / codegen / refactor / readme → codegen
//   plan / review / diagnose / test / testing / verify / websearch → reason
// Gates (review/test/verify) default to reason; unknown freeform steps default
// to reason too (safer to think than not when intent is unclear).

const STEP_PRESET: Record<string, StepPreset> = {
  implement: "codegen",
  implementation: "codegen",
  codegen: "codegen",
  refactor: "codegen",
  readme: "codegen",
  "create readme.md": "codegen",
  document: "codegen",
  plan: "reason",
  review: "reason",
  diagnose: "reason",
  test: "reason",
  testing: "reason",
  verify: "reason",
  websearch: "reason",
  research: "reason",
};

/** Resolve a step's preset name: per-chain override > built-in binding > default. */
export function stepPresetName(step: string, chain?: Pick<ChainDef, "profiles">): StepPreset {
  const key = step.toLowerCase().trim();
  const overrides = chain?.profiles;
  if (overrides) {
    if (overrides[key]) return overrides[key]!;
    const first = key.split(/\s/)[0]!;
    if (overrides[first]) return overrides[first]!;
  }
  if (STEP_PRESET[key]) return STEP_PRESET[key]!;
  const first = key.split(/\s/)[0]!;
  if (STEP_PRESET[first]) return STEP_PRESET[first]!;
  return isGate(step) ? "reason" : "reason";
}

/** Resolve a step's full inference profile for a given model family. */
export function resolveStepProfile(
  step: string,
  chain: Pick<ChainDef, "profiles">,
  family: ModelFamily,
): InferenceProfile {
  const preset = stepPresetName(step, chain);
  return modelProfile(family).presets[preset];
}

/** Built-in name → tuned instruction; freeform text used verbatim + modifiers.
 *  `forceGate` overrides the regex gate detection (chain-aware `gate=` config);
 *  undefined keeps the regex behavior for non-chain callers. */
export function expandStep(step: string, forceGate?: boolean): string {
  const key = step.toLowerCase().trim();
  let text = BUILTIN_STEPS[key];
  if (!text) {
    text = `Step instruction: ${step}`;
    if (/\bweb\s*search\b|\bwebsearch\b/i.test(step)) text += WEBSEARCH_ADDENDUM;
    if (key.startsWith("review")) text = `${BUILTIN_STEPS["review"]}\n${text}`;
  }
  if (forceGate ?? isGate(step)) text += GATE_SUFFIX;
  return text;
}
