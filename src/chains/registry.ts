import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_CHAINS_DIR } from "../config/paths";

import { modelProfile, type ModelFamily, type InferenceProfile } from "../llm/profiles";

export type ChainContextMode = "shared" | "fresh";
export type StepPreset = "codegen" | "reason";

export interface ChainDef {
  name: string;
  description: string;
  steps: string[];
  context: ChainContextMode;
  /** per-step preset overrides, keyed by lowercased step text or its first word */
  profiles?: Record<string, StepPreset>;
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
  if (m) {
    for (const line of m[1]!.split("\n")) {
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
    filePath: path,
  };
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

/** Built-in name → tuned instruction; freeform text used verbatim + modifiers. */
export function expandStep(step: string): string {
  const key = step.toLowerCase().trim();
  let text = BUILTIN_STEPS[key];
  if (!text) {
    text = `Step instruction: ${step}`;
    if (/\bweb\s*search\b|\bwebsearch\b/i.test(step)) text += WEBSEARCH_ADDENDUM;
    if (key.startsWith("review")) text = `${BUILTIN_STEPS["review"]}\n${text}`;
  }
  if (isGate(step)) text += GATE_SUFFIX;
  return text;
}
