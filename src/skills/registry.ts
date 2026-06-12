import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { GLOBAL_DIR, localDir } from "../config/paths";

export interface SkillDef {
  name: string;
  description: string;
  /** SKILL.md body — the instructions injected when the skill is invoked */
  body: string;
  dir: string;
  source: "local" | "global" | "claude-local" | "claude-global" | "claude-plugin";
}

/** Claude Code skill format: <dir>/<name>/SKILL.md with YAML frontmatter. */
function parseSkillFile(path: string, fallbackName: string, source: SkillDef["source"]): SkillDef | null {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) {
    const lines = m[1]!.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i]!.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      let value = kv[2]!.trim();
      // YAML block scalars: `description: >` / `|` followed by indented lines
      if (/^[>|][+-]?$/.test(value)) {
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
          block.push(lines[++i]!.trim());
        }
        value = block.join(value.startsWith("|") ? "\n" : " ");
      }
      meta[kv[1]!] = value.replace(/^["']|["']$/g, "");
    }
  }
  const body = (m ? m[2]! : raw).trim();
  if (!body) return null;
  return {
    name: meta["name"] ?? fallbackName,
    description: meta["description"] ?? "",
    body,
    dir: join(path, ".."),
    source,
  };
}

function loadDir(dir: string, source: SkillDef["source"]): SkillDef[] {
  if (!existsSync(dir)) return [];
  const skills: SkillDef[] = [];
  const tryLoad = (skillFile: string, fallbackName: string) => {
    if (!existsSync(skillFile)) return;
    try {
      const def = parseSkillFile(skillFile, fallbackName, source);
      if (def) skills.push(def);
    } catch {
      // unreadable skill — skip
    }
  };
  // a SKILL.md placed directly in the skills dir (seen in the wild)
  tryLoad(join(dir, "SKILL.md"), dir.split("/").slice(-2, -1)[0] ?? "skill");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    tryLoad(join(dir, entry.name, "SKILL.md"), entry.name);
  }
  return skills;
}

/** Installed Claude Code plugins: cache/<marketplace>/<plugin>/<hash>/skills/<name>/SKILL.md */
function pluginSkillDirs(): string[] {
  const cache = join(homedir(), ".claude", "plugins", "cache");
  if (!existsSync(cache)) return [];
  const dirs: string[] = [];
  try {
    for (const marketplace of readdirSync(cache, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const mpDir = join(cache, marketplace.name);
      for (const plugin of readdirSync(mpDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const pluginDir = join(mpDir, plugin.name);
        for (const hash of readdirSync(pluginDir, { withFileTypes: true })) {
          if (!hash.isDirectory()) continue;
          const skillsDir = join(pluginDir, hash.name, "skills");
          if (existsSync(skillsDir)) dirs.push(skillsDir);
        }
      }
    }
  } catch {
    // plugin cache unreadable — fine
  }
  return dirs;
}

/**
 * Precedence on name clash: project .grayskull > global grayskull >
 * project .claude > ~/.claude (the Claude Code dirs are read for compatibility,
 * so existing skills work without copying).
 */
export function loadSkills(cwd: string): SkillDef[] {
  const byName = new Map<string, SkillDef>();
  const sources: Array<[string, SkillDef["source"]]> = [
    ...pluginSkillDirs().map((d): [string, SkillDef["source"]] => [d, "claude-plugin"]),
    [join(homedir(), ".claude", "skills"), "claude-global"],
    [join(cwd, ".claude", "skills"), "claude-local"],
    [join(GLOBAL_DIR, "skills"), "global"],
    [join(localDir(cwd), "skills"), "local"],
  ];
  for (const [dir, source] of sources) {
    for (const def of loadDir(dir, source)) byName.set(def.name, def);
  }
  return [...byName.values()];
}

export function skillListing(cwd: string): string {
  const skills = loadSkills(cwd);
  if (skills.length === 0) return "";
  // official skill packs ship very long descriptions — cap them so 25+ skills
  // don't eat the context window every turn (the body loads on invocation)
  return skills
    .map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
}

/** The message sent to the model when a skill fires (tool call or /name). */
export function skillInvocation(skill: SkillDef, args: string): string {
  return [
    `[Skill "${skill.name}" invoked. Follow these instructions now. Files referenced relative to the skill live in ${skill.dir}]`,
    skill.body,
    args ? `\nUser arguments: ${args}` : "",
  ].join("\n");
}
