#!/usr/bin/env bun
import { render } from "ink";
import { ensureDirs } from "./config/paths";
import { ensureGlobalSystemPrompt, loadSettings } from "./config/settings";
import { LlmClient } from "./llm/client";
import { ToolRegistry, builtinTools } from "./tools";
import { PermissionEngine } from "./perms/engine";
import { MemoryManager } from "./memory/memory";
import { McpManager } from "./mcp/manager";
import { SessionStore } from "./session/store";
import { GrayskullAgent, type UiBridge } from "./agent/loop";
import { registerAgentTools } from "./agents/runner";
import { agentListing } from "./agents/registry";
import { skillTool } from "./skills/tool";
import { skillListing } from "./skills/registry";
import { ensureStarterChains } from "./chains/registry";
import { App } from "./ui/App";

const cwd = process.cwd();
ensureDirs(cwd);
ensureGlobalSystemPrompt();
ensureStarterChains();

let settings;
try {
  settings = loadSettings(cwd);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const client = new LlmClient(settings);
const registry = new ToolRegistry();
for (const tool of builtinTools()) registry.register(tool);
registerAgentTools({ cwd, client, registry, concurrency: settings.agentConcurrency });
registry.register(skillTool(cwd));

const perms = new PermissionEngine(settings);
const memory = new MemoryManager(cwd, settings, client);
const mcp = new McpManager(registry);
const store = new SessionStore(cwd);

// The App fills these in on mount; nothing calls them before first render.
const bridge: UiBridge = {
  pushItem: () => {},
  assistantDelta: () => {},
  reasoningDelta: () => {},
  assistantDone: () => {},
  requestPermission: async () => "no",
  askUser: async () => "",
  setBusy: () => {},
};

const agent = new GrayskullAgent({ cwd, settings, client, registry, perms, memory, ui: bridge });
agent.agentListing = () => agentListing(cwd);
agent.skillListing = () => skillListing(cwd);

// connect MCP in the background; searxng is on by default
void mcp.connectAll(settings);

render(
  <App
    cwd={cwd}
    settings={settings}
    agent={agent}
    bridge={bridge}
    memory={memory}
    mcp={mcp}
    perms={perms}
    client={client}
    store={store}
  />,
  { exitOnCtrlC: true },
);
