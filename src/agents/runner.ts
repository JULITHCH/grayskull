import { z } from "zod";
import type { AgentMonitorEvent, ChatMessage, ToolContext, ToolDef } from "../types";
import type { LlmClient } from "../llm/client";
import type { ToolRegistry } from "../tools";
import { runToolLoop } from "../agent/loop";
import { loadAgents, writeAgentDef, DEFAULT_AGENT_TOOLS } from "./registry";
import { autoMatchSkills, autoSkillBlock } from "../skills/registry";

const SUB_AGENT_MAX_RESULT = 8_000;

/** Simple semaphore: vLLM batches requests, but unbounded fan-out trashes KV cache. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const spawnSchema = z.object({
  agent: z.string().describe("Name of an existing agent (see 'Available sub-agents' in your context)."),
  task: z.string().describe("Complete, self-contained task for the agent. It cannot see this conversation — include all paths and context it needs."),
});

const createSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).describe("kebab-case agent name, e.g. spell-checker"),
  description: z.string().describe("One line: what this agent is for."),
  system_prompt: z.string().describe("The agent's full system prompt: role, exact procedure, and required output format."),
  tools: z.array(z.string()).optional().describe("Tool names the agent may use (default: read, grep, glob, bash). Give checkers read-only tools."),
  scope: z.enum(["local", "global"]).optional().describe("local = this project only (default), global = all projects."),
});

export function registerAgentTools(opts: {
  cwd: string;
  client: LlmClient;
  registry: ToolRegistry;
  concurrency: number;
  /** live agent-mesh feed (web UI); no-op when absent */
  monitor?: (ev: AgentMonitorEvent) => void;
}): void {
  const { cwd, client, registry } = opts;
  const monitor = opts.monitor ?? (() => {});
  const semaphore = new Semaphore(opts.concurrency);
  let spawnCounter = 0;

  const createAgentTool: ToolDef = {
    name: "create_agent",
    description:
      "Create a reusable sub-agent definition. Use when the user asks for an agent (e.g. 'create an agent that checks for spelling mistakes'). After creating it, use spawn_agent to run it.",
    kind: "edit",
    schema: createSchema,
    describeCall: (args) => `create_agent(${String(args["name"] ?? "")})`,
    previewCall: async (args) => {
      const a = createSchema.parse(args);
      return `# ${a.name} (${a.scope ?? "local"})\n${a.description}\ntools: ${(a.tools ?? DEFAULT_AGENT_TOOLS).join(", ")}\n\n${a.system_prompt}`;
    },
    execute: async (args) => {
      const a = createSchema.parse(args);
      const path = writeAgentDef({
        cwd,
        scope: a.scope ?? "local",
        name: a.name,
        description: a.description,
        tools: a.tools ?? [...DEFAULT_AGENT_TOOLS],
        systemPrompt: a.system_prompt,
      });
      return `Agent "${a.name}" created at ${path}. Run it with spawn_agent. You may call spawn_agent several times in one response to fan out over files/modules.`;
    },
  };

  const spawnAgentTool: ToolDef = {
    name: "spawn_agent",
    description:
      "Run a sub-agent on a task in a fresh context; returns its final report. For 'iterate over all modules' style work, call spawn_agent once per file/module (multiple calls in one response run concurrently).",
    kind: "execute",
    schema: spawnSchema,
    describeCall: (args) => `spawn_agent(${String(args["agent"] ?? "")}: ${String(args["task"] ?? "").slice(0, 50)})`,
    execute: async (args, ctx) => {
      const { agent: agentName, task } = spawnSchema.parse(args);
      const def = loadAgents(cwd).find((a) => a.name === agentName);
      if (!def) {
        const names = loadAgents(cwd).map((a) => a.name).join(", ") || "(none)";
        return `error: no agent named "${agentName}". Existing agents: ${names}. Create one with create_agent.`;
      }
      const spawnId = `${agentName}-${++spawnCounter}`;
      return semaphore.run(async () => {
        ctx.note(`⚔ ${agentName} → ${task.slice(0, 80)}`);
        monitor({ kind: "spawn", id: spawnId, agent: agentName, task });
        // sub-agents auto-utilize matching skills too
        let autoSkills = "";
        try {
          autoSkills = autoSkillBlock(autoMatchSkills(task, cwd));
        } catch {
          // skills are optional context
        }
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: `${def.systemPrompt}\n\nYou are a sub-agent. Work autonomously — you cannot ask the user questions. cwd: ${cwd}. When done, your final message is your report; make it complete and self-contained.${autoSkills ? `\n\n${autoSkills}` : ""}`,
          },
          { role: "user", content: task },
        ];
        // depth 1: sub-agents never get spawn/create/ask tools
        const allowed = def.tools.filter(
          (t) => !["spawn_agent", "create_agent", "ask_user"].includes(t),
        );
        const subCtx: ToolContext = {
          cwd,
          askUser: async () => "(sub-agents cannot ask the user — decide yourself)",
          note: () => {},
        };
        const result = await runToolLoop({
          client,
          registry,
          schemas: registry.schemas(allowed),
          messages,
          ctx: subCtx,
          onTextDelta: (text) => monitor({ kind: "delta", id: spawnId, agent: agentName, text }),
          // sub-agent work must be visible in the main transcript
          onToolEvent: (i) => {
            monitor({ kind: "tool", id: spawnId, agent: agentName, detail: i.detail, state: i.state });
            if (i.state === "done" || i.state === "error") {
              ctx.note(`  ⚔ ${agentName} · ${i.detail}`);
            }
          },
        });
        ctx.note(`⚔ ${agentName} done`);
        const report = result || "(agent produced no report)";
        monitor({ kind: "done", id: spawnId, agent: agentName, report: report.slice(0, 2000) });
        return report.length > SUB_AGENT_MAX_RESULT
          ? report.slice(0, SUB_AGENT_MAX_RESULT) + "\n[report truncated]"
          : report;
      });
    },
  };

  registry.register(createAgentTool);
  registry.register(spawnAgentTool);
}
