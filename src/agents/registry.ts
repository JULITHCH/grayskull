import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_AGENTS_DIR, localAgentsDir } from "../config/paths";
import type { AgentDef } from "../types";

export const DEFAULT_AGENT_TOOLS = ["read", "grep", "glob", "bash"];

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

/** local wins over global on name clash */
export function loadAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>();
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
  if (!def) return false;
  unlinkSync(def.filePath);
  return true;
}
