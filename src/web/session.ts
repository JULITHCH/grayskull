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
import { agentListing, loadAgents, writeAgentDef, deleteAgentDef, toggleAgentDisabled } from "../agents/registry";
import { skillTool } from "../skills/tool";
import { skillListing } from "../skills/registry";
import { makeTodoTool, type TodoItem } from "../tools/todo";
import { memoryGraphData } from "../memory/scores";
import { runChain, chainState } from "../chains/runner";
import { loadChains, saveChain, BUILTIN_STEPS } from "../chains/registry";
import { loadSkills } from "../skills/registry";
import {
  loadHub,
  rankSkills,
  fetchSkillDetail,
  installSkill,
  type RemoteSkill,
} from "../skills/hub";
import type { ChainDef, ChainContextMode, StepConfig } from "../chains/registry";
import { runSlashCommand, type CommandContext } from "../slash";
import { listGroups, applyField, saveGlobal, checkServices, recheckServices, addPreset, removePreset, addFamily } from "../setup/core";
import { modelProfile } from "../llm/profiles";
import { searchModelsDev, presetFromEntry } from "../llm/modelsdev";
import {
  saveSession, loadSession, loadSessionMetas, deleteSession, ensureWebDirs,
  CHATS_CWD, type SavedSession, type SavedSessionMeta, type SessionKind,
} from "./persist";
import { registerWorkerTools, workerPromptSection } from "../workers/tools";

/** slash commands that open $EDITOR or fzf — they would hang the server.
 *  `/tc edit` opens the clickable chain editor instead; /resume is tty-free
 *  (numbered list) and works here. */
const TERMINAL_ONLY = /^\/(system|settings)\b|^\/(memory|agents|workers)\s+edit\b|^\/agents\s+new\b/;

/** `/tc edit [name]` / `/thinkingchain edit [name]` → browser chain editor */
const CHAIN_EDIT_RE = /^\/(?:tc|thinkingchain)\s+edit\b\s*(.*)$/;

export type Broadcast = (msg: Record<string, unknown>) => void;

