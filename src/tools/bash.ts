import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "../types";

const MAX_OUTPUT = 30_000;

const schema = z.object({
  command: z.string().describe("The shell command to run (bash). Full GNU userland, git and fzf are available. NEVER start servers or watchers in the foreground — they block the session; background them (`cmd > log 2>&1 &`) or use a short timeout_seconds."),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe("Kill the command after this many seconds (default 120)."),
});

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Run a shell command in the project directory and return stdout+stderr. Use for git, builds, tests, and any GNU tool. Do NOT use for reading/writing files (use read/write/edit) or searching (use grep/glob). Long-running processes (dev servers, watchers) must be backgrounded with & — a foreground server blocks everything.",
  kind: "execute",
  schema,
  describeCall: (args) => `bash(${String(args["command"] ?? "")})`,
  execute: async (args, ctx) => {
    const { command, timeout_seconds } = schema.parse(args);
    return await new Promise<string>((resolve) => {
      // own process group so we can kill the command AND its children
      // (a plain kill on `bash -c` leaves spawned servers alive)
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let out = "";
      let endReason: "ok" | "timeout" | "interrupted" = "ok";
      let settled = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const killGroup = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const timer = setTimeout(() => {
        endReason = "timeout";
        killGroup();
      }, (timeout_seconds ?? 120) * 1000);
      // esc stops the turn — it must also stop whatever bash is running
      const onAbort = () => {
        endReason = "interrupted";
        killGroup();
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      const settle = (code: number | null, backgroundAlive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        ctx.signal?.removeEventListener("abort", onAbort);
        let result = out.trim();
        if (out.length >= MAX_OUTPUT) result += "\n[output truncated]";
        if (endReason === "timeout") {
          result += `\n[killed: exceeded ${timeout_seconds ?? 120}s timeout. If this was a server or watcher, background it with \`cmd > log 2>&1 &\` instead.]`;
        } else if (endReason === "interrupted") {
          result += "\n[killed: interrupted by user]";
        } else if (code !== 0 && code !== null) {
          result += `\n[exit code ${code}]`;
        }
        if (backgroundAlive) {
          result += "\n[a backgrounded process you started is still running]";
        }
        resolve(result || "(no output)");
      };

      const collect = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      // 'close' waits for the stdio pipes — a backgrounded server inherits
      // them and holds them open forever. Resolve shortly after 'exit'
      // instead, leaving the background process running as intended.
      child.on("exit", (code) => {
        graceTimer = setTimeout(() => {
          // keep the pipes open (destroying them would EPIPE-kill the
          // background process on its next write) but discard further output
          child.stdout.removeListener("data", collect).resume();
          child.stderr.removeListener("data", collect).resume();
          settle(code, true);
        }, 1500);
      });
      child.on("close", (code) => settle(code, false));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(`failed to spawn: ${err.message}`);
      });
    });
  },
};
