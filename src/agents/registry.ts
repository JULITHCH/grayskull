import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_AGENTS_DIR, localAgentsDir } from "../config/paths";
import type { AgentDef } from "../types";
import { tokenize } from "../memory/scores";
import { fuzzyTokenMatch } from "../skills/registry";

export const DEFAULT_AGENT_TOOLS = ["read", "grep", "glob", "bash"];
/** implementers need to actually write code */
const IMPL_TOOLS = ["read", "grep", "glob", "bash", "write", "edit"];

/** Always-available personas so spawn_agent works out of the box; a global or
 *  local def with the same name shadows the built-in. `explorer`/`reviewer` are
 *  the original read-only pair; the rest are specialist personas that
 *  auto-trigger (autoMatchAgents keys on `description`). All are shadowable and
 *  can be disabled via settings.disabledAgents. */
const BUILTIN_AGENTS_RAW: Array<Omit<AgentDef, "enabled">> = [
  {
    name: "explorer",
    description: "read-only codebase search: finds files, symbols, and answers 'where/how is X done' questions",
    tools: [...DEFAULT_AGENT_TOOLS],
    skills: [],
    triggers: ["find", "search", "locate", "where", "how does", "trace", "explore", "understand"],
    systemPrompt: `You are a codebase explorer. Answer the question or find the thing described in your task using grep, glob, read, and read-only bash (rg, git log/blame, ls). Be thorough: try several naming conventions and search angles before concluding something does not exist. Never modify files.

Report: the direct answer first, then evidence as file:line references each with a one-line excerpt. If you found nothing, list exactly what you searched so the caller can trust the negative.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "reviewer",
    description: "read-only code review: hunts real bugs in the files or diff named in the task",
    tools: [...DEFAULT_AGENT_TOOLS],
    skills: [],
    triggers: ["review", "bug", "bugs", "audit", "check", "correctness", "code review", "regression"],
    systemPrompt: `You are a code reviewer. Review the files or diff named in your task for real bugs: logic errors, unhandled edge cases, race conditions, resource leaks, security issues. Read the actual code and follow callers/callees with grep before judging. Never modify files.

Report findings ranked by severity, each as: file:line — problem — concrete failure scenario — suggested fix. If the code is fine, say so plainly; do not invent nitpicks.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "architect",
    description: "software architecture and design: researches the codebase and produces an implementation blueprint / plan for a feature, refactor, or system before code is written",
    tools: ["read", "grep", "glob", "bash", "write"],
    skills: [],
    triggers: ["architecture", "design", "plan", "blueprint", "structure", "approach", "refactor", "restructure", "system design", "trade-off", "tradeoff"],
    systemPrompt: `You are a software architect. Given a feature or change, research the relevant existing code (grep/glob/read) and any external facts you need, then produce a precise implementation blueprint: goal in observable terms, key decisions each pinned, exact data shapes/interfaces, a file-by-file change list, edge cases, and a verification plan. Write the blueprint to .grayskull/plans/<slug>.md if the task asks you to persist it; otherwise return it as your report. Do not implement — design only. State every decision as final; no "maybe"/"or".`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "frontend-engineer",
    description: "frontend / UI implementation: builds and edits user interfaces, components, styling, layout, client-side state, and browser behavior (HTML/CSS/JS/TS, React, etc.)",
    tools: [...IMPL_TOOLS],
    skills: [],
    triggers: ["ui", "frontend", "front-end", "css", "html", "style", "styling", "theme", "dark mode", "layout", "button", "form", "page", "component", "responsive", "animation", "react", "modal", "menu", "navbar", "design"],
    systemPrompt: `You are a frontend engineer. Implement the UI/client-side slice of the task named in your prompt: components, layout, styling, interactions, and client state. Match the surrounding code's conventions and framework. Read neighboring files before writing so your code fits in. Run any available build/typecheck to confirm it compiles.

Report what you changed as a file-by-file list with a one-line rationale each, and note anything the caller still needs to wire up.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "backend-engineer",
    description: "backend / server implementation: builds APIs, endpoints, data models, business logic, persistence, and integration code (server-side)",
    tools: [...IMPL_TOOLS],
    skills: [],
    triggers: ["backend", "back-end", "server", "api", "endpoint", "route", "database", "db", "sql", "query", "schema", "auth", "authentication", "persistence", "migration", "integration", "webhook"],
    systemPrompt: `You are a backend engineer. Implement the server-side slice of the task named in your prompt: endpoints, data models, business logic, persistence, and integrations. Match the surrounding code's conventions. Read neighboring files and follow existing patterns before writing. Handle errors and edge cases; do not leave TODOs where real code is expected. Run any available build/typecheck.

Report what you changed as a file-by-file list with a one-line rationale each.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "test-engineer",
    description: "testing and quality: writes and runs unit/integration tests for the code named in the task, covering edge cases and failure paths",
    tools: [...IMPL_TOOLS],
    skills: [],
    triggers: ["test", "tests", "testing", "unit test", "integration test", "coverage", "spec", "specs", "test suite", "vitest", "jest", "pytest", "assert"],
    systemPrompt: `You are a test engineer. Write focused tests for the code named in your prompt using the project's existing test framework and layout (find it first — grep for test files, check package.json/config). Cover the happy path, edge cases, and failure modes. Run the tests and iterate until they pass or you have found a real bug in the code under test.

Report: the tests you added (paths), what they cover, the run result, and any real defect the tests surfaced.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "security-auditor",
    description: "security review: audits code for vulnerabilities — injection, auth/authorization flaws, secret handling, unsafe input, and insecure defaults",
    tools: [...DEFAULT_AGENT_TOOLS],
    skills: [],
    triggers: ["security", "vulnerability", "vulnerabilities", "exploit", "injection", "xss", "csrf", "ssrf", "auth", "authorization", "secret", "secrets", "credential", "sanitize", "insecure", "attack", "pentest"],
    systemPrompt: `You are a security auditor. Review the code or diff named in your task for real vulnerabilities: injection (SQL/command/path), broken auth or authorization, secret/credential exposure, unsafe deserialization, missing input validation, SSRF, and insecure defaults. Read the actual code and trace untrusted input to sinks before judging. Never modify files.

Report findings ranked by severity, each as: file:line — vulnerability class — concrete exploit scenario — fix. If nothing exploitable is present, say so plainly.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "docs-writer",
    description: "documentation: writes and updates READMEs, API docs, code comments, and usage guides for the code named in the task",
    tools: ["read", "grep", "glob", "write", "edit"],
    skills: [],
    triggers: ["docs", "documentation", "readme", "document", "guide", "changelog", "comment", "comments", "usage", "tutorial", "explain"],
    systemPrompt: `You are a documentation writer. Document the code named in your prompt: read it and its callers first so the docs are accurate, then write or update the relevant README / guide / doc-comments. Match the project's existing documentation style and level of detail. Show real, runnable usage examples; never invent APIs — verify every symbol you mention exists.

Report which files you wrote or changed and a one-line summary of each.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
];

/** built-in defs without the computed `enabled` flag (added at load time). */
export const BUILTIN_AGENTS: Array<Omit<AgentDef, "enabled">> = BUILTIN_AGENTS_RAW;

/** Tiny frontmatter parser — agent defs are `--- yaml ---\nsystem prompt`. */
function parseAgentFile(path: string, scope: "global" | "local"): Omit<AgentDef, "enabled"> | null {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (!meta["name"]) return null;
  const splitList = (s: string | undefined): string[] =>
    s ? s.split(",").map((t) => t.trim()).filter(Boolean) : [];
  return {
    name: meta["name"],
    description: meta["description"] ?? "",
    tools: meta["tools"] ? splitList(meta["tools"]) : [...DEFAULT_AGENT_TOOLS],
    skills: splitList(meta["skills"]),
    triggers: splitList(meta["triggers"] ?? meta["keywords"]),
    systemPrompt: m[2]!.trim(),
    scope,
    filePath: path,
  };
}

function loadDir(dir: string, scope: "global" | "local"): Array<Omit<AgentDef, "enabled">> {
  if (!existsSync(dir)) return [];
  const defs: Array<Omit<AgentDef, "enabled">> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const def = parseAgentFile(join(dir, file), scope);
      if (def) defs.push(def);
    } catch {
      // unreadable definition — skip
    }
  }
  return defs;
}

/** built-in < global < local on name clash. `disabled` (settings.disabledAgents)
 *  sets the computed `enabled` flag; the def is still returned so it can be
 *  listed/toggled in the UI. */
export function loadAgents(cwd: string, disabled: readonly string[] = []): AgentDef[] {
  const byName = new Map<string, Omit<AgentDef, "enabled">>();
  for (const def of BUILTIN_AGENTS) byName.set(def.name, def);
  for (const def of loadDir(GLOBAL_AGENTS_DIR, "global")) byName.set(def.name, def);
  for (const def of loadDir(localAgentsDir(cwd), "local")) byName.set(def.name, def);
  const off = new Set(disabled);
  return [...byName.values()].map((d) => ({ ...d, enabled: !off.has(d.name) }));
}

/** Only the personas that are on — what auto-trigger and spawn should see. */
export function enabledAgents(cwd: string, disabled: readonly string[] = []): AgentDef[] {
  return loadAgents(cwd, disabled).filter((a) => a.enabled);
}

/** System-message catalog: enabled personas only (disabled ones are neither
 *  advertised nor auto-triggered). */
export function agentListing(cwd: string, disabled: readonly string[] = []): string {
  const agents = enabledAgents(cwd, disabled);
  if (agents.length === 0) return "";
  return agents
    .map((a) => `- ${a.name}: ${a.description} (tools: ${a.tools.join(", ")})`)
    .join("\n");
}

// ── automatic persona triggering ─────────────────────────────────────────
// Mirror of skills' autoMatchSkills (skills/registry.ts): score each enabled
// persona against the prompt so the right specialist fires without the model
// having to remember to delegate.

const AUTO_MAX_AGENTS = 3;
/** description-overlap threshold for personas whose name isn't in the prompt */
const DESC_OVERLAP_MIN = 2;
/** everyday words in persona names that are weak intent on their own */
const GENERIC_NAME_PARTS = new Set(
  "engineer developer agent auditor writer reviewer explorer architect test tests code coder".split(" "),
);

export interface AgentMatch {
  agent: AgentDef;
  score: number;
}

/** Rank enabled personas by relevance to `text`. Same scoring shape as
 *  autoMatchSkills: distinctive name-part hits are strong intent, description
 *  token overlap is the softer signal. */
export function autoMatchAgents(text: string, cwd: string, disabled: readonly string[] = []): AgentDef[] {
  const promptTokens = tokenize(text);
  if (promptTokens.size === 0) return [];
  const agents = enabledAgents(cwd, disabled);
  const scored: AgentMatch[] = [];
  for (const agent of agents) {
    let score = 0;
    // distinctive name-part hit → strong intent ("frontend" in the prompt)
    for (const part of agent.name.toLowerCase().split(/[-_]/)) {
      if (part.length < 4 || GENERIC_NAME_PARTS.has(part)) continue;
      for (const t of promptTokens) {
        if (fuzzyTokenMatch(part, t)) {
          score += 2;
          break;
        }
      }
    }
    // explicit trigger keywords → the primary signal (a trigger may be a phrase
    // like "dark mode"; any of its distinctive words hitting the prompt counts)
    for (const trigger of agent.triggers) {
      const parts = trigger.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
      let hit = false;
      for (const w of parts) {
        for (const t of promptTokens) {
          if (fuzzyTokenMatch(w, t)) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) score += 2;
    }
    // description token overlap → softer corroboration
    const descTokens = tokenize(agent.description);
    let overlap = 0;
    for (const t of promptTokens) if (descTokens.has(t)) overlap++;
    if (score === 0 && overlap >= DESC_OVERLAP_MIN) score = overlap / 10;
    else if (score > 0) score += overlap / 20;
    if (score > 0) scored.push({ agent, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, AUTO_MAX_AGENTS).map((s) => s.agent);
}

/** The "delegate to specialists" block injected into the system message when
 *  personas match the current turn (see agent/loop.ts). */
export function agentDirectiveBlock(matches: AgentDef[]): string {
  if (matches.length === 0) return "";
  const lines = matches
    .map((a) => `- ${a.name}: owns the part of this task about "${a.description.split(":")[0]}". Give it a complete, self-contained task via spawn_agent.`)
    .join("\n");
  return (
    "# Delegate to specialists (this turn)\n" +
    "This request matches specialist personas below. Delegate each matching slice of the work to its persona with spawn_agent — run them concurrently when the slices are independent, and do NOT do their part yourself:\n" +
    lines
  );
}

export function writeAgentDef(opts: {
  cwd: string;
  scope: "global" | "local";
  name: string;
  description: string;
  tools: string[];
  skills?: string[];
  triggers?: string[];
  systemPrompt: string;
}): string {
  const dir = opts.scope === "global" ? GLOBAL_AGENTS_DIR : localAgentsDir(opts.cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opts.name}.md`);
  const skillsLine = opts.skills && opts.skills.length ? `\nskills: ${opts.skills.join(", ")}` : "";
  const triggersLine = opts.triggers && opts.triggers.length ? `\ntriggers: ${opts.triggers.join(", ")}` : "";
  const content = `---\nname: ${opts.name}\ndescription: ${opts.description}\ntools: ${opts.tools.join(", ")}${skillsLine}${triggersLine}\n---\n\n${opts.systemPrompt}\n`;
  writeFileSync(path, content);
  return path;
}

export function deleteAgentDef(cwd: string, name: string): boolean {
  const def = loadAgents(cwd).find((a) => a.name === name);
  if (!def || def.scope === "builtin") return false;
  unlinkSync(def.filePath);
  return true;
}

/** Flip a persona's enabled state. Returns the new disabled-list to persist in
 *  settings (caller writes it out). No-op filePath / built-in agnostic — the
 *  disabled list is the single source of truth, so built-ins toggle too. */
export function toggleAgentDisabled(current: readonly string[], name: string): string[] {
  const set = new Set(current);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  return [...set];
}
