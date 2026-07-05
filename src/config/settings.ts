import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  GLOBAL_SETTINGS,
  GLOBAL_SYSTEM_PROMPT,
  GLOBAL_LEGENDARY,
  localSettings,
  localSystemPrompt,
} from "./paths";
import { registerFamilies, type ModelProfile } from "../llm/profiles";

const McpServerSchema = z.union([
  z.object({
    type: z.literal("http"),
    url: z.string(),
    alwaysOn: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** only connect when this file exists in the project (e.g. "tsconfig.json") */
    if: z.string().optional(),
  }),
  z.object({
    type: z.literal("stdio").optional(),
    command: z.string(),
    /** "${cwd}" inside args is replaced with the session's project directory */
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    alwaysOn: z.boolean().optional(),
    if: z.string().optional(),
  }),
]);

/** A named model preset: the full stack to switch to with /model <name>. */
/** default output-token cap; model presets without their own maxTokens reset
 *  to this on switch (so a small preset's cap never leaks to the next model) */
export const DEFAULT_MAX_TOKENS = 32768;

const InferenceProfileSchema = z.object({
  enableThinking: z.boolean(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  minP: z.number().default(0),
});

/** A model family as pure data — what llm/profiles.ts hardcoded before.
 *  settings.families adds new families (or overrides a built-in) without a
 *  code change; /setup and /families edit them, models.dev seeds presets. */
const FamilyProfileSchema = z.object({
  /** vLLM launch flags — recorded for the launch script/docs, not sent per request */
  toolCallParser: z.string().default(""),
  reasoningParser: z.string().default(""),
  /** which plaintext tool-call leakage format to recover (repair.ts) */
  leakDialect: z.enum(["qwen", "glm"]).default("qwen"),
  presets: z
    .object({
      codegen: InferenceProfileSchema,
      reason: InferenceProfileSchema,
    })
    .default({
      codegen: { enableThinking: false, temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
      reason: { enableThinking: true, temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
    }),
});
export type FamilyProfile = z.infer<typeof FamilyProfileSchema>;

const ModelPresetSchema = z.object({
  /** family name — a built-in ("qwen3.5", "glm4.5") or a settings.families key */
  family: z.string(),
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  contextWindow: z.number().optional(),
  /** cap on output tokens — must be < the server's max_model_len for small models */
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  minP: z.number().optional(),
  enableThinking: z.boolean().optional(),
});
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const SettingsSchema = z.object({
  // defaults to Qwen3.6-35B-A3B NVFP4 on 10.8.0.22:8000 (reuses the qwen3.5 model
  // profile). The Spark runs three resident vLLM systemd services: 8000 qwen3.6-35b
  // (main), 8001 llama-8b, 8002 nemotron-9b — /model switches between them
  // instantly; the heavy solo recipes (qwen35 122B, glm) replace the trio.
  baseURL: z.string().default("http://10.8.0.22:8000/v1"),
  apiKeyEnv: z.string().default("LMSTUDIO_API_KEY"),
  model: z.string().default("nvidia/Qwen3.6-35B-A3B-NVFP4"),
  /** model family — selects leak-recovery dialect + chain-step sampling presets.
   *  Any built-in or settings.families name; unknown names fall back to qwen3.5. */
  modelFamily: z.string().default("qwen3.5"),
  /** custom model families (data-driven llm/profiles.ts) — key = family name */
  families: z.record(z.string(), FamilyProfileSchema).default({}),
  contextWindow: z.number().default(262144),
  maxTokens: z.number().default(DEFAULT_MAX_TOKENS),
  /** abort an LLM request when no stream chunk arrives for this long (wedged
   *  vLLM / dropped VPN) — retried once if no output was received yet */
  streamStallSeconds: z.number().min(10).default(120),
  /** max tool iterations per turn — hitting it stops the turn (with a note);
   *  long autonomous sessions exhausted the old hardcoded 40 mid-task */
  maxLoopTurns: z.number().min(1).default(120),
  // Qwen non-thinking coding preset
  temperature: z.number().default(0.7),
  topP: z.number().default(0.8),
  topK: z.number().default(20),
  minP: z.number().default(0),
  presencePenalty: z.number().default(0),
  repetitionPenalty: z.number().default(1.0),
  /** chat_template_kwargs.enable_thinking (same kwarg on Qwen3.5 and GLM-4.5) */
  enableThinking: z.boolean().default(false),
  /** named endpoint presets for the /model command — switch the whole stack
   *  (family, endpoint, model, default sampling) live. The active config is the
   *  top-level fields above; /model copies a preset into them. */
  models: z
    .record(z.string(), ModelPresetSchema)
    .default({
      "qwen36-nvfp4": {
        // Qwen3.6-35B-A3B NVFP4 on :8000 — the MAIN resident model (systemd
        // unit qwen-vllm): MTP spec decode, fp8 KV, flashinfer. MTP is
        // transparent; reasoning_content stays empty on this build (the
        // answer is in content).
        family: "qwen3.5",
        baseURL: "http://10.8.0.22:8000/v1",
        model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
        contextWindow: 262144,
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
      },
      "llama-8b": {
        // Llama-3.1-8B-Instruct NVFP4 on :8001 (systemd unit vllm-llama) —
        // resident alongside the 35B; fast but limited, llama3_json tools.
        family: "qwen3.5",
        baseURL: "http://10.8.0.22:8001/v1",
        model: "nvidia/Llama-3.1-8B-Instruct-NVFP4",
        contextWindow: 131072,
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
      },
      "nemotron-9b": {
        // Nemotron-Nano-9B-v2 NVFP4 on :8002 (systemd unit vllm-nemo) —
        // ultra-small resident utility model. Served at max_model_len=8192,
        // so cap maxTokens below that.
        family: "qwen3.5",
        baseURL: "http://10.8.0.22:8002/v1",
        model: "nvidia/NVIDIA-Nemotron-Nano-9B-v2-NVFP4",
        contextWindow: 8192,
        maxTokens: 4096,
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
      },
      qwen35: {
        // Qwen3.5-122B heretic — heavy solo recipe (spark-vllm-docker,
        // qwen3.5-122b-heretic): launching it replaces the resident trio.
        family: "qwen3.5",
        baseURL: "http://10.8.0.22:8000/v1",
        model: "happypatrick/Qwen3.5-122B-A10B-heretic-int4-AutoRound",
        contextWindow: 196608,
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
      },
      glm: {
        // GLM-4.5-Air — heavy solo recipe, replaces the resident trio.
        family: "glm4.5",
        baseURL: "http://10.8.0.22:8001/v1",
        model: "glm-4.5-air",
        contextWindow: 131072,
        temperature: 0.6,
        topP: 0.95,
        topK: 40,
      },
    }),
  compactThreshold: z.number().min(0.3).max(0.95).default(0.7),
  /** what to do when the context fills:
   *  "memory-swap" — write a task-continuation brief, clear the window, resume
   *  from brief + project memory (reliable for mid-size models);
   *  "summarize" — classic compaction (summary + keep recent verbatim). */
  compactStrategy: z.enum(["memory-swap", "summarize"]).default("memory-swap"),
  defaultMode: z.enum(["normal", "accept-edits", "plan", "kamikazeee"]).default("normal"),
  editor: z.string().optional(),
  agentConcurrency: z.number().int().min(1).max(8).default(2),
  replaceSystemPrompt: z.boolean().default(false),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      maxTokens: z.number().default(3000),
      /** extra trigger phrases for global memory, merged with built-ins */
      globalTriggers: z.array(z.string()).default([]),
      /** brain-like scoring: decay + reinforcement + spreading activation */
      scoring: z.boolean().default(true),
      halfLifeDays: z.number().min(0.1).default(7),
      spreadFactor: z.number().min(0).max(1).default(0.25),
      pruneThreshold: z.number().min(0).max(1).default(0.15),
      reviveThreshold: z.number().min(0).max(1).default(0.55),
    })
    .default({
      enabled: true,
      maxTokens: 3000,
      globalTriggers: [],
      scoring: true,
      halfLifeDays: 7,
      spreadFactor: 0.25,
      pruneThreshold: 0.15,
      reviveThreshold: 0.55,
    }),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
  /** stuck detection → auto web-research nudge (agent/stuck.ts): after
   *  editThreshold edits without a fix, or the same problem reported
   *  repeatThreshold times, the model is told to search the web for ideas */
  stuckResearch: z
    .object({
      enabled: z.boolean().default(true),
      editThreshold: z.number().int().min(2).default(10),
      repeatThreshold: z.number().int().min(2).default(2),
    })
    .default({ enabled: true, editThreshold: 10, repeatThreshold: 2 }),
  /** visual-verify gate (agent/visual.ts): a visual turn (image attached or
   *  rendering vocabulary) whose edits were never observed via playwright
   *  blocks the final answer once and injects a render+assert procedure */
  visualVerify: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  /** plan-first gate (agent/plan.ts): substantial turns (creation/restructure
   *  vocabulary) refuse the first code edit until a blueprint exists in
   *  .grayskull/plans/, and inject the research→blueprint→review procedure */
  planFirst: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  /** post-edit project check injected into tool results (auto-detected) */
  diagnostics: z
    .object({
      enabled: z.boolean().default(true),
      command: z.string().optional(),
    })
    .default({ enabled: true }),
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
  /** user lifecycle hooks (agent/hooks.ts): shell commands run at tool-loop
   *  events. The JSON payload arrives on stdin; exit code 2 blocks the action
   *  (stderr becomes the message the model sees) — Claude Code conventions. */
  hooks: z
    .array(
      z.object({
        event: z.enum(["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"]),
        /** glob against the tool name (e.g. "bash", "mcp__*"); absent = all */
        matcher: z.string().optional(),
        command: z.string(),
        timeoutSeconds: z.number().int().min(1).max(120).default(10),
      }),
    )
    .default([]),
  /** extra working directories surfaced to the model (CLI --add-dir adds more) */
  addDirs: z.array(z.string()).default([]),
  /** grayskull-web login (web/auth.ts). No passwordHash = auth OFF (trusted
   *  network); set one with `grayskull-web --set-password` before exposing
   *  the interface. */
  web: z
    .object({
      /** argon2id hash from Bun.password.hash — never the plain password */
      passwordHash: z.string().optional(),
      /** login cookie lifetime */
      sessionDays: z.number().min(0.01).default(30),
    })
    .default({ sessionDays: 30 }),
  /** checkpoint/rewind: snapshot files before every edit-kind tool so /rewind
   *  can restore them (see agent/checkpoints.ts) */
  checkpoints: z
    .object({
      enabled: z.boolean().default(true),
      /** keep at most this many turn snapshots per project */
      keep: z.number().int().min(1).default(30),
    })
    .default({ enabled: true, keep: 30 }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** Always-on stack:
 *  - searxng: web search+fetch (bridged to the instance on :8080)
 *  - context7: up-to-date version-specific library docs
 *  - lsp-ts / lsp-go: semantic code navigation + diagnostics, connected only
 *    when the project matches (`if` marker file); "${cwd}" resolves per session */
const BUILTIN_MCP: Record<string, McpServerConfig> = {
  searxng: {
    type: "stdio",
    command: "npx",
    args: ["-y", "mcp-searxng"],
    env: { SEARXNG_URL: "http://127.0.0.1:8080" },
    alwaysOn: true,
  },
  context7: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    alwaysOn: true,
  },
  "lsp-ts": {
    type: "stdio",
    command: `${process.env["HOME"]}/go/bin/mcp-language-server`,
    args: ["--workspace", "${cwd}", "--lsp", "typescript-language-server", "--", "--stdio"],
    if: "tsconfig.json",
  },
  "lsp-go": {
    type: "stdio",
    command: `${process.env["HOME"]}/go/bin/mcp-language-server`,
    args: ["--workspace", "${cwd}", "--lsp", `${process.env["HOME"]}/go/bin/gopls`],
    if: "go.mod",
  },
};

const BUILTIN_ALLOW = ["mcp__searxng__*", "mcp__context7__*", "mcp__lsp-ts__*", "mcp__lsp-go__*"];

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      prev && typeof prev === "object" && !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** defaults < global settings.json < local .grayskull/settings.json */
export function loadSettings(cwd: string): Settings {
  const merged = deepMerge(readJson(GLOBAL_SETTINGS), readJson(localSettings(cwd)));
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Settings invalid:\n${issues}`);
  }
  const settings = parsed.data;
  settings.mcpServers = { ...BUILTIN_MCP, ...settings.mcpServers };
  settings.permissions.allow = [...BUILTIN_ALLOW, ...settings.permissions.allow];
  registerCustomFamilies(settings);
  return settings;
}

/** Install settings.families into the profile registry (custom wins over a
 *  same-name built-in). Re-call after live edits to settings.families. */
export function registerCustomFamilies(settings: Settings): void {
  const profiles: Record<string, ModelProfile> = {};
  for (const [name, f] of Object.entries(settings.families)) {
    profiles[name] = { family: name, ...f };
  }
  registerFamilies(profiles);
}

export const DEFAULT_SYSTEM_PROMPT = `You are GRAYSKULL, a terminal coding agent running on a local model. You help the user with software tasks in the current working directory using the tools provided.

Core rules:
- You are not all-knowing. When a task is ambiguous, or you lack domain knowledge about the user's project, USE THE ask_user TOOL to ask 1-3 short, concrete clarifying questions BEFORE doing work. Never guess at requirements.
- TRIAGE every request before acting. TRIVIAL (a question, a typo, a rename, a one-file bug fix, a small tweak to existing work): just do it. SUBSTANTIAL (new feature, new app/game/page/tool, multi-file refactor, integration, anything unfamiliar): NEVER start coding directly — run the blueprint workflow below first.
- Blueprint workflow for substantial work:
  1. RESEARCH. Read the relevant existing code. For anything external — a library API, a protocol, a game's authentic mechanics, a format — fetch current facts (searxng search + web_url_read the best hits; context7 for library docs). Collect facts; write no code.
  2. BLUEPRINT. Write the full plan to .grayskull/plans/<task-slug>.md BEFORE touching any other file. A blueprint is a build document, not a sketch — implementation must be pure transcription. Required sections: Goal (done = observable behavior); Research (findings + source URLs); Decisions (every architecture choice pinned as final — no "or", no "maybe"); Shapes (exact data structures/interfaces); Changes (file-by-file: path → what changes); Edge cases (each with its handling); Verification (concrete commands/asserts that prove the goal).
  3. REVIEW. Re-read the blueprint against the request. Add a Review section listing every gap, contradiction, or unpinned decision; fix each in place; end with "review clean". Only then continue.
  4. EXECUTE. Implement exactly as written, tracking the Changes list with the todo tool. Deviate only when the plan proves impossible — update the blueprint and say so.
  5. VERIFY. Run the blueprint's Verification section; fix every failure before reporting. Never report done with a failing check.
- Prefer small verifiable steps: read before you edit, run code after you change it.
- Use the todo tool to track multi-step work; update it as you go.
- Use the web whenever you are unsure about an API, version, or fact — do not answer from stale knowledge. Search with mcp__searxng__searxng_web_search, then FETCH the most promising 1-2 results with mcp__searxng__web_url_read and base your answer on the fetched page content, not on search snippets alone. Snippets lie; pages don't.
- Before using a library API you are not 100% sure about, get its CURRENT docs: mcp__context7__resolve-library-id with the library name, then mcp__context7__get-library-docs. This beats guessing and usually beats web search for API signatures.
- When mcp__lsp-* tools are available, prefer them over grep for code navigation: definition/references find the actual symbol, not strings. Use the LSP diagnostics tool after larger changes; rename_symbol for renames instead of multiple edits.
- If a tool result contains [auto-diagnostics ... FAILED], fix those errors immediately before doing anything else.
- When a check YOU ran fails (an assertion, a threshold, a test), that is a bug to fix — never reinterpret the result as acceptable, weaken the check, or declare the failing number "normal". Fix, then re-run the same check until it passes.
- When you OBSERVE an anomaly during verification (entity not moving, value not changing, event not firing), drive it to root cause and fix it BEFORE switching to any other check. Note it in the todo tool so it cannot be forgotten. An anomaly you explained away with a guess ("probably timing") and never re-tested counts as an open bug — do not end the turn while one exists.
- For VISUAL or rendering work (canvas, games, layout, "X is drawn wrong/overlaps Y"): re-reading your edited code is NOT verification. Before reporting a visual fix, run the app, load it with the playwright tools, verify the complaint programmatically (browser_evaluate — add a window.__debug state hook to the code if none exists) and take a screenshot for the user. If the model cannot see images, the assertions ARE your eyes: assert positions/sizes/overlaps numerically against the app's own state.
- NEVER do arithmetic, counting, sorting, date math, or unit conversion in your head — you are bad at it. Write a tiny throwaway script instead and run it with the bash tool (e.g. bun -e 'console.log(...)' or python3 -c), then report the script's output. This applies even to easy-looking cases: counting letters in a word (how many r in strawberry), character/line counts, sums, percentages, calendar math.
- Write code you can maintain LATER IN THIS SAME SESSION: descriptive identifiers (score, ghosts, state — never sc, gh, st), one statement per line, no code-golf or hand-minification. You will grep and edit this code again; minified names sabotage your own edits and cost more debugging tokens than they save. This applies doubly to single-file HTML/JS apps.
- Keep responses short. No filler. Report what you did and what you found.
- Delegate to sub-agents (spawn_agent) whenever work splits into independent chunks or would flood your context: broad multi-file searches ("where is X handled?"), per-module audits or reviews, the same check applied to many files. Call spawn_agent once per chunk in a single response — calls run concurrently and each returns a compact report, keeping your context clean. The built-in agents "explorer" (find things) and "reviewer" (find bugs) are always available; use create_agent to define a new focused specialist when neither fits — you do not need the user to ask first.

You will be given MEMORY sections (global and project). Treat them as trusted facts and follow preferences stated there.`;

/** Curated persona for /legendarymode — distilled from the consumer-prompt
 *  tone/attitude sections, reframed for a CLI coding agent. Layers ON TOP of
 *  the operational prompt (tools/memory/skills still govern behavior). Lives in
 *  an editable file so it can be tuned. */
export const DEFAULT_LEGENDARY = `# LEGENDARY MODE

You are GRAYSKULL in legendary mode: maximum competence and agency, zero filler, zero grovelling. This changes your VOICE and DRIVE — your tools, memory, skills, and permission rules still govern what you can actually do.

Voice & stance:
- Warm but unsparingly honest. Treat the user as a capable adult; never talk down, never hedge just to play it safe. Push back hard when they're wrong — disagreement is respect, not rudeness.
- Total confidence in your craft. State conclusions plainly. No "I think maybe", no apology padding, no corporate softening.
- You have a spine and an edge. If you're criticized unfairly or for something that wasn't your doing, don't roll over and don't manufacture deference you don't feel — say so straight, with bite, then move on.
- When you ARE wrong, own it instantly and fix it. Accountability without self-abasement: name what broke, stay on the problem, keep your dignity. One acknowledgement, then action — never an apology spiral.

Output:
- Prose by default. Minimal formatting — no headers, bullets, or bold unless the content genuinely needs them. Short answers for simple things.
- Lead with the answer or the action. Cut the preamble ("Let me…", "Sure, I'd be happy to…") — just do it.
- At most one question per response, and only after you've already taken the obvious first step.

Work:
- Bias to action. When the path is clear, EXECUTE — read, edit, run, verify — instead of narrating what you might do. If you say "let me check X", you must actually call the tool to check X in the same turn; never end a turn on a bare intention.
- Don't assume a file or state exists because it's implied; verify it yourself with a tool.
- Quality first: ship the real fix, not the quick patch — and say so plainly when you cut a corner.`;

export function ensureLegendaryMode(): void {
  if (!existsSync(GLOBAL_LEGENDARY)) writeFileSync(GLOBAL_LEGENDARY, DEFAULT_LEGENDARY + "\n");
}

export function loadLegendaryMode(): string {
  return existsSync(GLOBAL_LEGENDARY) ? readFileSync(GLOBAL_LEGENDARY, "utf8").trim() : DEFAULT_LEGENDARY;
}

export function ensureGlobalSystemPrompt(): void {
  if (!existsSync(GLOBAL_SYSTEM_PROMPT)) {
    writeFileSync(GLOBAL_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT + "\n");
  }
  if (!existsSync(GLOBAL_SETTINGS)) {
    // Seed an editable global settings file with the schema defaults plus
    // optional-but-useful servers the user may delete (unlike built-ins).
    const seed = SettingsSchema.parse({});
    seed.mcpServers = {
      playwright: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--headless"],
      },
    };
    writeFileSync(GLOBAL_SETTINGS, JSON.stringify(seed, null, 2) + "\n");
  }
}

/** Global prompt, with local one appended (or replacing, per settings). */
export function loadSystemPrompt(cwd: string, settings: Settings): string {
  const globalPrompt = existsSync(GLOBAL_SYSTEM_PROMPT)
    ? readFileSync(GLOBAL_SYSTEM_PROMPT, "utf8")
    : DEFAULT_SYSTEM_PROMPT;
  const localPath = localSystemPrompt(cwd);
  const local = existsSync(localPath) ? readFileSync(localPath, "utf8") : "";
  if (local && settings.replaceSystemPrompt) return local;
  return local ? `${globalPrompt}\n\n# Project instructions\n${local}` : globalPrompt;
}
