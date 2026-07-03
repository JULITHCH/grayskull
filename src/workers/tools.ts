import { z } from "zod";
import type { ToolDef } from "../types";
import type { ToolRegistry } from "../tools";
import type { LlmClient } from "../llm/client";
import type { Settings } from "../config/settings";
import {
  writeWorkerDef, loadWorker, loadWorkers, saveWorkerConfig, missingConfig, workerListing,
} from "./registry";
import { runWorker } from "./runtime";
import { upsertJob, removeJob, jobListing, parseEvery } from "../scheduler/scheduler";

const fieldSchema = z.object({
  key: z.string().regex(/^[\w-]+$/).describe("config key, e.g. apiKey, webhookUrl, userId"),
  description: z.string().describe("What to ask the user for, precise enough that they can find the value (where to get it)."),
  secret: z.boolean().optional().describe("true for credentials/tokens — stored 0600, masked in listings"),
});

const createWorkerSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).describe("kebab-case worker name, e.g. linkedin-post"),
  description: z.string().describe("One line: what action this worker performs."),
  config_fields: z.array(fieldSchema).describe("Every credential/identifier the playbook needs from the user. Empty array if none."),
  instructions: z.string().describe(
    "The PLAYBOOK: exact, self-contained steps to perform the action with builtin tools (bash/curl for HTTP APIs, read/write for files). Reference config values by their key names. Include concrete API endpoints, request bodies, auth headers, and how to verify success. The worker runs UNATTENDED — cover error handling and edge cases.",
  ),
});

const configSchema = z.object({
  name: z.string().describe("worker name"),
  values: z.record(z.string(), z.string()).describe("config key → value map (ask the user for these values first)"),
});

const runSchema = z.object({
  name: z.string().describe("worker name"),
  task: z.string().describe("Concrete, self-contained task for this run, e.g. the message to post or the article topic."),
});

const scheduleSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).describe("kebab-case job name, e.g. weekly-linkedin-article"),
  worker: z.string().describe("worker to run (must exist and be configured)"),
  task: z.string().describe("What to do on every run — self-contained, the job has no other context. E.g. 'Write a fresh ~300-word article about <topic> and post it.'"),
  every: z.string().describe('interval: "30m", "2h", "1d", "1w"'),
  at: z.string().optional().describe('for 1d/1w: local time "HH:MM" to run at'),
  weekday: z.string().optional().describe('for 1w: "mon".."sun"'),
});

const removeJobSchema = z.object({ name: z.string().describe("job name to remove") });

/** create_worker / worker_config / run_worker / schedule_job / remove_job —
 *  the conversational path for "build me a worker that posts to X". */
