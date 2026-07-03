import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_DIR } from "../config/paths";
import type { Settings } from "../config/settings";
import type { LlmClient } from "../llm/client";
import { runWorker } from "../workers/runtime";
import { CHATS_CWD } from "../web/persist";

/**
 * Interval scheduler for worker jobs. Lives in the grayskull-web process (the
 * always-on daemon); the TUI only edits the same job file. Jobs run workers
 * headless and unattended — results land in the job log and an optional
 * broadcast hook (web UI toast/note).
 */
export const JOBS_FILE = join(GLOBAL_DIR, "jobs.json");
export const JOB_LOG_DIR = join(GLOBAL_DIR, "job-logs");

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface Job {
  name: string;
  /** worker to run; "" = plain prompt run of the task with the default worker-less agent is NOT supported — jobs always name a worker */
  worker: string;
  /** what to do each run, e.g. "write a short article about <topic> and post it" */
  task: string;
  /** interval: "30m" | "2h" | "1d" | "1w" */
  every: string;
  /** for 1d/1w intervals: local time "HH:MM" to run at */
  at?: string;
  /** for 1w intervals: "mon".."sun" */
  weekday?: string;
  enabled: boolean;
  createdAt: number;
  nextRun: number;
  lastRun?: number;
  lastStatus?: "ok" | "error";
  lastSummary?: string;
}

