import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export const GLOBAL_DIR = join(
  process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
  "grayskull",
);

export const GLOBAL_SETTINGS = join(GLOBAL_DIR, "settings.json");
export const GLOBAL_SYSTEM_PROMPT = join(GLOBAL_DIR, "system-prompt.md");
export const GLOBAL_MEMORY = join(GLOBAL_DIR, "GRAYSKULL.md");
export const GLOBAL_LEGENDARY = join(GLOBAL_DIR, "legendarymode.md");
export const GLOBAL_AGENTS_DIR = join(GLOBAL_DIR, "agents");
export const GLOBAL_CHAINS_DIR = join(GLOBAL_DIR, "chains");
export const SESSIONS_DIR = join(GLOBAL_DIR, "sessions");

export function localDir(cwd: string): string {
  return join(cwd, ".grayskull");
}
export function localSettings(cwd: string): string {
  return join(localDir(cwd), "settings.json");
}
export function localSystemPrompt(cwd: string): string {
  return join(localDir(cwd), "system-prompt.md");
}
export function localMemory(cwd: string): string {
  return join(localDir(cwd), "memory.md");
}
export function localAgentsDir(cwd: string): string {
  return join(localDir(cwd), "agents");
}

export function ensureDirs(cwd: string): void {
  for (const dir of [GLOBAL_DIR, GLOBAL_AGENTS_DIR, GLOBAL_CHAINS_DIR, SESSIONS_DIR, localDir(cwd), localAgentsDir(cwd)]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
