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
import { modelProfile } from "./llm/profiles";
import { agentListing } from "./agents/registry";
import { skillTool } from "./skills/tool";
import { skillListing } from "./skills/registry";
import { ensureStarterChains } from "./chains/registry";
import { CliLink } from "./web/clilink";
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
// optional bridge to a running grayskull-web hub (silent retry when absent)
const link = new CliLink();
registerAgentTools({
  cwd,
  client,
  registry,
  concurrency: settings.agentConcurrency,
  leakDialect: modelProfile(settings.modelFamily).leakDialect,
  monitor: (ev) => link.publish({ t: "agent", ev }),
});
registry.register(skillTool(cwd));

const perms = new PermissionEngine(settings);
const memory = new MemoryManager(cwd, settings, client);
const mcp = new McpManager(registry, cwd);
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

const instance = render(
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
    link={link}
  />,
  { exitOnCtrlC: true },
);

// Open handles (MCP children, hub websocket, retry timers) keep the process
// alive after Ink unmounts — /exit and ctrl+c both land here for a real exit.
void instance.waitUntilExit().then(async () => {
  link.stop();
  await Promise.race([mcp.closeAll(), new Promise((r) => setTimeout(r, 1500))]);
  process.exit(0);
});
