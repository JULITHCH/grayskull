import { spawnSync } from "node:child_process";
import type { Settings } from "../config/settings";

/**
 * User lifecycle hooks — shell commands from settings.hooks, run at tool-loop
 * events (Claude Code conventions):
 *
 *   PreToolUse       before a tool executes; exit code 2 BLOCKS the call and
 *                    stderr becomes the tool result the model sees
 *   PostToolUse      after a tool executes; stdout is appended to the result
 *   Stop             when the model wants to end the turn; exit code 2 blocks
 *                    the turn end and stderr is injected as a user message
 *   UserPromptSubmit before a prompt starts; stdout is appended as context
 *
 * The JSON payload arrives on stdin. Hooks are trusted user config: they run
 * with the session's env in the project cwd. Failures (non-0/2 exits, spawn
 * errors, timeouts) degrade silently — a broken hook must never take the
 * session down.
 */

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit";

export interface HookPayload {
  event: HookEvent;
  cwd: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  prompt?: string;
}

export interface HookOutcome {
  /** exit code 2: the action is blocked; message = stderr (or a default) */
  block?: string;
  /** stdout of non-blocking hooks, joined — appended as extra context */
  output?: string;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return re.test(value);
}

export class HookRunner {
  constructor(
    private settings: Settings,
    private cwd: string,
    /** surface hook activity in the transcript (blocked calls, hook errors) */
    private note: (text: string) => void = () => {},
  ) {}

  /** True if any hook is configured for the event (cheap pre-check so the hot
   *  tool loop skips JSON serialization when there is nothing to run). */
  has(event: HookEvent): boolean {
    return this.settings.hooks.some((h) => h.event === event);
  }

  run(event: HookEvent, payload: Omit<HookPayload, "event" | "cwd">): HookOutcome {
    const outcome: HookOutcome = {};
    const outputs: string[] = [];
    for (const hook of this.settings.hooks) {
      if (hook.event !== event) continue;
      if (hook.matcher && payload.toolName && !globMatch(hook.matcher, payload.toolName)) continue;
      try {
        const res = spawnSync("bash", ["-c", hook.command], {
          cwd: this.cwd,
          input: JSON.stringify({ event, cwd: this.cwd, ...payload }),
          encoding: "utf8",
          timeout: hook.timeoutSeconds * 1000,
          env: process.env,
        });
        if (res.error) {
          this.note(`⚠ hook ${event} failed to run: ${res.error.message}`);
          continue;
        }
        if (res.status === 2) {
          const msg = (res.stderr || "").trim() || `blocked by a ${event} hook`;
          this.note(`⛔ hook ${event} blocked: ${msg.slice(0, 120)}`);
          outcome.block = msg;
          return outcome; // first block wins, later hooks don't run
        }
        if (res.status !== 0) {
          this.note(`⚠ hook ${event} exited ${res.status}: ${(res.stderr || "").trim().slice(0, 120)}`);
          continue;
        }
        const out = (res.stdout || "").trim();
        if (out) outputs.push(out);
      } catch (err) {
        this.note(`⚠ hook ${event} error: ${(err as Error).message}`);
      }
    }
    if (outputs.length) outcome.output = outputs.join("\n");
    return outcome;
  }
}
