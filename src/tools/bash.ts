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

      const collect = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        let result = out.trim();
        if (out.length >= MAX_OUTPUT) result += "\n[output truncated]";
        if (endReason === "timeout") {
          result += `\n[killed: exceeded ${timeout_seconds ?? 120}s timeout. If this was a server or watcher, background it with \`cmd > log 2>&1 &\` instead.]`;
        } else if (endReason === "interrupted") {
          result += "\n[killed: interrupted by user]";
        } else if (code !== 0) {
          result += `\n[exit code ${code}]`;
        }
        resolve(result || "(no output)");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(`failed to spawn: ${err.message}`);
      });
    });
  },
};
