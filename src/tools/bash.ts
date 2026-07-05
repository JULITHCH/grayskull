import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "../types";

const MAX_OUTPUT = 30_000;
const BG_BUFFER_MAX = 200_000;

const schema = z.object({
  command: z.string().describe("The shell command to run (bash). Full GNU userland, git and fzf are available. NEVER start servers or watchers in the foreground — they block the session; run them with background=true (preferred) or use a short timeout_seconds."),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe("Kill the command after this many seconds (default 120). Ignored with background=true."),
  background: z.boolean().optional().describe("Run detached and return immediately with a job id. For dev servers, watchers, long builds. Read output later with bash_output."),
});

/** Detached background jobs (dev servers, watchers) — survive the turn, output
 *  buffered for bash_output. Session-scoped; killed only via bash_output kill
 *  or process exit. */
interface BgJob {
  id: string;
  command: string;
  pid: number | undefined;
  buffer: string;
  /** chars the model has already seen via bash_output */
  readOffset: number;
  /** chars dropped from the front when the buffer overflowed */
  dropped: number;
  exited: number | null;
  startedAt: number;
}

const bgJobs = new Map<string, BgJob>();
let bgSeq = 1;

function startBackground(command: string, cwd: string): string {
  const child = spawn("bash", ["-c", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const job: BgJob = {
    id: `b${bgSeq++}`,
    command,
    pid: child.pid,
    buffer: "",
    readOffset: 0,
    dropped: 0,
    exited: null,
    startedAt: Date.now(),
  };
  const collect = (chunk: Buffer) => {
    job.buffer += chunk.toString("utf8");
    if (job.buffer.length > BG_BUFFER_MAX) {
      const cut = job.buffer.length - BG_BUFFER_MAX;
      job.buffer = job.buffer.slice(cut);
      job.dropped += cut;
      job.readOffset = Math.max(0, job.readOffset - cut);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code) => {
    job.exited = code ?? -1;
  });
  child.on("error", () => {
    job.exited = -1;
    job.buffer += "\n[failed to spawn]";
  });
  child.unref();
  bgJobs.set(job.id, job);
  return job.id;
}

function killJobGroup(job: BgJob): void {
  if (job.pid) {
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      try {
        process.kill(job.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

const bgStatus = (j: BgJob) =>
  j.exited === null ? "running" : `exited ${j.exited}`;

const outputSchema = z.object({
  id: z.string().optional().describe("Background job id (e.g. \"b1\"). Omit to list all background jobs."),
  kill: z.boolean().optional().describe("Kill the job (and its process group) after reading its output."),
});

export const bashOutputTool: ToolDef = {
  name: "bash_output",
  description:
    "Read NEW output from a background bash job (started with bash background=true) since the last read. Omit id to list all jobs. kill=true stops the job.",
  kind: "read",
  schema: outputSchema,
  describeCall: (args) => `bash_output(${String(args["id"] ?? "list")}${args["kill"] ? ", kill" : ""})`,
  execute: async (args) => {
    const { id, kill } = outputSchema.parse(args);
    if (!id) {
      if (bgJobs.size === 0) return "no background jobs";
      return [...bgJobs.values()]
        .map((j) => `${j.id} [${bgStatus(j)}] ${Math.round((Date.now() - j.startedAt) / 1000)}s — ${j.command.slice(0, 100)}`)
        .join("\n");
    }
    const job = bgJobs.get(id);
    if (!job) return `no background job "${id}" — known: ${[...bgJobs.keys()].join(", ") || "(none)"}`;
    const fresh = job.buffer.slice(job.readOffset);
    job.readOffset = job.buffer.length;
    let result = `[${job.id} ${bgStatus(job)}]`;
    if (job.dropped > 0) result += ` (${job.dropped} early chars dropped)`;
    result += fresh ? `\n${fresh}` : "\n(no new output)";
    if (kill) {
      if (job.exited === null) {
        killJobGroup(job);
        result += "\n[killed]";
      }
      bgJobs.delete(job.id);
    }
    return result;
  },
};

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Run a shell command in the project directory and return stdout+stderr. Use for git, builds, tests, and any GNU tool. Do NOT use for reading/writing files (use read/write/edit) or searching (use grep/glob). Long-running processes (dev servers, watchers) must use background=true — a foreground server blocks everything.",
  kind: "execute",
  schema,
  describeCall: (args) => `bash(${String(args["command"] ?? "")}${args["background"] ? " &" : ""})`,
  execute: async (args, ctx) => {
    const { command, timeout_seconds, background } = schema.parse(args);
    if (background) {
      const id = startBackground(command, ctx.cwd);
      return `[background job ${id} started] — read output with bash_output(id="${id}"), stop with bash_output(id="${id}", kill=true)`;
    }
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
