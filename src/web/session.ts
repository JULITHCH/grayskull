import { existsSync } from "node:fs";
import type { PermissionMode, TranscriptItem } from "../types";
import { MODE_ORDER } from "../types";
import { loadSettings, type Settings } from "../config/settings";
import { ensureDirs } from "../config/paths";
import { LlmClient } from "../llm/client";
import { ToolRegistry, builtinTools } from "../tools";
import { PermissionEngine } from "../perms/engine";
import { MemoryManager, loadGlobalMemory, loadLocalMemory } from "../memory/memory";
import { McpManager } from "../mcp/manager";
import { SessionStore } from "../session/store";
import { GrayskullAgent, type UiBridge } from "../agent/loop";
import { registerAgentTools } from "../agents/runner";
import { agentListing } from "../agents/registry";
import { skillTool } from "../skills/tool";
import { skillListing } from "../skills/registry";
import { makeTodoTool, type TodoItem } from "../tools/todo";
import { memoryGraphData } from "../memory/scores";
import { runChain, chainState } from "../chains/runner";
import type { ChainDef, ChainContextMode } from "../chains/registry";
import { runSlashCommand, type CommandContext } from "../slash";
import { modelProfile } from "../llm/profiles";

/** slash commands that open $EDITOR or fzf — they would hang the server */
const TERMINAL_ONLY = /^\/(system|settings|resume)\b|^\/(memory|agents|thinkingchain|tc)\s+edit\b/;

export type Broadcast = (msg: Record<string, unknown>) => void;

let sessionCounter = 0;

export class WebSession {
  readonly sid: string;
  readonly cwd: string;
  readonly settings: Settings;
  readonly agent: GrayskullAgent;
  readonly perms: PermissionEngine;
  readonly memory: MemoryManager;
  readonly mcp: McpManager;
  readonly client: LlmClient;
  busy = false;
  busyWhat = "";
  /** full transcript so newly connected browsers can replay it */
  readonly items: TranscriptItem[] = [];
  private store: SessionStore;
  private broadcast: Broadcast;
  private streamText = "";
  private pending = new Map<string, (answer: string) => void>();
  private pendingCounter = 0;
  private queue: Array<{ kind: "prompt"; text: string; images?: string[] } | { kind: "chain"; def: ChainDef; mode: ChainContextMode; task: string }> = [];
  private running = false;
  private todoState: { items: TodoItem[] };
  private sticky: { def: ChainDef; mode: ChainContextMode } | null = null;
  private bridge: UiBridge;