/** Collision-safe across server restarts (persisted sids must stay unique). */
function newSid(): string {
  return `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export class WebSession {
  readonly sid: string;
  readonly cwd: string;
  readonly kind: SessionKind;
  /** chats: first prompt excerpt shown in the sidebar; projects: "" */
  title = "";
  private readonly createdAt: number;
  readonly settings: Settings;
  readonly agent: GrayskullAgent;
  readonly perms: PermissionEngine;
  readonly memory: MemoryManager;
  readonly mcp: McpManager;
  readonly client: LlmClient;
  busy = false;
  busyWhat = "";
  /** wall-clock start of the current busy stretch (elapsed timer). */
  private busyStartAt = 0;
  /** session tokens at busy start — turn counter shows tokens since. */
  private busyTokSnap = 0;
  /** 1s ticker streaming elapsed/token updates to browsers while busy. */
  private tokTicker: ReturnType<typeof setInterval> | null = null;
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
  /** files the agent explicitly offered for download this run, keyed by an
   *  opaque token so absolute paths never leave the server; served by /dl */
  private downloads = new Map<string, { path: string; name: string }>();
  private downloadCounter = 0;

  constructor(cwd: string, broadcast: Broadcast, opts: { kind?: SessionKind; restore?: SavedSession } = {}) {
    const r = opts.restore;
    this.sid = r?.sid ?? newSid();
    this.cwd = cwd;
    this.kind = r?.kind ?? opts.kind ?? "project";
    this.title = r?.title ?? "";
    this.createdAt = r?.createdAt ?? Date.now();
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
    registerWorkerTools({ registry, client: this.client, settings: this.settings, cwd });
    registerAgentTools({
      cwd,
      client: this.client,
      registry,
      concurrency: this.settings.agentConcurrency,
      settings: this.settings,
      leakDialect: () => modelProfile(this.settings.modelFamily).leakDialect,
      monitor: (ev) => this.send({ t: "agent", ev }),
    });
    this.perms = new PermissionEngine(this.settings);
    this.memory = new MemoryManager(cwd, this.settings, this.client);
    this.mcp = new McpManager(registry, cwd);
    this.store = new SessionStore(cwd);

    const bridge: UiBridge = {
      pushItem: (item) => {
        // explicit download offer: swap the server-local path for an opaque
        // token + /dl url before the item is stored or sent to any browser
        if (item.type === "tool" && item.download?.path) {
          const id = `d${++this.downloadCounter}`;
          this.downloads.set(id, { path: item.download.path, name: item.download.name });
          item.download = { name: item.download.name, size: item.download.size, url: `/dl?sid=${this.sid}&id=${id}` };
        }
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
        if (busy && !this.busy) {
          this.busyStartAt = Date.now();
          this.busyTokSnap = this.client.sessionTokens();
          this.tokTicker ??= setInterval(() => this.sendTok(), 1000);
        }
        if (!busy && this.tokTicker) {
          clearInterval(this.tokTicker);
          this.tokTicker = null;
        }
        this.busy = busy;
        this.busyWhat = what ?? "";
        this.send({ t: "busy", busy, what: this.busyWhat, busyMs: busy ? Date.now() - this.busyStartAt : 0 });
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
    this.agent.agentListing = () => agentListing(cwd, this.settings.disabledAgents);
    this.agent.workerListing = () => workerPromptSection();
    this.agent.skillListing = (exclude) => skillListing(cwd, exclude);
    this.agent.skillGate = skillGate;

    // picked back up from disk: conversation + transcript + mode carry over
    if (r) {
      this.agent.history = r.history ?? [];
      this.items.push(...(r.items ?? []));
      if ((MODE_ORDER as string[]).includes(r.mode)) this.perms.mode = r.mode as PermissionMode;
    }
    this.persist();

    void this.mcp.connectAll(this.settings);
  }

  /** Snapshot to disk — sidebar entries survive restarts and can be resumed. */
  persist(): void {
    saveSession({
      sid: this.sid,
      kind: this.kind,
      cwd: this.cwd,
      title: this.title,
      mode: this.perms.mode,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      items: this.items,
      history: this.agent.history,
    });
  }

  private send(msg: Record<string, unknown>): void {
    this.broadcast({ sid: this.sid, ...msg });
  }

  /** Live elapsed/token tick, streamed once a second while the turn runs so
   *  browsers can show progress (or the lack of it — hang detection). */
  private sendTok(): void {
    this.send({
      t: "tok",
      tokens: this.client.sessionTokens(),
      turnTokens: this.client.sessionTokens() - this.busyTokSnap,
      tps: Math.round(this.client.lastTokensPerSec),
      busyMs: this.busy ? Date.now() - this.busyStartAt : 0,
    });
  }

  sendStatus(): void {
    this.send({
      t: "status",
      mode: this.perms.mode,
      busy: this.busy,
      what: this.busyWhat,
      busyMs: this.busy ? Date.now() - this.busyStartAt : 0,
      tokens: this.client.sessionTokens(),
      turnTokens: this.busy ? this.client.sessionTokens() - this.busyTokSnap : 0,
      ctxPct: Math.min(100, Math.round((this.client.lastPromptTokens / this.settings.contextWindow) * 100)),
      tps: Math.round(this.client.lastTokensPerSec),
      mcp: [...this.mcp.statuses.values()].map((s) => ({ name: s.name, state: s.state, tools: s.toolCount })),
      model: this.settings.model,
      temp: this.settings.temperature,
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
    return { sid: this.sid, cwd: this.cwd, mode: this.perms.mode, busy: this.busy, kind: this.kind, title: this.title };
  }

  /** Look up a download token → server-local file (for the /dl route). Only
   *  files the agent explicitly offered this run are resolvable. */
  resolveDownload(id: string): { path: string; name: string } | undefined {
    return this.downloads.get(id);
  }

  prompt(text: string, images: string[] = []): void {
    // chats are titled by their first prompt, like every chat app
    if (this.kind === "chat" && !this.title && !text.startsWith("/")) {
      this.title = text.replace(/\s+/g, " ").trim().slice(0, 48);
      this.send({ t: "sess_title", title: this.title });
    }
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
      openSetup: () => void this.setupOpen(),
      openSkillsBrowser: (query?: string) => void this.skillsOpen(query ?? ""),
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
        this.persist();
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

  /** Live sampling-temperature override from the browser slider; applies to
   *  the next model request (LlmClient reads settings per call). */
  setTemperature(value: number): void {
    if (!Number.isFinite(value)) return;
    const v = Math.round(Math.max(0, Math.min(2, value)) * 100) / 100;
    if (v === this.settings.temperature) return;
    this.settings.temperature = v;
    const item: TranscriptItem = { type: "note", text: `🌡 temperature → ${v}` };
    this.items.push(item);
    this.send({ t: "item", item });
    this.sendStatus();
  }

  interrupt(): void {
    this.agent.stop();
  }

  /** Tear the session down: abort any run, release pending prompts, and close
   *  MCP servers (their child processes — playwright chrome etc. — otherwise
   *  live until the grayskull-web process dies). */
  close(): void {
    if (this.tokTicker) {
      clearInterval(this.tokTicker);
      this.tokTicker = null;
    }
    this.agent.stop();
    for (const [reqId, entry] of this.pending) {
      this.pending.delete(reqId);
      entry.resolve("no");
    }
    this.persist(); // closing parks it in the sidebar, resumable any time
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

  /** /setup in the browser: send the setup modal's data — field groups
   *  immediately, services after the (slow, network-probing) checks finish. */
  async setupOpen(): Promise<void> {
    this.send({ t: "setup_data", groups: listGroups(this.settings), services: [], checking: true });
    const services = await checkServices(this.settings, this.mcp, this.cwd);
    this.send({ t: "setup_data", groups: listGroups(this.settings), services, checking: false });
  }

  /** Live-apply one field edit from the browser (persisted only on save). */
  setupApply(id: string, value: string): void {
    const ok = applyField(id, value, {
      settings: this.settings,
      client: this.client,
      mcp: this.mcp,
      onAsyncChange: () => void this.setupRefresh(),
    });
    this.send({ t: "setup_groups", groups: listGroups(this.settings), bad: ok ? null : id });
    this.sendStatus();
  }

  private async setupRefresh(): Promise<void> {
    const services = await checkServices(this.settings, this.mcp, this.cwd);
    this.send({ t: "setup_data", groups: listGroups(this.settings), services, checking: false });
  }

  setupPresetAdd(name: string): void {
    const added = addPreset(this.settings, name);
    if (!added) this.send({ t: "error", text: `preset name "${name}" empty or already taken` });
    this.send({ t: "setup_groups", groups: listGroups(this.settings), bad: null });
  }

  setupPresetRemove(name: string): void {
    if (removePreset(this.settings, name)) {
      this.send({ t: "setup_groups", groups: listGroups(this.settings), bad: null });
    }
  }

  setupFamilyAdd(name: string): void {
    const added = addFamily(this.settings, name);
    if (!added) this.send({ t: "error", text: `family name "${name}" empty or already taken` });
    this.send({ t: "setup_groups", groups: listGroups(this.settings), bad: null });
  }

  /** models.dev search for the setup modal's import panel. */
  async modelsdevSearch(query: string): Promise<void> {
    try {
      const hits = await searchModelsDev(query);
      this.send({ t: "modelsdev_results", hits, query });
    } catch (err) {
      this.send({ t: "modelsdev_results", hits: [], query, error: (err as Error).message });
    }
  }

  /** Import one models.dev entry as a /model preset (in memory — SAVE persists). */
  async modelsdevImport(ref: string): Promise<void> {
    try {
      const hits = await searchModelsDev(ref);
      const entry = hits.find((h) => h.ref === ref) ?? hits[0];
      if (!entry) return this.send({ t: "error", text: `models.dev: nothing matches "${ref}"` });
      const name = entry.id.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
      this.settings.models[name] = presetFromEntry(entry, this.settings);
      this.send({ t: "setup_groups", groups: listGroups(this.settings), bad: null });
      this.bridge.pushItem({
        type: "note",
        text: `setup: imported "${name}" from models.dev (${entry.name}) — endpoint kept at ${this.settings.baseURL}; SAVE to persist, /model ${name} to switch`,
      });
    } catch (err) {
      this.send({ t: "error", text: `models.dev import failed: ${(err as Error).message}` });
    }
  }

  setupSave(ids: unknown): void {
    const dirty = new Set((Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string"));
    if (!dirty.size) return;
    try {
      const path = saveGlobal(this.settings, dirty);
      this.send({ t: "setup_saved", path });
      this.bridge.pushItem({
        type: "note",
        text: `setup: saved ${dirty.size} change${dirty.size > 1 ? "s" : ""} → ${path}`,
      });
    } catch (err) {
      this.send({ t: "error", text: `setup save failed: ${(err as Error).message}` });
    }
  }

  // ── agent personas (Agents panel) ───────────────────────────────────────

  /** Send the full persona roster (enabled flag included) for the Agents panel. */
  agentsOpen(): void {
    this.send({
      t: "agents_data",
      agents: loadAgents(this.cwd, this.settings.disabledAgents).map((a) => ({
        name: a.name,
        description: a.description,
        tools: a.tools,
        skills: a.skills,
        triggers: a.triggers,
        systemPrompt: a.systemPrompt,
        scope: a.scope,
        enabled: a.enabled,
      })),
    });
  }

  /** Create or edit a persona from the modal. Built-ins can't be written to
   *  disk, so editing one writes a local override with the same name. */
  agentSave(a: Record<string, unknown>): void {
    const name = String(a["name"] ?? "").trim();
    if (!/^[a-z0-9-]+$/.test(name)) {
      return this.send({ t: "error", text: "agent name must be kebab-case (a-z, 0-9, -)" });
    }
    const list = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.map(String).map((s) => s.trim()).filter(Boolean)
        : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const existing = loadAgents(this.cwd).find((x) => x.name === name);
    // preserve the existing non-builtin scope on edit; new agents default local
    const scope =
      a["scope"] === "global"
        ? "global"
        : existing && existing.scope !== "builtin"
          ? existing.scope
          : "local";
    try {
      const path = writeAgentDef({
        cwd: this.cwd,
        scope,
        name,
        description: String(a["description"] ?? "").trim(),
        tools: list(a["tools"]).length ? list(a["tools"]) : ["read", "grep", "glob", "bash"],
        skills: list(a["skills"]),
        triggers: list(a["triggers"]),
        systemPrompt: String(a["systemPrompt"] ?? "").trim(),
      });
      this.bridge.pushItem({ type: "note", text: `⚔ persona ${existing ? "updated" : "created"}: ${name} → ${path}` });
    } catch (err) {
      return this.send({ t: "error", text: `agent save failed: ${(err as Error).message}` });
    }
    this.agentsOpen();
  }

  /** Enable/disable a persona (persisted in settings.disabledAgents). */
  agentToggle(name: string): void {
    if (!loadAgents(this.cwd).some((a) => a.name === name)) {
      return this.send({ t: "error", text: `no agent named ${name}` });
    }
    this.settings.disabledAgents = toggleAgentDisabled(this.settings.disabledAgents, name);
    try {
      saveGlobal(this.settings, new Set(["disabledAgents"]));
    } catch {
      // session-local toggle still applies even if the write fails
    }
    this.agentsOpen();
  }

  /** Delete a persona def (built-ins can only be disabled, not deleted). */
  agentDelete(name: string): void {
    const def = loadAgents(this.cwd).find((a) => a.name === name);
    if (def?.scope === "builtin") {
      return this.send({ t: "error", text: `${name} is built-in — disable it instead of deleting` });
    }
    if (deleteAgentDef(this.cwd, name)) {
      // drop any stale disabled entry so a re-created agent starts enabled
      if (this.settings.disabledAgents.includes(name)) {
        this.settings.disabledAgents = toggleAgentDisabled(this.settings.disabledAgents, name);
        try {
          saveGlobal(this.settings, new Set(["disabledAgents"]));
        } catch {
          // best effort
        }
      }
      this.bridge.pushItem({ type: "note", text: `⚔ persona deleted: ${name}` });
    }
    this.agentsOpen();
  }

  // ── skill hub (/skills browse in the browser) ─────────────────────────

  /** remote catalog cached per session — one tree fetch per repo per day */
  private hubCatalog: RemoteSkill[] | null = null;
  private hubErrors: string[] = [];

  private async hubLoad(): Promise<RemoteSkill[]> {
    if (this.hubCatalog) return this.hubCatalog;
    this.hubErrors = [];
    this.hubCatalog = await loadHub(this.settings.skillRepos, (repo, msg) =>
      this.hubErrors.push(`${repo}: ${msg}`),
    );
    return this.hubCatalog;
  }

  /** Open the skill-hub modal: ack immediately (spinner), catalog when loaded. */
  async skillsOpen(query = ""): Promise<void> {
    this.send({ t: "skills_data", checking: true, query });
    const all = await this.hubLoad();
    this.send({
      t: "skills_data",
      checking: false,
      query,
      total: all.length,
      repos: this.settings.skillRepos.map((r) => ({
        name: r.name,
        repo: r.repo,
        disabled: !!r.disabled,
      })),
      errors: this.hubErrors,
      hits: rankSkills(all, query, 100),
    });
  }

  async skillsSearch(query: string): Promise<void> {
    const all = await this.hubLoad();
    this.send({ t: "skills_results", query, hits: rankSkills(all, query, 100) });
  }

  /** Client passes the hit back verbatim — no server-side hit registry. */
  private asRemoteSkill(raw: unknown): RemoteSkill | null {
    const o = raw as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const { name, path, repo, ref, source } = o;
    if ([name, path, repo, ref, source].some((v) => typeof v !== "string")) return null;
    return { name, path, repo, ref, source } as RemoteSkill;
  }

  async skillsDetail(raw: unknown): Promise<void> {
    const skill = this.asRemoteSkill(raw);
    if (!skill) return;
    try {
      const detail = await fetchSkillDetail(skill, this.settings.skillRepos);
      this.send({ t: "skills_detail", detail });
    } catch (err) {
      this.send({ t: "error", text: `skill preview failed: ${(err as Error).message}` });
    }
  }

  async skillsInstall(raw: unknown, scope: string): Promise<void> {
    const skill = this.asRemoteSkill(raw);
    if (!skill) return;
    const target = scope === "global" ? "global" : "local";
    try {
      const detail = await fetchSkillDetail(skill, this.settings.skillRepos);
      const { dir, fileCount } = await installSkill(detail, target, this.cwd);
      this.send({ t: "skills_installed", name: detail.name, dir, scope: target });
      this.bridge.pushItem({
        type: "note",
        text: `⚡ skill "${detail.name}" installed (${target}, ${fileCount} file${fileCount === 1 ? "" : "s"}) → ${dir} — invoke with /${detail.name}`,
      });
    } catch (err) {
      this.send({ t: "error", text: `skill install failed: ${(err as Error).message}` });
    }
  }

  async setupRecheck(): Promise<void> {
    this.send({ t: "setup_data", groups: listGroups(this.settings), services: [], checking: true });
    const services = await recheckServices(this.settings, this.mcp, this.cwd, true);
    this.send({ t: "setup_data", groups: listGroups(this.settings), services, checking: false });
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
  /** persisted sessions not currently running — shown dimmed in the sidebar */
  readonly dormant = new Map<string, SavedSessionMeta>();
  private broadcast: Broadcast;

  constructor(broadcast: Broadcast) {
    this.broadcast = broadcast;
    ensureWebDirs();
    for (const meta of loadSessionMetas()) this.dormant.set(meta.sid, meta);
  }

  create(cwd: string, createDir = false, kind: SessionKind = "project"): WebSession | { error: string } | { needsCreate: string } {
    if (kind === "chat") cwd = CHATS_CWD; // folder-less chats share a synthetic home
    if (!existsSync(cwd)) {
      if (!createDir && kind !== "chat") return { needsCreate: cwd };
      try {
        mkdirSync(cwd, { recursive: true });
      } catch (err) {
        return { error: `could not create ${cwd}: ${(err as Error).message}` };
      }
    }
    try {
      const session = new WebSession(cwd, this.broadcast, { kind });
      this.sessions.set(session.sid, session);
      this.broadcastList();
      session.sendStatus();
      session.sendMemory();
      return session;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Pick a parked session back up: reload conversation + transcript from disk
   *  and wire up a fresh registry/MCP/memory around it. */
  resume(sid: string): WebSession | { error: string } {
    const active = this.sessions.get(sid);
    if (active) return active;
    const saved = loadSession(sid);
    if (!saved) return { error: `no saved session ${sid}` };
    if (!existsSync(saved.cwd)) return { error: `directory ${saved.cwd} no longer exists` };
    try {
      const session = new WebSession(saved.cwd, this.broadcast, { restore: saved });
      this.sessions.set(session.sid, session);
      this.dormant.delete(sid);
      this.broadcastList();
      this.broadcast({ t: "replay", sid: session.sid, items: session.items.slice(-300) });
      session.sendStatus();
      session.sendMemory();
      return session;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Metas for the sidebar (active sids excluded, newest first). */
  dormantList(): SavedSessionMeta[] {
    return [...this.dormant.values()]
      .filter((m) => !this.sessions.has(m.sid))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Set by the server so list updates always carry the full picture
   *  (active + dormant + attached CLI sessions). */
  onListChange: (() => void) | null = null;

  broadcastList(): void {
    if (this.onListChange) return this.onListChange();
    this.broadcast({ t: "sessions", list: [...this.sessions.values()].map((s) => s.summary()) });
  }

  close(sid: string): void {
    const session = this.sessions.get(sid);
    if (!session) return;
    this.sessions.delete(sid);
    session.close();
    // parked, not gone: it reappears in the sidebar as resumable
    this.dormant.set(sid, {
      sid, kind: session.kind, cwd: session.cwd, title: session.title,
      mode: session.perms.mode, createdAt: 0, updatedAt: Date.now(),
    });
    this.broadcastList();
  }

  /** Permanently delete a parked session's file. Active sessions are closed first. */
  delete(sid: string): void {
    if (this.sessions.has(sid)) this.close(sid);
    this.dormant.delete(sid);
    deleteSession(sid);
    this.broadcastList();
  }
}
