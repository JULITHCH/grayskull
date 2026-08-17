import { loadSettings, type Settings } from "../config/settings";
import { ensureDirs } from "../config/paths";
import { LlmClient } from "../llm/client";
import { ToolRegistry, builtinTools } from "../tools";
import { PermissionEngine, type PermissionDecision } from "../perms/engine";
import { MemoryManager, loadGlobalMemory } from "../memory/memory";
import { McpManager } from "../mcp/manager";
import { GrayskullAgent, type UiBridge } from "../agent/loop";
import { registerAgentTools } from "../agents/runner";
import { skillTool } from "../skills/tool";
import { skillListing } from "../skills/registry";
import { agentListing } from "../agents/registry";
import { makeTodoTool } from "../tools/todo";
import { modelProfile } from "../llm/profiles";
import type { ChatMessage, ToolDef } from "../types";

/**
 * A grayskull agent behind the OpenAI-compatible API (web/openai.ts).
 *
 * Deliberately NOT a WebSession: an API turn has no browser to answer a
 * permission prompt, must not persist into the session sidebar, and needs its
 * own tool gating (web search off by default, read-only by default). Same
 * shape as the Discord bot — a private agent with a non-interactive
 * permission engine — pooled and reused because MCP startup is expensive.
 */

/** MCP servers whose tools count as "web search" for the per-request gate. */
const WEB_SEARCH_PREFIX = "mcp__searxng__";

export class ApiPermissionEngine extends PermissionEngine {
  constructor(settings: Settings, private readonly full: boolean) {
    super(settings);
  }

  override decide(tool: ToolDef, args: Record<string, unknown>): PermissionDecision {
    if (this.full) return { kind: "allow" };
    if (tool.kind === "read") return { kind: "allow" };
    void args;
    return {
      kind: "deny",
      reason:
        `the OpenAI-compatible API runs read-only — "${tool.name}" would ${tool.kind === "edit" ? "modify files" : "run commands"}. ` +
        "Answer from what you can read/search, or the operator can set ⚙ → API → permissions to \"full\".",
    };
  }
}

export interface ApiTurn {
  /** conversation before the final user message (OpenAI sends full history) */
  history: ChatMessage[];
  text: string;
  images: string[];
  webSearch: boolean;
  temperature?: number | undefined;
  topP?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** tool activity, for the log and the x_grayskull response extra */
  onTool?: (detail: string) => void;
}

export class ApiSession {
  readonly settings: Settings;
  readonly agent: GrayskullAgent;
  readonly client: LlmClient;
  private readonly mcp: McpManager;
  private readonly registry: ToolRegistry;
  private live: ApiTurn | null = null;
  busy = false;
  /** tools used in the current turn (reported back as an extra field) */
  private toolsUsed: string[] = [];

  constructor(readonly cwd: string, private readonly log: (text: string) => void) {
    ensureDirs(cwd);
    const settings = loadSettings(cwd);
    settings.defaultMode = "normal";
    // an API caller is not sitting in a coding session: the gates that block a
    // turn to demand a blueprint or a browser screenshot would just hang it
    settings.planFirst.enabled = false;
    settings.visualVerify.enabled = false;
    settings.promptExpand.enabled = false;
    settings.stuckResearch.enabled = false;
    settings.memory.enabled = settings.api.memory;
    // a chat-shaped request must not grind through 120 tool iterations
    settings.maxLoopTurns = Math.min(settings.maxLoopTurns, 24);
    // web-facing MCP only: an API session must not boot a browser and two LSP
    // children per pool slot, and it keeps the web-search gate meaningful
    settings.mcpServers = Object.fromEntries(
      Object.entries(settings.mcpServers).filter(([name]) => name === "searxng" || name === "context7"),
    );
    this.settings = settings;

    this.client = new LlmClient(settings);
    const registry = new ToolRegistry();
    for (const t of builtinTools()) registry.register(t);
    const todo = makeTodoTool();
    registry.register(todo.tool);
    const skillGate = { forbidden: new Set<string>() };
    registry.register(skillTool(cwd, skillGate));
    registerAgentTools({
      cwd,
      client: this.client,
      registry,
      concurrency: settings.agentConcurrency,
      settings,
      leakDialect: () => modelProfile(settings.modelFamily).leakDialect,
      monitor: () => {},
    });
    this.registry = registry;

    const perms = new ApiPermissionEngine(settings, settings.api.permissions === "full");
    const memory = new MemoryManager(cwd, settings, this.client);
    // API callers must never write the operator's global vault (same reasoning
    // as the Discord bot: an outside prompt is not a trusted operator)
    memory.rememberGlobal = async () => "";
    (memory as unknown as { mergeGlobal: () => Promise<string> }).mergeGlobal = async () => loadGlobalMemory();
    this.mcp = new McpManager(registry, cwd);

    const bridge: UiBridge = {
      pushItem: (item) => {
        if (item.type === "tool" && item.state === "running") {
          this.toolsUsed.push(item.name);
          this.live?.onTool?.(item.detail);
        }
        if (item.type === "tool" && (item.state === "error" || item.state === "denied")) {
          this.live?.onTool?.(`${item.detail} (${item.state})`);
        }
      },
      assistantDelta: (delta) => this.live?.onText?.(delta),
      reasoningDelta: (delta) => this.live?.onReasoning?.(delta),
      assistantDone: () => {},
      // the engine never returns "ask" — this is the backstop, not a flow
      requestPermission: async () => "no",
      askUser: async () =>
        "No human is available (HTTP API request). Decide yourself using best judgment and finish the answer.",
      setBusy: () => {},
    };

    this.agent = new GrayskullAgent({ cwd, settings, client: this.client, registry, perms, memory, ui: bridge });
    this.agent.agentListing = () => agentListing(cwd, settings.disabledAgents);
    this.agent.skillListing = (exclude) => skillListing(cwd, exclude);
    this.agent.skillGate = skillGate;
    void this.mcp.connectAll(settings);
  }

