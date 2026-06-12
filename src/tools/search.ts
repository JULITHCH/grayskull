import { z } from "zod";
import { spawnSync } from "node:child_process";
import type { ToolDef } from "../types";

const grepSchema = z.object({
  pattern: z.string().describe("Regex (POSIX extended) to search for."),
  path: z.string().optional().describe("Directory or file to search (default: project root)."),
  glob: z.string().optional().describe("Only search files matching this glob, e.g. '*.ts'."),
  ignore_case: z.boolean().optional(),
});

export const grepTool: ToolDef = {
  name: "grep",
  description: "Search file contents with a regex. Returns matching lines as file:line:text. Skips .git and node_modules.",
  kind: "read",
  schema: grepSchema,
  describeCall: (args) => `grep(${String(args["pattern"] ?? "")})`,
  execute: async (args, ctx) => {
    const { pattern, path, glob, ignore_case } = grepSchema.parse(args);
    const flags = ["-rnE", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=.grayskull"];
    if (ignore_case) flags.push("-i");
    if (glob) flags.push(`--include=${glob}`);
    const res = spawnSync("grep", [...flags, pattern, path ?? "."], {
      cwd: ctx.cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.error) return `grep failed: ${res.error.message}`;
    const out = (res.stdout ?? "").trim();
    if (!out) return "no matches";
    const lines = out.split("\n");
    if (lines.length > 200) {
      return lines.slice(0, 200).join("\n") + `\n[${lines.length - 200} more matches — narrow the pattern]`;
    }
    return out;
  },
};

const globSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'."),
});

export const globTool: ToolDef = {
  name: "glob",
  description: "List files matching a glob pattern, relative to the project root.",
  kind: "read",
  schema: globSchema,
  describeCall: (args) => `glob(${String(args["pattern"] ?? "")})`,
  execute: async (args, ctx) => {
    const { pattern } = globSchema.parse(args);
    const matches: string[] = [];
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan({ cwd: ctx.cwd, dot: false })) {
      if (file.includes("node_modules/") || file.startsWith(".git/")) continue;
      matches.push(file);
      if (matches.length >= 500) break;
    }
    matches.sort();
    if (matches.length === 0) return "no files match";
    let out = matches.join("\n");
    if (matches.length >= 500) out += "\n[truncated at 500 files]";
    return out;
  },
};