export function registerWorkerTools(opts: {
  registry: ToolRegistry;
  client: LlmClient;
  settings: Settings;
  cwd: string;
}): void {
  const { registry, client, settings, cwd } = opts;

  const createWorker: ToolDef = {
    name: "create_worker",
    description:
      "Create a reusable WORKER (external-action plugin): a playbook for one kind of real-world action (post to a platform, call an API, send a message). Use when the user asks for a new capability, e.g. 'erstelle einen worker der auf LinkedIn posten kann'. Declare every credential/identifier as a config field — after creating, ask the user for the missing values (ask_user), save them with worker_config, then test with run_worker.",
    kind: "edit",
    schema: createWorkerSchema,
    describeCall: (args) => `create_worker(${String(args["name"] ?? "")})`,
    previewCall: async (args) => {
      const a = createWorkerSchema.parse(args);
      return `# ${a.name}\n${a.description}\nconfig: ${a.config_fields.map((f) => f.key + (f.secret ? " (secret)" : "")).join(", ") || "(none)"}\n\n${a.instructions}`;
    },
    execute: async (args) => {
      const a = createWorkerSchema.parse(args);
      const path = writeWorkerDef({
        name: a.name,
        description: a.description,
        fields: a.config_fields.map((f) => ({ key: f.key, description: f.description, ...(f.secret ? { secret: true } : {}) })),
        instructions: a.instructions,
      });
      const missing = missingConfig(loadWorker(a.name)!);
      return missing.length
        ? `Worker "${a.name}" created at ${path}. Missing config: ${missing.map((f) => `${f.key} (${f.description})`).join("; ")}. Ask the user for these values now (ask_user, one question covering all fields), then call worker_config. Never invent credential values.`
        : `Worker "${a.name}" created at ${path} and fully configured. Test it with run_worker.`;
    },
  };

  const workerConfig: ToolDef = {
    name: "worker_config",
    description: "Save config values (credentials, IDs) for a worker. Values come from the user — never invent them.",
    kind: "edit",
    schema: configSchema,
    describeCall: (args) => `worker_config(${String(args["name"] ?? "")}: ${Object.keys((args["values"] as object) ?? {}).join(", ")})`,
    execute: async (args) => {
      const a = configSchema.parse(args);
      const def = loadWorker(a.name);
      if (!def) return `error: no worker named "${a.name}". Existing: ${loadWorkers().map((w) => w.name).join(", ") || "(none)"}`;
      saveWorkerConfig(a.name, a.values);
      const missing = missingConfig(def);
      return missing.length
        ? `Saved. Still missing: ${missing.map((f) => `${f.key} (${f.description})`).join("; ")}`
        : `Saved — worker "${a.name}" is fully configured. Test it with run_worker before scheduling.`;
    },
  };

  const runWorkerTool: ToolDef = {
    name: "run_worker",
    description: "Run a configured worker once with a concrete task (also how you test a freshly created worker).",
    kind: "execute",
    schema: runSchema,
    describeCall: (args) => `run_worker(${String(args["name"] ?? "")}: ${String(args["task"] ?? "").slice(0, 50)})`,
    execute: async (args, ctx) => {
      const a = runSchema.parse(args);
      ctx.note(`⚙ worker ${a.name} → ${a.task.slice(0, 80)}`);
      try {
        const report = await runWorker({
          worker: a.name, task: a.task, client, settings, cwd,
          onNote: ctx.note,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return report.slice(0, 4000);
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
    },
  };

  const scheduleJob: ToolDef = {
    name: "schedule_job",
    description:
      "Create or update a recurring job: the scheduler (inside grayskull-web) runs the worker with the task at the interval. Example: weekly LinkedIn article → worker=linkedin-post, every=1w, weekday=mon, at=09:00. The worker must exist and be configured first.",
    kind: "edit",
    schema: scheduleSchema,
    describeCall: (args) => `schedule_job(${String(args["name"] ?? "")}: every ${String(args["every"] ?? "")})`,
    execute: async (args) => {
      const a = scheduleSchema.parse(args);
      if (!parseEvery(a.every)) return `error: invalid interval "${a.every}" — use like "30m", "2h", "1d", "1w"`;
      const def = loadWorker(a.worker);
      if (!def) return `error: no worker named "${a.worker}" — create it first with create_worker`;
      const missing = missingConfig(def);
      if (missing.length) return `error: worker "${a.worker}" missing config (${missing.map((f) => f.key).join(", ")}) — collect values and call worker_config first`;
      const job = upsertJob({
        name: a.name, worker: a.worker, task: a.task, every: a.every,
        ...(a.at ? { at: a.at } : {}), ...(a.weekday ? { weekday: a.weekday } : {}),
      });
      return `Job "${job.name}" scheduled — next run ${new Date(job.nextRun).toLocaleString()}. Jobs run while grayskull-web is up. Manage with /jobs.`;
    },
  };

  const removeJobTool: ToolDef = {
    name: "remove_job",
    description: "Remove a scheduled job by name.",
    kind: "edit",
    schema: removeJobSchema,
    describeCall: (args) => `remove_job(${String(args["name"] ?? "")})`,
    execute: async (args) => {
      const a = removeJobSchema.parse(args);
      return removeJob(a.name) ? `Job "${a.name}" removed.` : `no job named "${a.name}"`;
    },
  };

  for (const t of [createWorker, workerConfig, runWorkerTool, scheduleJob, removeJobTool]) registry.register(t);
}

/** System-prompt section: existing workers + jobs + how to extend them. */
export function workerPromptSection(): string {
  const workers = workerListing();
  const jobs = jobListing();
  const parts: string[] = [];
  if (workers) parts.push(`# Available workers (external-action plugins)\nRun with run_worker. Workers marked NEEDS CONFIG need worker_config first.\n${workers}`);
  if (jobs) parts.push(`# Scheduled jobs\n${jobs}`);
  parts.push(
    "# Extending capabilities\nWhen the user asks for a recurring action or a new external capability (posting somewhere, calling an API): create_worker builds the plugin, ask_user collects its credentials, worker_config stores them, run_worker tests it, schedule_job makes it recurring.",
  );
  return parts.join("\n\n");
}
