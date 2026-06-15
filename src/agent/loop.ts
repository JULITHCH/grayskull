import type { ChatMessage, ToolContext, TranscriptItem } from "../types";
import type { Settings } from "../config/settings";
import { loadSystemPrompt } from "../config/settings";
import type { LlmClient, ToolSchema } from "../llm/client";
import type { ToolRegistry } from "../tools";
import type { PermissionEngine } from "../perms/engine";
import type { MemoryManager } from "../memory/memory";
import { detectGlobalTrigger } from "../memory/memory";
import { validateCall, recoverTextToolCall } from "./repair";
import { needsCompaction, compact } from "./compact";
import { runDiagnostics } from "./diagnostics";
import { autoMatchSkills, autoSkillBlock, type SkillDef } from "../skills/registry";
import { modelProfile, type InferenceProfile, type LeakDialect } from "../llm/profiles";
import type { ModelPreset } from "../config/settings";
import { resolveStepProfile } from "../chains/registry";
import type { ChainDef } from "../chains/registry";
import { spawnSync } from "node:child_process";

const MAX_LOOP_TURNS = 40;
const MAX_REPAIR_ATTEMPTS = 3;

export interface PermissionRequest {
  toolName: string;
  detail: string;
  preview?: string;
}

export interface UiBridge {
  pushItem: (item: TranscriptItem) => void;
  /** stream delta into the current assistant message */
  assistantDelta: (delta: string) => void;
  /** stream delta of the model's reasoning (rendered dimmed, not kept) */
  reasoningDelta: (delta: string) => void;
  assistantDone: () => void;
  requestPermission: (req: PermissionRequest) => Promise<"yes" | "always" | "no">;
  askUser: (question: string, options?: string[]) => Promise<string>;
  setBusy: (busy: boolean, what?: string) => void;
}