  /** MCP tool names minus the web-search server — the `only` list that keeps
   *  every builtin and every other MCP tool but hides search when it's off. */
  private mcpGate(webSearch: boolean): string[] {
    return this.registry
      .list()
      .map((t) => t.name)
      .filter((n) => webSearch || !n.startsWith(WEB_SEARCH_PREFIX));
  }

  hasWebSearch(): boolean {
    return this.registry.list().some((t) => t.name.startsWith(WEB_SEARCH_PREFIX));
  }

  /** One stateless turn: history is replaced, not appended to. */
  async run(turn: ApiTurn): Promise<{ text: string; toolsUsed: string[]; error: string | null }> {
    // `busy` belongs to the pool (it hands the session out and takes it back) —
    // flipping it here would let a queued request grab a session mid-handoff
    this.live = turn;
    this.toolsUsed = [];
    const s = this.settings;
    const savedMax = s.maxTokens;
    try {
      if (turn.maxTokens && turn.maxTokens > 0) s.maxTokens = Math.min(savedMax, turn.maxTokens);
      // per-request sampling (temperature/top_p) as a transient profile, exactly
      // like a chain step — never written back into the saved settings
      if (turn.temperature !== undefined || turn.topP !== undefined) {
        this.client.setInferenceProfile({
          enableThinking: s.enableThinking,
          temperature: turn.temperature ?? s.temperature,
          topP: turn.topP ?? s.topP,
          topK: s.topK,
          minP: s.minP,
        });
      }
      // web search is opt-in per request: gate the searxng tools out of the
      // schema list so the model cannot even see them
      this.agent.setStepMcp(true, this.mcpGate(turn.webSearch));
      this.agent.history = turn.history;
      const onAbort = () => this.agent.stop();
      turn.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const text = await this.guarded(turn);
        return { text, toolsUsed: [...new Set(this.toolsUsed)], error: this.agent.lastError };
      } finally {
        turn.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      s.maxTokens = savedMax;
      this.client.setInferenceProfile(null);
      this.agent.setStepMcp(undefined, []);
      this.agent.history = [];
      this.live = null;
    }
  }

  /** Wall-clock cap: a wedged turn must free its pool slot. */
  private async guarded(turn: ApiTurn): Promise<string> {
    const ms = this.settings.api.timeoutSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      const result = await Promise.race([this.agent.runTurn(turn.text, turn.images), timeout]);
      if (result !== null) return result;
      this.log(`api: turn exceeded ${this.settings.api.timeoutSeconds}s — aborted`);
      this.agent.stop();
      await new Promise((r) => setTimeout(r, 1000));
      return "";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.agent.stop();
    await Promise.race([this.mcp.closeAll(), new Promise((r) => setTimeout(r, 1500))]);
  }
}

/**
 * Small pool of API sessions. MCP startup (searxng, playwright, LSP children)
 * costs seconds, so sessions are reused; requests beyond the cap queue instead
 * of spawning an unbounded number of agents.
 */
export class ApiSessionPool {
  private sessions: ApiSession[] = [];
  private waiters: Array<(s: ApiSession) => void> = [];

  constructor(
    private readonly cwd: () => string,
    private readonly max: () => number,
    private readonly log: (text: string) => void,
  ) {}

  async acquire(): Promise<ApiSession> {
    const cwd = this.cwd();
    // a cwd change (settings edit) retires the old sessions lazily
    const stale = this.sessions.filter((s) => s.cwd !== cwd && !s.busy);
    for (const s of stale) void s.close();
    this.sessions = this.sessions.filter((s) => s.cwd === cwd || s.busy);

    const free = this.sessions.find((s) => !s.busy && s.cwd === cwd);
    if (free) {
      free.busy = true; // claim it before awaiting anything else
      return free;
    }
    if (this.sessions.length < Math.max(1, this.max())) {
      const s = new ApiSession(cwd, this.log);
      s.busy = true;
      this.sessions.push(s);
      this.log(`api: agent session ${this.sessions.length} started (${cwd})`);
      return s;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(s: ApiSession): void {
    s.busy = false;
    const next = this.waiters.shift();
    if (next) {
      s.busy = true;
      next(s);
    }
  }

  async closeAll(): Promise<void> {
    const all = this.sessions;
    this.sessions = [];
    await Promise.all(all.map((s) => s.close()));
  }
}
