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
  private queue: string[] = [];
  private running = false;

  constructor(cwd: string, broadcast: Broadcast) {
    this.sid = `s${++sessionCounter}`;
    this.cwd = cwd;
    this.broadcast = broadcast;
    ensureDirs(cwd);
    this.settings = loadSettings(cwd);
    this.client = new LlmClient(this.settings);
    const registry = new ToolRegistry();
    for (const t of builtinTools()) registry.register(t);
    registry.register(skillTool(cwd));
    registerAgentTools({
      cwd,
      client: this.client,
      registry,
      concurrency: this.settings.agentConcurrency,
      monitor: (ev) => this.send({ t: "agent", ev }),
    });
    this.perms = new PermissionEngine(this.settings);
    this.memory = new MemoryManager(cwd, this.settings, this.client);
    this.mcp = new McpManager(registry);
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
    });
  }

  sendMemory(): void {
    this.send({
      t: "memory",
      global: loadGlobalMemory(),
      local: loadLocalMemory(this.cwd),
    });
  }

  summary(): Record<string, unknown> {
    return { sid: this.sid, cwd: this.cwd, mode: this.perms.mode, busy: this.busy };
  }

  prompt(text: string): void {
    this.queue.push(text);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: string | undefined;
      while ((next = this.queue.shift()) !== undefined) {
        const item: TranscriptItem = { type: "user", text: next };
        this.items.push(item);
        this.send({ t: "item", item });
        await this.agent.runTurn(next);
        this.store.save(this.agent.history);
        this.sendMemory();
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
