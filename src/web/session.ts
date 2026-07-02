import { existsSync, mkdirSync } from "node:fs";
import type { ChatMessage, PermissionMode, TranscriptItem } from "../types";
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
import { loadChains, saveChain, BUILTIN_STEPS } from "../chains/registry";
import { loadSkills } from "../skills/registry";
import type { ChainDef, ChainContextMode, StepConfig } from "../chains/registry";
import { runSlashCommand, type CommandContext } from "../slash";
import { modelProfile } from "../llm/profiles";

/** slash commands that open $EDITOR or fzf — they would hang the server.
 *  `/tc edit` opens the clickable chain editor instead; /resume is tty-free
 *  (numbered list) and works here. */
const TERMINAL_ONLY = /^\/(system|settings)\b|^\/(memory|agents)\s+edit\b/;

/** `/tc edit [name]` / `/thinkingchain edit [name]` → browser chain editor */
const CHAIN_EDIT_RE = /^\/(?:tc|thinkingchain)\s+edit\b\s*(.*)$/;

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
  /** unanswered perm/ask prompts: payload kept so reconnecting browsers get
   *  them replayed — otherwise a reload while a prompt is up hangs the turn
   *  forever (the promise only resolves via an answer with this reqId) */
  private pending = new Map<string, { msg: Record<string, unknown>; resolve: (answer: string) => void }>();
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
    const skillGate = { forbidden: new Set<string>() };
    registry.register(skillTool(cwd, skillGate));
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
          const msg = { t: "perm_req", reqId, detail: req.detail, preview: req.preview ?? null };
          this.pending.set(reqId, { msg, resolve: (a) => resolve(a as "yes" | "always" | "no") });
          this.send(msg);
        }),
      askUser: (question, options) =>
        new Promise((resolve) => {
          const reqId = `a${++this.pendingCounter}`;
          const msg = { t: "ask_req", reqId, question, options: options ?? null };
          this.pending.set(reqId, { msg, resolve });
          this.send(msg);
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
    this.agent.skillListing = (exclude) => skillListing(cwd, exclude);
    this.agent.skillGate = skillGate;

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
      tps: Math.round(this.client.lastTokensPerSec),
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
    const chainEdit = text.match(CHAIN_EDIT_RE);
    if (chainEdit) {
      this.openChainEditor(chainEdit[1]!.trim());
      return;
    }
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
    // /resume N replaced agent.history — rebuild the browser transcript from
    // it so the resumed conversation is visible, not just a "resumed" note
    if (/^\/resume\s+\d+/.test(text) && this.agent.history.length) {
      this.items.length = 0;
      this.items.push(...historyToItems(this.agent.history));
      this.items.push({ type: "note", text: `resumed — ${this.agent.history.length} messages restored` });
      this.send({ t: "replay", items: this.items.slice(-300) });
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
    const entry = this.pending.get(reqId);
    if (entry) {
      this.pending.delete(reqId);
      entry.resolve(value);
    }
  }

  /** Re-send unanswered perm/ask prompts (a newly connected browser would
   *  otherwise never see them and the awaiting turn would hang forever). */
  replayPending(): void {
    for (const { msg } of this.pending.values()) this.send(msg);
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

  /** Tear the session down: abort any run, release pending prompts, and close
   *  MCP servers (their child processes — playwright chrome etc. — otherwise
   *  live until the grayskull-web process dies). */
  close(): void {
    this.agent.stop();
    for (const [reqId, entry] of this.pending) {
      this.pending.delete(reqId);
      entry.resolve("no");
    }
    void this.mcp.closeAll().catch(() => {});
  }

  /** Open the browser chain editor for `name` (blank → create a new chain). */
  private openChainEditor(name: string): void {
    const note = (t: string) => this.bridge.pushItem({ type: "note", text: t });
    let def: Pick<ChainDef, "name" | "description" | "context" | "steps" | "stepConfigs">;
    if (name) {
      const found = loadChains().find((c) => c.name === name);
      if (!found) {
        note(`no chain named "${name}" — /tc lists chains`);
        return;
      }
      def = {
        name: found.name,
        description: found.description,
        context: found.context,
        steps: found.steps,
        stepConfigs: found.stepConfigs ?? {},
      };
    } else {
      def = { name: "", description: "", context: "shared", steps: [], stepConfigs: {} };
    }
    this.send({
      t: "chain_edit",
      def,
      models: Object.keys(this.settings.models),
      builtins: Object.keys(BUILTIN_STEPS),
      skills: loadSkills(this.cwd).map((s) => s.name),
      mcpTools: this.agent.mcpToolNames(),
    });
  }

  /** Persist a chain edited in the browser editor. */
  chainSave(raw: Record<string, unknown>): void {
    const note = (t: string) => this.bridge.pushItem({ type: "note", text: t });
    try {
      const name = String(raw["name"] ?? "").trim();
      const steps = (Array.isArray(raw["steps"]) ? raw["steps"] : [])
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (!name) return this.send({ t: "chain_error", message: "chain needs a name" });
      if (!steps.length) return this.send({ t: "chain_error", message: "chain needs at least one step" });
      const ctxMode: ChainContextMode = raw["context"] === "fresh" ? "fresh" : "shared";
      const stepConfigs = sanitizeStepConfigs(raw["stepConfigs"]);
      const path = saveChain({
        name,
        description: String(raw["description"] ?? ""),
        context: ctxMode,
        steps,
        stepConfigs:
          stepConfigs && Object.keys(stepConfigs).length ? stepConfigs : undefined,
      });
      this.send({ t: "chain_saved", name });
      note(`⛓ saved chain "${name}" → ${path}`);
    } catch (err) {
      this.send({ t: "chain_error", message: (err as Error).message });
    }
  }
}

/** Rebuild transcript items from a resumed ChatMessage history so the browser
 *  can render the old conversation. Tool calls become done tool items with
 *  their results attached; system messages are skipped. */
function historyToItems(history: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // tool results arrive as separate messages keyed by call id
  const results = new Map<string, string>();
  for (const m of history) {
    if (m.role === "tool" && typeof m.content === "string") results.set(m.tool_call_id, m.content);
  }
  const text = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("");
    }
    return "";
  };
  for (const m of history) {
    if (m.role === "user") {
      const t = text(m.content);
      if (t) items.push({ type: "user", text: t });
    } else if (m.role === "assistant") {
      const t = text(m.content);
      if (t) items.push({ type: "assistant", text: t });
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== "function") continue;
        items.push({
          type: "tool",
          name: tc.function.name,
          detail: `${tc.function.name}(${tc.function.arguments.slice(0, 120)})`,
          result: results.get(tc.id)?.slice(0, 2000),
          state: "done",
        });
      }
    }
  }
  return items;
}