  constructor(cwd: string, broadcast: Broadcast) {
    this.sid = `s${++sessionCounter}`;
    this.cwd = cwd;
    this.broadcast = broadcast;
    ensureDirs(cwd);
    this.settings = loadSettings(cwd);
    this.client = new LlmClient(this.settings);
    const registry = new ToolRegistry();
    for (const t of builtinTools()) registry.register(t);
    // session-local todo so concurrent sessions don't share a task list
    const todo = makeTodoTool();
    this.todoState = todo.state;
    registry.register(todo.tool);
    registry.register(skillTool(cwd));
    registerAgentTools({
      cwd,
      client: this.client,
      registry,
      concurrency: this.settings.agentConcurrency,
      leakDialect: () => modelProfile(this.settings.modelFamily).leakDialect,
      monitor: (ev) => this.send({ t: "agent", ev }),
    });
    this.perms = new PermissionEngine(this.settings);
    this.memory = new MemoryManager(cwd, this.settings, this.client);
    this.mcp = new McpManager(registry, cwd);
    this.store = new SessionStore(cwd);

    const bridge: UiBridge = {
      pushItem: (item) => {
        this.items.push(item);
        if (this.items.length > 2000) this.items.shift();
        this.send({ t: "item", item });
      },
      assistantDelta: (delta) => {
        this.streamText += delta;
        this.send({ t: "delta", text: delta });
      },
      reasoningDelta: (delta) => this.send({ t: "reasoning", text: delta }),
      assistantDone: () => {
        const text = this.streamText;
        this.streamText = "";
        this.send({ t: "stream_end" });
        if (text.trim()) {
          const item: TranscriptItem = { type: "assistant", text };
          this.items.push(item);
          this.send({ t: "item", item });
        }
      },
      requestPermission: (req) =>
        new Promise((resolve) => {
          const reqId = `p${++this.pendingCounter}`;
          this.pending.set(reqId, (a) => resolve(a as "yes" | "always" | "no"));
          this.send({ t: "perm_req", reqId, detail: req.detail, preview: req.preview ?? null });
        }),
      askUser: (question, options) =>
        new Promise((resolve) => {
          const reqId = `a${++this.pendingCounter}`;
          this.pending.set(reqId, resolve);
          this.send({ t: "ask_req", reqId, question, options: options ?? null });
        }),
      setBusy: (busy, what) => {
        this.busy = busy;
        this.busyWhat = what ?? "";
        this.send({ t: "busy", busy, what: this.busyWhat });
        this.sendStatus();
      },
    };

    this.bridge = bridge;
    this.memory.onUpdate = () => this.sendMemory();
    this.memory.onNote = (text) => bridge.pushItem({ type: "note", text });
    this.mcp.onChange = () => this.sendStatus();

    this.agent = new GrayskullAgent({
      cwd,
      settings: this.settings,
      client: this.client,
      registry,
      perms: this.perms,
      memory: this.memory,
      ui: bridge,
    });
    this.agent.agentListing = () => agentListing(cwd);
    this.agent.skillListing = () => skillListing(cwd);

    void this.mcp.connectAll(this.settings);
  }

  private send(msg: Record<string, unknown>): void {
    this.broadcast({ sid: this.sid, ...msg });
  }

  sendStatus(): void {
    this.send({
      t: "status",
      mode: this.perms.mode,
      busy: this.busy,
      what: this.busyWhat,
      ctxPct: Math.min(100, Math.round((this.client.lastPromptTokens / this.settings.contextWindow) * 100)),
      mcp: [...this.mcp.statuses.values()].map((s) => ({ name: s.name, state: s.state, tools: s.toolCount })),
      model: this.settings.model,
      thinking: this.settings.enableThinking,
      legendary: this.agent.legendary,
      todo: this.todoState.items,
      // chainState is process-global; only claim it while this session works
      chain: this.busy ? chainState.running : null,
      sticky: this.sticky ? { name: this.sticky.def.name, mode: this.sticky.mode } : null,
    });
  }

  sendMemory(): void {
    const local = loadLocalMemory(this.cwd);
    const m = this.settings.memory;
    let graph = null;
    try {
      graph = memoryGraphData(this.cwd, local, {
        halfLifeDays: m.halfLifeDays,
        spreadFactor: m.spreadFactor,
        pruneThreshold: m.pruneThreshold,
        reviveThreshold: m.reviveThreshold,
      });
    } catch {
      // graph is decoration — never break the message
    }
    this.send({ t: "memory", global: loadGlobalMemory(), local, graph });
  }

  summary(): Record<string, unknown> {
    return { sid: this.sid, cwd: this.cwd, mode: this.perms.mode, busy: this.busy };
  }

  prompt(text: string, images: string[] = []): void {
    if (text.startsWith("/")) {
      void this.handleSlash(text);
      return;
    }
    if (this.sticky) {
      this.queue.push({ kind: "chain", def: this.sticky.def, mode: this.sticky.mode, task: text });
    } else {
      this.queue.push({ kind: "prompt", text, images });
    }
    void this.drain();
  }

