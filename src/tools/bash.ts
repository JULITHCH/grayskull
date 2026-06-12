import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "../types";

const MAX_OUTPUT = 30_000;

const schema = z.object({
  command: z.string().describe("The shell command to run (bash). Full GNU userland, git and fzf are available."),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe("Kill the command after this many seconds (default 120)."),
});

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Run a shell command in the project directory and return stdout+stderr. Use for git, builds, tests, and any GNU tool. Do NOT use for reading/writing files (use read/write/edit) or searching (use grep/glob).",
  kind: "execute",
  schema,
  describeCall: (args) => `bash(${String(args["command"] ?? "")})`,
  execute: async (args, ctx) => {
    const { command, timeout_seconds } = schema.parse(args);
    return await new Promise<string>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, (timeout_seconds ?? 120) * 1000);
      const collect = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("close", (code) => {
        clearTimeout(timer);
        let result = out.trim();
        if (out.length >= MAX_OUTPUT) result += "\n[output truncated]";
        if (killed) result += `\n[killed: exceeded ${timeout_seconds ?? 120}s timeout]`;
        else if (code !== 0) result += `\n[exit code ${code}]`;
        resolve(result || "(no output)");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`failed to spawn: ${err.message}`);
      });
    });
  },
};