/** Browser payloads are untrusted — keep only correctly-typed StepConfig
 *  fields so junk never reaches the chain file. */
function sanitizeStepConfigs(raw: unknown): Record<string, StepConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : undefined;
  const out: Record<string, StepConfig> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim() || !v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const cfg: StepConfig = {};
    if (typeof c["model"] === "string" && c["model"]) cfg.model = c["model"];
    if (typeof c["enableThinking"] === "boolean") cfg.enableThinking = c["enableThinking"];
    if (typeof c["temperature"] === "number" && Number.isFinite(c["temperature"])) cfg.temperature = c["temperature"];
    if (typeof c["gate"] === "boolean") cfg.gate = c["gate"];
    const req = strArr(c["requiredSkills"]);
    if (req) cfg.requiredSkills = req;
    const forbid = strArr(c["forbiddenSkills"]);
    if (forbid) cfg.forbiddenSkills = forbid;
    if (typeof c["mcpEnabled"] === "boolean") cfg.mcpEnabled = c["mcpEnabled"];
    const mcpTools = strArr(c["mcpTools"]);
    if (mcpTools) cfg.mcpTools = mcpTools;
    if (typeof c["subagentsEnabled"] === "boolean") cfg.subagentsEnabled = c["subagentsEnabled"];
    if (Object.keys(cfg).length) out[name.trim().toLowerCase()] = cfg;
  }
  return Object.keys(out).length ? out : undefined;
}

export class SessionManager {
  readonly sessions = new Map<string, WebSession>();
  private broadcast: Broadcast;

  constructor(broadcast: Broadcast) {
    this.broadcast = broadcast;
  }

  create(cwd: string, createDir = false): WebSession | { error: string } | { needsCreate: string } {
    if (!existsSync(cwd)) {
      if (!createDir) return { needsCreate: cwd };
      try {
        mkdirSync(cwd, { recursive: true });
      } catch (err) {
        return { error: `could not create ${cwd}: ${(err as Error).message}` };
      }
    }
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

  close(sid: string): void {
    const session = this.sessions.get(sid);
    if (!session) return;
    this.sessions.delete(sid);
    session.close();
    this.broadcastList();
  }
}
