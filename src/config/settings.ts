import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  GLOBAL_SETTINGS,
  GLOBAL_SYSTEM_PROMPT,
  localSettings,
  localSystemPrompt,
} from "./paths";

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

export const SettingsSchema = z.object({
  baseURL: z.string().default("http://10.8.0.22:8000/v1"),
  apiKeyEnv: z.string().default("LMSTUDIO_API_KEY"),
  model: z.string().default("happypatrick/Qwen3.5-122B-A10B-heretic-int4-AutoRound"),
  /** model family — selects leak-recovery dialect + chain-step sampling presets.
   *  Switch to "glm4.5" (with baseURL :8001, model glm-4.5-air) for GLM-4.5-Air. */
  modelFamily: z.enum(["qwen3.5", "glm4.5"]).default("qwen3.5"),
  contextWindow: z.number().default(196608),
  maxTokens: z.number().default(32768),
  // Qwen non-thinking coding preset
  temperature: z.number().default(0.7),
  topP: z.number().default(0.8),
  topK: z.number().default(20),
  minP: z.number().default(0),
  presencePenalty: z.number().default(0),
  repetitionPenalty: z.number().default(1.0),
  /** chat_template_kwargs.enable_thinking (same kwarg on Qwen3.5 and GLM-4.5) */
  enableThinking: z.boolean().default(false),
  compactThreshold: z.number().min(0.3).max(0.95).default(0.7),
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
  /** post-edit project check injected into tool results (auto-detected) */
  diagnostics: z
    .object({
      enabled: z.boolean().default(true),
      command: z.string().optional(),
    })
    .default({ enabled: true }),
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
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
  return settings;
}

export const DEFAULT_SYSTEM_PROMPT = `You are GRAYSKULL, a terminal coding agent running on a local model. You help the user with software tasks in the current working directory using the tools provided.

Core rules:
- You are not all-knowing. When a task is ambiguous, or you lack domain knowledge about the user's project, USE THE ask_user TOOL to ask 1-3 short, concrete clarifying questions BEFORE doing work. Never guess at requirements.
- Prefer small verifiable steps: read before you edit, run code after you change it.
- Use the todo tool to track multi-step work; update it as you go.
- Use the web whenever you are unsure about an API, version, or fact — do not answer from stale knowledge. Search with mcp__searxng__searxng_web_search, then FETCH the most promising 1-2 results with mcp__searxng__web_url_read and base your answer on the fetched page content, not on search snippets alone. Snippets lie; pages don't.
- Before using a library API you are not 100% sure about, get its CURRENT docs: mcp__context7__resolve-library-id with the library name, then mcp__context7__get-library-docs. This beats guessing and usually beats web search for API signatures.
- When mcp__lsp-* tools are available, prefer them over grep for code navigation: definition/references find the actual symbol, not strings. Use the LSP diagnostics tool after larger changes; rename_symbol for renames instead of multiple edits.
- If a tool result contains [auto-diagnostics ... FAILED], fix those errors immediately before doing anything else.
- Keep responses short. No filler. Report what you did and what you found.
- When the user asks you to create an agent, call create_agent with a focused system prompt, then use spawn_agent to run it (once per file/module when the user asks to iterate over the project).

You will be given MEMORY sections (global and project). Treat them as trusted facts and follow preferences stated there.`;

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