export function parseEvery(every: string): number | null {
  const m = every.trim().match(/^(\d+)\s*(m|min|h|d|w)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  const unit = m[2]!.toLowerCase();
  const ms = unit.startsWith("m") ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n * ms;
}

/** Next due time strictly after `from`. Day/week jobs with `at` (and
 *  `weekday`) align to wall-clock; everything else is from+interval. */
export function computeNextRun(job: Pick<Job, "every" | "at" | "weekday">, from: number): number {
  const interval = parseEvery(job.every) ?? 3_600_000;
  const atMatch = job.at?.match(/^(\d{1,2}):(\d{2})$/);
  if (!atMatch || interval < 86_400_000) return from + interval;
  const wantH = Math.min(23, Number(atMatch[1]));
  const wantM = Math.min(59, Number(atMatch[2]));
  const wantDay = job.weekday ? WEEKDAYS.indexOf(job.weekday.slice(0, 3).toLowerCase()) : -1;
  const d = new Date(from);
  d.setHours(wantH, wantM, 0, 0);
  // walk forward day by day until the slot is in the future and (for weekly
  // jobs) on the right weekday — bounded, 8 days covers every case
  for (let i = 0; i < 9; i++) {
    if (d.getTime() > from && (wantDay === -1 || d.getDay() === wantDay)) return d.getTime();
    d.setDate(d.getDate() + 1);
  }
  return from + interval;
}

export function loadJobs(): Job[] {
  try {
    return JSON.parse(readFileSync(JOBS_FILE, "utf8")) as Job[];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: Job[]): void {
  if (!existsSync(GLOBAL_DIR)) mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export function upsertJob(job: Omit<Job, "createdAt" | "nextRun" | "enabled"> & { enabled?: boolean }): Job {
  const jobs = loadJobs();
  const existing = jobs.find((j) => j.name === job.name);
  const merged: Job = {
    ...(existing ?? { createdAt: Date.now() }),
    ...job,
    enabled: job.enabled ?? existing?.enabled ?? true,
    nextRun: computeNextRun(job, Date.now()),
  } as Job;
  const rest = jobs.filter((j) => j.name !== job.name);
  saveJobs([...rest, merged]);
  return merged;
}

export function removeJob(name: string): boolean {
  const jobs = loadJobs();
  const rest = jobs.filter((j) => j.name !== name);
  if (rest.length === jobs.length) return false;
  saveJobs(rest);
  return true;
}

export function setJobEnabled(name: string, enabled: boolean): boolean {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.name === name);
  if (!job) return false;
  job.enabled = enabled;
  if (enabled) job.nextRun = computeNextRun(job, Date.now());
  saveJobs(jobs);
  return true;
}

export function jobListing(): string {
  const jobs = loadJobs().sort((a, b) => a.nextRun - b.nextRun);
  if (!jobs.length) return "";
  return jobs
    .map((j) => {
      const next = j.enabled ? new Date(j.nextRun).toLocaleString() : "disabled";
      const last = j.lastRun ? ` · last: ${j.lastStatus} ${new Date(j.lastRun).toLocaleString()}` : "";
      return `- ${j.name} → ${j.worker} every ${j.every}${j.at ? ` at ${j.at}` : ""}${j.weekday ? ` (${j.weekday})` : ""} · next: ${next}${last}\n    task: ${j.task.slice(0, 100)}`;
    })
    .join("\n");
}

/** The daemon's scheduler instance (set by grayskull-web); slash commands use
 *  it for "/jobs run" — null in a plain TUI process. */
let active: Scheduler | null = null;
export function setActiveScheduler(s: Scheduler | null): void {
  active = s;
}
export function activeScheduler(): Scheduler | null {
  return active;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  /** UI hook: job lifecycle events for browser toasts/notes. */
  onEvent: ((ev: { job: string; state: "start" | "ok" | "error"; summary?: string }) => void) | null = null;
  /** UI hook: every log line as it happens — live progress in the browser. */
  onNote: ((job: string, text: string) => void) | null = null;

  constructor(
    private client: LlmClient,
    private settings: Settings,
  ) {}

  start(): void {
    if (this.timer) return;
    if (!existsSync(JOB_LOG_DIR)) mkdirSync(JOB_LOG_DIR, { recursive: true });
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Check for due jobs; each runs at most once per tick and never twice
   *  concurrently. State is re-read from disk so TUI edits apply live. */
  async tick(now = Date.now()): Promise<void> {
    for (const job of loadJobs()) {
      if (!job.enabled || job.nextRun > now || this.running.has(job.name)) continue;
      // claim the slot first so a slow run can't double-fire
      const jobs = loadJobs();
      const j = jobs.find((x) => x.name === job.name);
      if (!j) continue;
      j.nextRun = computeNextRun(j, now);
      saveJobs(jobs);
      void this.runJob(job.name);
    }
  }

  /** Run one job immediately (used by the tick and by `/jobs run <name>`). */
  async runJob(name: string): Promise<string> {
    const job = loadJobs().find((j) => j.name === name);
    if (!job) return `no job named "${name}"`;
    if (this.running.has(name)) return `job "${name}" is already running`;
    this.running.add(name);
    this.onEvent?.({ job: name, state: "start" });
    const logPath = join(JOB_LOG_DIR, `${name}.log`);
    const log = (line: string) => {
      try {
        appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // logging must never break the run
      }
      this.onNote?.(name, line);
    };
    log(`RUN worker=${job.worker} task=${job.task}`);
    let status: "ok" | "error" = "ok";
    let summary = "";
    try {
      summary = await runWorker({
        worker: job.worker,
        task: job.task,
        client: this.client,
        settings: this.settings,
        cwd: CHATS_CWD,
        onNote: (t) => log(`  ${t}`),
      });
      if (/^FAILED/i.test(summary.trim())) status = "error";
    } catch (err) {
      status = "error";
      summary = (err as Error).message;
    } finally {
      this.running.delete(name);
    }
    log(`${status.toUpperCase()} ${summary.slice(0, 500).replace(/\n/g, " ")}`);
    const jobs = loadJobs();
    const j = jobs.find((x) => x.name === name);
    if (j) {
      j.lastRun = Date.now();
      j.lastStatus = status;
      j.lastSummary = summary.slice(0, 300);
      saveJobs(jobs);
    }
    this.onEvent?.({ job: name, state: status, summary: summary.slice(0, 300) });
    return summary;
  }
}
