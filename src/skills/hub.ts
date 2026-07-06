import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GLOBAL_DIR, localDir } from "../config/paths";
import type { SkillRepoConfig } from "../config/settings";
import { parseSkillMarkdown } from "./registry";

/**
 * Skill hub — browse remote skill databases (GitHub repos of
 * <dir>/SKILL.md skills) and install them locally. One tree-API request per
 * repo, cached for a day under the config dir; SKILL.md bodies and installed
 * files come from raw.githubusercontent.com (no API rate limit). Works with
 * any repo that follows the Claude Code skill layout — add more in settings
 * (`skillRepos`).
 */

const CACHE_DIR = join(GLOBAL_DIR, "skill-repos");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** installer safety caps — a skill dir is docs + a few scripts, not a repo */
const MAX_SKILL_FILES = 50;
const MAX_FILE_BYTES = 1024 * 1024;

export interface RemoteSkill {
  /** dir basename — the name it installs under */
  name: string;
  /** repo-relative path of the skill dir */
  path: string;
  /** "owner/name" */
  repo: string;
  /** branch/ref the listing came from */
  ref: string;
  /** configured source name (settings.skillRepos[].name) */
  source: string;
}

export interface RemoteSkillDetail extends RemoteSkill {
  description: string;
  body: string;
  /** files bundled with the skill (repo-relative), SKILL.md included */
  files: string[];
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

interface RepoListing {
  ref: string;
  truncated: boolean;
  tree: TreeEntry[];
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": "grayskull" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function cachePath(repo: SkillRepoConfig): string {
  return join(CACHE_DIR, `${repo.name.replace(/[^\w.-]/g, "_")}.json`);
}

/** Full recursive tree of the repo, cached 24h (modelsdev.ts pattern):
 *  fresh cache → no network; fetch failure → stale cache if present. */
async function loadListing(repo: SkillRepoConfig): Promise<RepoListing> {
  const cache = cachePath(repo);
  const fresh = existsSync(cache) && Date.now() - statSync(cache).mtimeMs < CACHE_TTL_MS;
  if (!fresh) {
    const ref = repo.branch ?? "HEAD";
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { headers: ghHeaders(), signal: AbortSignal.timeout(20000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { truncated?: boolean; tree?: TreeEntry[] };
        if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
        const listing: RepoListing = {
          ref,
          truncated: data.truncated ?? false,
          tree: (data.tree ?? [])
            .filter((t) => t.type === "blob")
            .map((t) => ({ path: t.path, type: t.type, ...(t.size !== undefined ? { size: t.size } : {}) })),
        };
        writeFileSync(cache, JSON.stringify(listing));
      } else if (!existsSync(cache)) {
        throw new Error(`GitHub ${res.status} for ${repo.repo} (rate limit? set GITHUB_TOKEN)`);
      }
    } catch (err) {
      if (!existsSync(cache)) {
        throw new Error(`skill repo ${repo.name} unreachable: ${(err as Error).message}`);
      }
      // offline — fall through to the stale cache
    }
  }
  return JSON.parse(readFileSync(cache, "utf8")) as RepoListing;
}

/** All skills in one configured repo: every <dir>/SKILL.md under `subdir`. */
export async function listRepoSkills(repo: SkillRepoConfig): Promise<RemoteSkill[]> {
  const listing = await loadListing(repo);
  const prefix = repo.subdir ? repo.subdir.replace(/\/$/, "") + "/" : "";
  const skills: RemoteSkill[] = [];
  for (const entry of listing.tree) {
    if (!entry.path.endsWith("/SKILL.md")) continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const dir = dirname(entry.path);
    skills.push({
      name: dir.split("/").pop()!,
      path: dir,
      repo: repo.repo,
      ref: listing.ref,
      source: repo.name,
    });
  }
  return skills;
}

/** Load the full catalog across all enabled repos. Repos that fail to load
 *  are skipped (reported via onError). */
export async function loadHub(
  repos: SkillRepoConfig[],
  onError?: (repo: string, message: string) => void,
): Promise<RemoteSkill[]> {
  const enabled = repos.filter((r) => !r.disabled);
  const lists = await Promise.all(
    enabled.map(async (r) => {
      try {
        return await listRepoSkills(r);
      } catch (err) {
        onError?.(r.name, (err as Error).message);
        return [];
      }
    }),
  );
  return lists.flat();
}

/** Rank a loaded catalog against a query (pure — UIs filter per keystroke).
 *  Empty query = everything. Ranking: exact name > name prefix > name
 *  substring > path substring. */
export function rankSkills(all: RemoteSkill[], query: string, max = 50): RemoteSkill[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ skill: RemoteSkill; score: number }> = [];
  for (const skill of all) {
    const name = skill.name.toLowerCase();
    const path = skill.path.toLowerCase();
    if (words.length === 0) {
      scored.push({ skill, score: 0 });
      continue;
    }
    if (!words.every((w) => name.includes(w) || path.includes(w))) continue;
    let score = 1;
    for (const w of words) {
      if (name === w) score += 8;
      else if (name.startsWith(w)) score += 4;
      else if (name.includes(w)) score += 2;
    }
    scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, max).map((s) => s.skill);
}

