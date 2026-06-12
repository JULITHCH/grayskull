import { spawnSync } from "node:child_process";

/**
 * Run an interactive program (editor, fzf) from inside Ink.
 * Ink keeps stdin in raw mode; hand the terminal over and restore after.
 */
function withTerminal<T>(fn: () => T): T {
  const wasRaw = process.stdin.isRaw;
  if (wasRaw) process.stdin.setRawMode(false);
  try {
    return fn();
  } finally {
    if (wasRaw) process.stdin.setRawMode(true);
  }
}

export function openInEditor(path: string, editor?: string): void {
  const cmd = editor ?? process.env["EDITOR"] ?? process.env["VISUAL"] ?? "nano";
  withTerminal(() => {
    spawnSync("sh", ["-c", `${cmd} ${JSON.stringify(path)}`], { stdio: "inherit" });
  });
}

/** fzf over project files; returns the picked path or null. */
export function pickFile(cwd: string): string | null {
  return withTerminal(() => {
    const list = spawnSync(
      "sh",
      ["-c", "git ls-files 2>/dev/null || find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^\\./||'"],
      { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
    const res = spawnSync("fzf", ["--height=40%", "--reverse", "--prompt=@ "], {
      cwd,
      input: list.stdout ?? "",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    });
    const picked = (res.stdout ?? "").trim();
    return picked || null;
  });
}

/** fzf over arbitrary labelled choices; returns the picked label or null. */
export function pickChoice(choices: string[], prompt: string): string | null {
  return withTerminal(() => {
    const res = spawnSync("fzf", ["--height=40%", "--reverse", `--prompt=${prompt} `], {
      input: choices.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    });
    const picked = (res.stdout ?? "").trim();
    return picked || null;
  });
}
