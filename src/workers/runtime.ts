import type { ChatMessage, ToolContext } from "../types";
import type { LlmClient } from "../llm/client";
import { ToolRegistry, builtinTools } from "../tools";
import { runToolLoop } from "../agent/loop";
import { needsCompaction, compact } from "../agent/compact";
import type { Settings } from "../config/settings";
import { modelProfile } from "../llm/profiles";
import { loadWorker, loadWorkerConfig, missingConfig, type WorkerDef } from "./registry";

/**
 * Headless worker execution: playbook + config as system prompt, the concrete
 * task as the user message, builtin tools only (bash/curl covers HTTP APIs),
 * everything auto-approved — scheduler runs have no human to ask. Used by the
 * scheduler and by the run_worker tool.
 */
export async function runWorker(opts: {
  worker: WorkerDef | string;
  task: string;
  client: LlmClient;
  settings: Settings;
  cwd: string;
  /** progress notes (tool events) — scheduler logs them, chat shows them */
  onNote?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const def = typeof opts.worker === "string" ? loadWorker(opts.worker) : opts.worker;
  if (!def) throw new Error(`no worker named "${opts.worker}"`);
  const missing = missingConfig(def);
  if (missing.length) {
    throw new Error(
      `worker "${def.name}" is missing config: ${missing.map((f) => f.key).join(", ")} — set it via worker_config or /workers config`,
    );
  }

  const config = loadWorkerConfig(def.name);
  const configBlock = def.fields
    .map((f) => `${f.key}: ${config[f.key] ?? ""}`)
    .join("\n");

  const registry = new ToolRegistry();
  for (const t of builtinTools()) registry.register(t);
  // ask_user is a builtin — unattended runs must decide for themselves
  const schemas = registry.schemas().filter((s) => s.name !== "ask_user");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are the "${def.name}" worker: ${def.description}\n\n` +
        `You run UNATTENDED (scheduled job) — nobody can answer questions. Decide yourself, ` +
        `finish the task, and make your final message a concise report of what you did ` +
        `(or a clear FAILED: reason). cwd: ${opts.cwd}\n\n` +
        `# CONFIG (credentials/identifiers for this worker — use them, never print secrets)\n${configBlock}\n\n` +
        `# PLAYBOOK\n${def.instructions}`,
    },
    { role: "user", content: opts.task },
  ];

  const ctx: ToolContext = {
    cwd: opts.cwd,
    askUser: async () => "(unattended worker run — decide yourself)",
    note: opts.onNote ?? (() => {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const s = opts.settings;
  const result = await runToolLoop({
    client: opts.client,
    registry,
    schemas,
    leakDialect: modelProfile(s.modelFamily).leakDialect,
    messages,
    ctx,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onTextDelta ? { onTextDelta: opts.onTextDelta } : {}),
    onToolEvent: (i) => {
      if (i.state === "done" || i.state === "error") opts.onNote?.(`⚙ ${i.detail}`);
    },
    maybeCompact: async (msgs) => {
      if (!needsCompaction(msgs, s.contextWindow, s.compactThreshold, s.maxTokens, opts.client)) return;
      const system = msgs[0];
      if (!system || msgs.length <= 2) return;
      try {
        const tail = await compact(opts.client, msgs.slice(1));
        msgs.splice(0, msgs.length, system, ...tail);
      } catch {
        // next request may still fit or error cleanly
      }
    },
  });
  return result || "(worker produced no report)";
}
