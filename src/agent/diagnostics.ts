import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Auto-diagnostics: after every edit/write the project's check command runs
 * and failures are injected into the tool result. Compiler truth corrects a
 * mid-size model in the same turn — no prompting discipline required.
 *
 * Command resolution (first hit wins):
 *   1. `diagnostics.command` in settings (.grayskull/settings.json)
 *   2. package.json with a "typecheck" script  → bun run typecheck
 *   3. tsconfig.json                           → bunx tsc --noEmit
 *   4. Cargo.toml                              → cargo check -q
 *   5. go.mod                                  → go vet ./...
 *   6. pyproject.toml + ruff on PATH           → ruff check .
 *   7. none → diagnostics off for this project
 */

const MAX_DIAG_CHARS = 2000;
const TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  command: string | null;
  at: number;
}
const commandCache = new Map<string, CacheEntry>();

function readDiagSettings(cwd: string): { enabled: boolean; command?: string } {
  // read the merged settings lazily and cheaply — avoid import cycles with config
  try {
    const local = join(cwd, ".grayskull", "settings.json");
    if (existsSync(local)) {
      const parsed = JSON.parse(readFileSync(local, "utf8")) as Record<string, unknown>;
      const d = parsed["diagnostics"] as { enabled?: boolean; command?: string } | undefined;
      if (d) return { enabled: d.enabled !== false, command: d.command };
    }
  } catch {
    // unparsable settings — fall through to auto-detection
  }
  return { enabled: true };
}

function detectCommand(cwd: string): string | null {
  const cached = commandCache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.command;

  const cfg = readDiagSettings(cwd);
  let command: string | null = null;
  if (!cfg.enabled) {
    command = null;
  } else if (cfg.command) {
    command = cfg.command;
  } else if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.["typecheck"]) command = "bun run typecheck";
    } catch {
      // unreadable package.json
    }
    if (!command && existsSync(join(cwd, "tsconfig.json"))) command = "bunx tsc --noEmit";
  } else if (existsSync(join(cwd, "tsconfig.json"))) {
    command = "bunx tsc --noEmit";
  } else if (existsSync(join(cwd, "Cargo.toml"))) {
    command = "cargo check -q --message-format short";
  } else if (existsSync(join(cwd, "go.mod"))) {
    command = "go vet ./...";
  } else if (existsSync(join(cwd, "pyproject.toml"))) {
    const hasRuff = spawnSync("which", ["ruff"], { encoding: "utf8" }).status === 0;
    if (hasRuff) command = "ruff check .";
  }

  commandCache.set(cwd, { command, at: Date.now() });
  return command;
}

/**
 * Run the project's check after a file change. Returns a message to append
 * to the tool result when problems are found, null when clean/unavailable.
 */
export function runDiagnostics(cwd: string): string | null {
  const command = detectCommand(cwd);
  if (!command) return null;
  try {
    const res = spawnSync("bash", ["-c", command], {
      cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: { ...process.env, PATH: `${process.env["HOME"]}/.bun/bin:${process.env["PATH"]}` },
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status === 0) return null;
    let out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    if (!out) out = `(check failed with exit code ${res.status})`;
    if (out.length > MAX_DIAG_CHARS) out = out.slice(0, MAX_DIAG_CHARS) + "\n[diagnostics truncated]";
    return `[auto-diagnostics — \`${command}\` FAILED after your change. Fix these before doing anything else:]\n${out}`;
  } catch {
    return null;
  }
}