/** One-shot search across all enabled repos (loadHub + rankSkills). */
export async function searchHub(
  repos: SkillRepoConfig[],
  query: string,
  max = 50,
  onError?: (repo: string, message: string) => void,
): Promise<RemoteSkill[]> {
  return rankSkills(await loadHub(repos, onError), query, max);
}

function rawUrl(skill: RemoteSkill, path: string): string {
  return `https://raw.githubusercontent.com/${skill.repo}/${skill.ref}/${path}`;
}

async function fetchRaw(url: string): Promise<string> {
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`fetch failed (${res.status}): ${url}`);
  return res.text();
}

/** SKILL.md frontmatter + body + bundled file list for one remote skill. */
export async function fetchSkillDetail(
  skill: RemoteSkill,
  repos: SkillRepoConfig[],
): Promise<RemoteSkillDetail> {
  const raw = await fetchRaw(rawUrl(skill, `${skill.path}/SKILL.md`));
  const parsed = parseSkillMarkdown(raw, skill.name);
  const conf = repos.find((r) => r.name === skill.source);
  let files = [`${skill.path}/SKILL.md`];
  if (conf) {
    try {
      const listing = await loadListing(conf);
      files = listing.tree
        .filter((t) => t.path.startsWith(skill.path + "/") && (t.size ?? 0) <= MAX_FILE_BYTES)
        .map((t) => t.path)
        .slice(0, MAX_SKILL_FILES);
    } catch {
      // listing gone stale/unreachable — SKILL.md alone still installs
    }
  }
  return {
    ...skill,
    description: parsed?.description ?? "",
    body: parsed?.body ?? raw,
    files,
  };
}

export type InstallScope = "local" | "global";

export function skillInstallDir(scope: InstallScope, cwd: string): string {
  return scope === "local" ? join(localDir(cwd), "skills") : join(GLOBAL_DIR, "skills");
}

/** Download every file of the skill dir into <root>/skills/<name>/. Returns
 *  the install dir and file count. Existing files are overwritten (upgrade). */
export async function installSkill(
  detail: RemoteSkillDetail,
  scope: InstallScope,
  cwd: string,
): Promise<{ dir: string; fileCount: number }> {
  const dest = join(skillInstallDir(scope, cwd), detail.name);
  let count = 0;
  for (const file of detail.files) {
    const rel = file.slice(detail.path.length + 1);
    const content = await fetchRaw(rawUrl(detail, file));
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    count++;
  }
  return { dir: dest, fileCount: count };
}

const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description || "TODO: one line — when should this skill fire?"}
---

TODO: instructions the agent follows when the skill is invoked.

- Keep it a concrete, step-by-step playbook.
- Files next to this SKILL.md can be referenced relative to the skill dir.
`;

/** Scaffold a new local skill: <root>/skills/<name>/SKILL.md. Errors if a
 *  skill dir with that name already exists in the chosen scope. */
export function createSkill(
  name: string,
  description: string,
  scope: InstallScope,
  cwd: string,
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid skill name "${name}" — use lowercase letters, digits, dashes`);
  }
  const dir = join(skillInstallDir(scope, cwd), name);
  const file = join(dir, "SKILL.md");
  if (existsSync(file)) throw new Error(`skill already exists: ${file}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, SKILL_TEMPLATE(name, description));
  return file;
}