  private async handleSlash(text: string): Promise<void> {
    const note = (t: string) => this.bridge.pushItem({ type: "note", text: t });
    if (TERMINAL_ONLY.test(text)) {
      note(`${text.split(" ")[0]} opens an editor/picker — run it in the terminal session`);
      return;
    }
    const ctx: CommandContext = {
      cwd: this.cwd,
      settings: this.settings,
      agent: this.agent,
      memory: this.memory,
      mcp: this.mcp,
      perms: this.perms,
      store: this.store,
      push: (item) => this.bridge.pushItem(item),
      setMode: (mode) => this.setMode(mode),
      clearTranscript: () => {
        this.items.length = 0;
        this.send({ t: "replay", items: [] });
      },
      exit: () => note("sessions are closed from the browser, not /exit"),
    };
    try {
      const result = await runSlashCommand(ctx, text);
      if (result === "unknown") {
        note(`unknown command ${text.split(" ")[0]} — try /help`);
      } else if (result && "prompt" in result) {
        this.queue.push({ kind: "prompt", text: result.prompt });
        void this.drain();
      } else if (result && "chain" in result) {
        const { def, mode, task } = result.chain;
        if (task) {
          this.queue.push({ kind: "chain", def, mode, task });
          void this.drain();
        } else {
          this.sticky = { def, mode };
          note(`⛓ chain "${def.name}" (${mode}) active for this session — /tc off to stop`);
          this.sendStatus();
        }
      }
    } catch (err) {
      note(`command failed: ${(err as Error).message}`);
    }
    // /tc off clears the global sticky; mirror it per-session
    if (/^\/(tc|thinkingchain)\s+off\b/.test(text)) {
      this.sticky = null;
    }
    // reflect any setting a command may have changed (e.g. /thinking)
    this.sendStatus();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: (typeof this.queue)[number] | undefined;
      while ((next = this.queue.shift()) !== undefined) {
        const imgCount = next.kind === "prompt" ? (next.images?.length ?? 0) : 0;
        const label =
          next.kind === "prompt"
            ? `${next.text}${imgCount ? `  [📎 ${imgCount} image${imgCount > 1 ? "s" : ""}]` : ""}`
            : `⛓ [${next.def.name}] ${next.task}`;
        const item: TranscriptItem =
          next.kind === "prompt" && next.images?.length
            ? { type: "user", text: label, images: next.images }
            : { type: "user", text: label };
        this.items.push(item);
        this.send({ t: "item", item });
        if (next.kind === "prompt") {
          await this.agent.runTurn(next.text, next.images ?? []);
        } else {
          await runChain({
            chain: next.def,
            task: next.task,
            mode: next.mode,
            agent: this.agent,
            ui: this.bridge,
            memory: this.memory,
          });
        }
        this.store.save(this.agent.history);
        this.sendMemory();
        this.sendStatus();
      }
    } finally {
      this.running = false;
    }
  }

  answer(reqId: string, value: string): void {
    const resolve = this.pending.get(reqId);
    if (resolve) {
      this.pending.delete(reqId);
      resolve(value);
    }
  }

  setMode(mode: string): void {
    if ((MODE_ORDER as string[]).includes(mode)) {
      this.perms.mode = mode as PermissionMode;
      this.sendStatus();
      if (mode === "kamikazeee") {
        const item: TranscriptItem = { type: "banner", text: "KAMIKAZEEE ENGAGED — everything auto-approved", color: "red" };
        this.items.push(item);
        this.send({ t: "item", item });
      }
    }
  }

  interrupt(): void {
    this.agent.stop();
  }
}

export class SessionManager {
  readonly sessions = new Map<string, WebSession>();
  private broadcast: Broadcast;

  constructor(broadcast: Broadcast) {
    this.broadcast = broadcast;
  }

  create(cwd: string): WebSession | { error: string } {
    if (!existsSync(cwd)) return { error: `directory not found: ${cwd}` };
    try {
      const session = new WebSession(cwd, this.broadcast);
      this.sessions.set(session.sid, session);
      this.broadcastList();
      session.sendStatus();
      session.sendMemory();
      return session;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  broadcastList(): void {
    this.broadcast({ t: "sessions", list: [...this.sessions.values()].map((s) => s.summary()) });
  }
}