/** Shared tool-execution loop used by the main agent and by sub-agents. */
export async function runToolLoop(opts: {
  client: LlmClient;
  registry: ToolRegistry;
  schemas: ToolSchema[];
  messages: ChatMessage[];
  ctx: ToolContext;
  signal?: AbortSignal;
  onTextDelta?: (d: string) => void;
  onReasoningDelta?: (d: string) => void;
  onAssistantDone?: (text: string) => void;
  onToolEvent?: (item: TranscriptItem & { type: "tool" }) => void;
  /** null = auto-approve everything (sub-agents gate at spawn time) */
  decide?: (toolName: string, args: Record<string, unknown>) => Promise<{ allowed: boolean; reason?: string }>;
  /** which plaintext tool-call leak format to recover (model-family specific) */
  leakDialect?: LeakDialect;
}): Promise<string> {
  const { client, registry, schemas, messages, ctx, signal } = opts;
  const knownTools = new Set(schemas.map((s) => s.name));
  const repairCounts = new Map<string, number>();
  let lastText = "";

  for (let turn = 0; turn < MAX_LOOP_TURNS; turn++) {
    if (signal?.aborted) break;
    const result = await client.complete(
      messages,
      schemas,
      { onTextDelta: opts.onTextDelta, onReasoningDelta: opts.onReasoningDelta },
      signal,
    );
    let { toolCalls } = result;
    lastText = result.text;
    opts.onAssistantDone?.(result.text);

    // weak-model recovery: tool call emitted as text instead of tool_calls
    if (toolCalls.length === 0 && result.text) {
      const recovered = recoverTextToolCall(result.text, knownTools, opts.leakDialect);
      if (recovered) toolCalls = [recovered];
    }

    messages.push({
      role: "assistant",
      content: result.text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      if (signal?.aborted) break;
      const reply = (content: string) =>
        messages.push({ role: "tool", tool_call_id: call.id, content });

      const tool = registry.get(call.function.name);
      if (!tool || !knownTools.has(call.function.name)) {
        reply(`Unknown tool "${call.function.name}". Available tools: ${[...knownTools].join(", ")}.`);
        continue;
      }

      const validated = validateCall(tool, call.function.arguments);
      if (!validated.ok) {
        const count = (repairCounts.get(tool.name) ?? 0) + 1;
        repairCounts.set(tool.name, count);
        if (count > MAX_REPAIR_ATTEMPTS) {
          reply(`Repeated invalid calls to ${tool.name}. Stop calling it and tell the user what you were trying to do.`);
        } else {
          reply(validated.error);
        }
        continue;
      }
      repairCounts.delete(tool.name);
      const args = validated.args;

      const item: TranscriptItem & { type: "tool" } = {
        type: "tool",
        name: tool.name,
        detail: tool.describeCall(args),
        state: "running",
      };
      // edits/writes carry their diff into the transcript (Claude Code style)
      if (tool.previewCall) {
        item.preview = await tool.previewCall(args, ctx.cwd).catch(() => undefined);
      }

      if (opts.decide) {
        const verdict = await opts.decide(tool.name, args);
        if (!verdict.allowed) {
          item.state = "denied";
          opts.onToolEvent?.(item);
          reply(`Permission denied: ${verdict.reason ?? "user declined"}. Do not retry the same call; adjust your approach or ask the user.`);
          continue;
        }
      }

      opts.onToolEvent?.({ ...item });
      try {
        let result = await tool.execute(args, ctx);
        // compiler feedback loop: file changes trigger the project check,
        // failures land in the same tool result (applies to sub-agents too)
        if (tool.kind === "edit" && !result.startsWith("error:")) {
          const diag = runDiagnostics(ctx.cwd);
          if (diag) result += `\n\n${diag}`;
        }
        item.state = "done";
        item.result = result;
        opts.onToolEvent?.({ ...item });
        reply(result);
      } catch (err) {
        item.state = "error";
        item.result = (err as Error).message;
        opts.onToolEvent?.({ ...item });
        reply(`Tool error: ${(err as Error).message}`);
      }
    }
  }
  return lastText;
}

export class GrayskullAgent {
  history: ChatMessage[] = [];
  private settings: Settings;
  private client: LlmClient;
  private registry: ToolRegistry;
  private perms: PermissionEngine;
  private memory: MemoryManager;
  private ui: UiBridge;
  private cwd: string;
  private abort: AbortController | null = null;
  /** True if the most recent runTurn/runIsolated was interrupted (esc). */
  lastInterrupted = false;
  /** Set by the sub-agent module so spawn_agent can run nested loops. */
  agentListing: () => string = () => "";
  /** Set at startup; lists SKILL.md skills for the system prompt. */
  skillListing: () => string = () => "";

  /** Tool-call leak dialect for this model family. */
  get leakDialect(): LeakDialect {
    return modelProfile(this.settings.modelFamily).leakDialect;
  }

  /** Resolve a chain step's inference profile (thinking + sampling) for this
   *  model family, honouring per-chain overrides. */
  resolveChainStepProfile(step: string, chain: ChainDef): InferenceProfile {
    return resolveStepProfile(step, chain, this.settings.modelFamily);
  }

  /** Apply (or clear with null) a step's profile on the shared client. */
  setInferenceProfile(profile: InferenceProfile | null): void {
    this.client.setInferenceProfile(profile);
  }

  /** Live model switch (/model): copy a named preset into the shared settings
   *  and rebuild the client connection. modelFamily drives leak dialect + chain
   *  presets live; sampling/model/contextWindow are read fresh per request. */
  applyModelSwitch(preset: ModelPreset): void {
    const s = this.settings;
    s.modelFamily = preset.family;
    s.baseURL = preset.baseURL;
    s.model = preset.model;
    if (preset.apiKeyEnv !== undefined) s.apiKeyEnv = preset.apiKeyEnv;
    if (preset.contextWindow !== undefined) s.contextWindow = preset.contextWindow;
    if (preset.temperature !== undefined) s.temperature = preset.temperature;
    if (preset.topP !== undefined) s.topP = preset.topP;
    if (preset.topK !== undefined) s.topK = preset.topK;
    if (preset.minP !== undefined) s.minP = preset.minP;
    if (preset.enableThinking !== undefined) s.enableThinking = preset.enableThinking;
    this.client.reconfigure();
  }

  get modelName(): string {
    return this.settings.model;
  }

  constructor(opts: {
    cwd: string;
    settings: Settings;
    client: LlmClient;
    registry: ToolRegistry;
    perms: PermissionEngine;
    memory: MemoryManager;
    ui: UiBridge;
  }) {
    this.cwd = opts.cwd;
    this.settings = opts.settings;
    this.client = opts.client;
    this.registry = opts.registry;
    this.perms = opts.perms;
    this.memory = opts.memory;
    this.ui = opts.ui;
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Harness-side skill utilization: match the task text, inject winners,
   *  tell the user. The model cannot skip what is already in its context. */
  private autoSkills(taskText: string): SkillDef[] {
    try {
      const matched = autoMatchSkills(taskText, this.cwd);
      for (const s of matched) {
        this.ui.pushItem({ type: "note", text: `⚡ skill auto-loaded: ${s.name}` });
      }
      return matched;
    } catch {
      return [];
    }
  }

  private buildSystemMessage(autoSkills: SkillDef[] = []): ChatMessage {
    const base = loadSystemPrompt(this.cwd, this.settings);
    const git = spawnSync("git", ["status", "--porcelain", "-b"], {
      cwd: this.cwd,
      encoding: "utf8",
    });
    const gitInfo = git.status === 0 ? git.stdout.split("\n").slice(0, 15).join("\n") : "(not a git repo)";
    const env = [
      `cwd: ${this.cwd}`,
      `date: ${new Date().toISOString().slice(0, 10)}`,
      `platform: ${process.platform}`,
      `git:\n${gitInfo}`,
    ].join("\n");
    const memory = this.memory.render();
    const agents = this.agentListing();
    const skills = this.skillListing();
    return {
      role: "system",
      content: [
        base,
        `# Environment\n${env}`,
        memory,
        agents ? `# Available sub-agents\n${agents}` : "",
        skills
          ? `# Available skills\nIf the request involves a topic listed below, you MUST call the skill tool with that skill's name BEFORE writing any code or answer — treat your own memory of these libraries as outdated. Then follow the returned instructions.\n${skills}`
          : "",
        autoSkillBlock(autoSkills),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  async manualCompact(): Promise<void> {
    this.history = await compact(this.client, this.history);
  }

  async runTurn(userText: string): Promise<string> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.ui.setBusy(true, "thinking");

    // explicit-trigger path → global vault
    if (detectGlobalTrigger(userText, this.settings.memory.globalTriggers)) {
      this.ui.setBusy(true, "updating global memory");
      try {
        await this.memory.rememberGlobal(userText);
        this.ui.pushItem({ type: "note", text: "⚡ saved to global memory (GRAYSKULL.md)" });
      } catch (err) {
        this.ui.pushItem({ type: "note", text: `global memory update failed: ${(err as Error).message}` });
      }
    }

    if (
      needsCompaction(this.history, this.settings.contextWindow, this.settings.compactThreshold, this.settings.maxTokens)
    ) {
      this.ui.setBusy(true, "compacting context");
      try {
        this.history = await compact(this.client, this.history);
        this.ui.pushItem({ type: "note", text: "context compacted" });
      } catch {
        this.ui.pushItem({ type: "note", text: "compaction failed — continuing with full history" });
      }
    }

    this.history.push({ role: "user", content: userText });
    const turnLog: string[] = [`user: ${userText.slice(0, 2000)}`];
    const messages: ChatMessage[] = [this.buildSystemMessage(this.autoSkills(userText)), ...this.history];
    let finalText = "";

    try {
      finalText = await this.runWiredLoop(messages, signal, turnLog);
    } catch (err) {
      if (!signal.aborted) {
        this.ui.pushItem({ type: "note", text: `error: ${(err as Error).message}` });
      }
    } finally {
      // persist everything the loop appended (minus the system message)
      this.history = messages.slice(1);
      this.lastInterrupted = signal.aborted;
      if (signal.aborted) {
        this.ui.pushItem({ type: "note", text: "interrupted" });
      }
      this.ui.setBusy(false);
      this.abort = null;
    }

    // fire-and-forget local memory extraction
    void this.memory.extractFromTurn(turnLog.join("\n\n"));
    return finalText;
  }

  /**
   * Run a directive in a FRESH context: same tools/permissions/streaming, but
   * this.history stays untouched and no memory extraction fires. Used by
   * thinking chains in "fresh" mode; the chain runner records one summary
   * turn at the end instead.
   */
  async runIsolated(directive: string): Promise<string> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.ui.setBusy(true, "chain step");
    const messages: ChatMessage[] = [
      this.buildSystemMessage(this.autoSkills(directive)),
      { role: "user", content: directive },
    ];
    try {
      return await this.runWiredLoop(messages, signal, []);
    } catch (err) {
      if (!signal.aborted) {
        this.ui.pushItem({ type: "note", text: `error: ${(err as Error).message}` });
      }
      return "";
    } finally {
      this.lastInterrupted = signal.aborted;
      if (signal.aborted) this.ui.pushItem({ type: "note", text: "interrupted" });
      this.ui.setBusy(false);
      this.abort = null;
    }
  }

  /** The UI/permission wiring shared by runTurn and runIsolated. */
  private runWiredLoop(
    messages: ChatMessage[],
    signal: AbortSignal,
    turnLog: string[],
  ): Promise<string> {
    const ctx: ToolContext = {
      cwd: this.cwd,
      signal,
      askUser: async (question, options) => {
        const answer = await this.ui.askUser(question, options);
        turnLog.push(`agent asked: ${question}\nuser answered: ${answer}`);
        return answer;
      },
      note: (text) => this.ui.pushItem({ type: "note", text }),
    };
    return runToolLoop({
      client: this.client,
      registry: this.registry,
      schemas: this.registry.schemas(),
      leakDialect: this.leakDialect,
      messages,
      ctx,
      signal,
      onTextDelta: (d) => this.ui.assistantDelta(d),
      onReasoningDelta: (d) => this.ui.reasoningDelta(d),
      onAssistantDone: (text) => {
        this.ui.assistantDone();
        if (text) turnLog.push(`assistant: ${text.slice(0, 4000)}`);
      },
      onToolEvent: (item) => {
        this.ui.pushItem(item);
        if (item.state === "done") {
          const isWeb = item.name.startsWith("mcp__searxng__");
          const resultSnippet = isWeb ? `\nresult: ${(item.result ?? "").slice(0, 3000)}` : "";
          turnLog.push(`tool ${item.detail}${resultSnippet}`);
        }
      },
      decide: async (toolName, args) => {
        const tool = this.registry.get(toolName)!;
        const decision = this.perms.decide(tool, args);
        if (decision.kind === "allow") return { allowed: true };
        if (decision.kind === "deny") return { allowed: false, reason: decision.reason };
        const preview = await tool.previewCall?.(args, this.cwd).catch(() => undefined);
        const answer = await this.ui.requestPermission({
          toolName,
          detail: tool.describeCall(args),
          preview,
        });
        if (answer === "always") {
          this.perms.allowForSession(tool.describeCall(args).replace(/\(.*\)$/, "(*)"));
          return { allowed: true };
        }
        return { allowed: answer === "yes" };
      },
    });
  }
}
