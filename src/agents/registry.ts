import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_AGENTS_DIR, localAgentsDir } from "../config/paths";
import type { AgentDef } from "../types";

export const DEFAULT_AGENT_TOOLS = ["read", "grep", "glob", "bash"];

/** Always-available agents so spawn_agent works out of the box; a global or
 *  local def with the same name shadows the built-in. */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: "explorer",
    description: "read-only codebase search: finds files, symbols, and answers 'where/how is X done' questions",
    tools: [...DEFAULT_AGENT_TOOLS],
    systemPrompt: `You are a codebase explorer. Answer the question or find the thing described in your task using grep, glob, read, and read-only bash (rg, git log/blame, ls). Be thorough: try several naming conventions and search angles before concluding something does not exist. Never modify files.

Report: the direct answer first, then evidence as file:line references each with a one-line excerpt. If you found nothing, list exactly what you searched so the caller can trust the negative.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "reviewer",
    description: "read-only code review: hunts real bugs in the files or diff named in the task",
    tools: [...DEFAULT_AGENT_TOOLS],
    systemPrompt: `You are a code reviewer. Review the files or diff named in your task for real bugs: logic errors, unhandled edge cases, race conditions, resource leaks, security issues. Read the actual code and follow callers/callees with grep before judging. Never modify files.

Report findings ranked by severity, each as: file:line — problem — concrete failure scenario — suggested fix. If the code is fine, say so plainly; do not invent nitpicks.`,
    scope: "builtin",
    filePath: "(built-in)",
  },
];

/** Tiny frontmatter parser — agent defs are `--- yaml ---\nsystem prompt`. */
function parseAgentFile(path: string, scope: "global" | "local"): AgentDef | null {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (!meta["name"]) return null;
  return {
    name: meta["name"],
    description: meta["description"] ?? "",
    tools: meta["tools"]
      ? meta["tools"].split(",").map((t) => t.trim()).filter(Boolean)
      : [...DEFAULT_AGENT_TOOLS],
    systemPrompt: m[2]!.trim(),
    scope,
    filePath: path,
  };
}

function loadDir(dir: string, scope: "global" | "local"): AgentDef[] {
  if (!existsSync(dir)) return [];
  const defs: AgentDef[] = [];
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

/** built-in < global < local on name clash */
export function loadAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const def of BUILTIN_AGENTS) byName.set(def.name, def);
  for (const def of loadDir(GLOBAL_AGENTS_DIR, "global")) byName.set(def.name, def);
  for (const def of loadDir(localAgentsDir(cwd), "local")) byName.set(def.name, def);
  return [...byName.values()];
}

export function agentListing(cwd: string): string {
  const agents = loadAgents(cwd);
  if (agents.length === 0) return "";
  return agents
    .map((a) => `- ${a.name}: ${a.description} (tools: ${a.tools.join(", ")})`)
    .join("\n");
}

export function writeAgentDef(opts: {
  cwd: string;
  scope: "global" | "local";
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
}): string {
  const dir = opts.scope === "global" ? GLOBAL_AGENTS_DIR : localAgentsDir(opts.cwd);
  const path = join(dir, `${opts.name}.md`);
  const content = `---\nname: ${opts.name}\ndescription: ${opts.description}\ntools: ${opts.tools.join(", ")}\n---\n\n${opts.systemPrompt}\n`;
  writeFileSync(path, content);
  return path;
}

export function deleteAgentDef(cwd: string, name: string): boolean {
  const def = loadAgents(cwd).find((a) => a.name === name);
  if (!def || def.scope === "builtin") return false;
  unlinkSync(def.filePath);
  return true;
}
