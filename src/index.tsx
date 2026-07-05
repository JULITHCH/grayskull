#!/usr/bin/env bun
import { render } from "ink";
import { resolve } from "node:path";
import { ensureDirs } from "./config/paths";
import { ensureGlobalSystemPrompt, ensureLegendaryMode, loadSettings } from "./config/settings";
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
import { registerWorkerTools, workerPromptSection } from "./workers/tools";
import { ensureStarterWorkers } from "./workers/registry";
import { MODE_ORDER, type PermissionMode } from "./types";
import { App } from "./ui/App";

const USAGE = `grayskull — CLI agent for local models

usage: grayskull [options]              interactive TUI (default)
       grayskull -p "<prompt>"          headless one-shot: run, print result, exit
       echo "<prompt>" | grayskull -p   headless, prompt from stdin

options:
  -p, --print [prompt]   headless mode — no TUI, final answer on stdout,
                         progress on stderr. Permission asks are auto-DENIED;
                         combine with --mode for unattended edits.
  --mode <m>             permission mode: ${MODE_ORDER.join(" | ")}
  --add-dir <dir>        additional working directory surfaced to the model
                         (repeatable)
  -h, --help             this help`;

// ---- argv ----
const argv = process.argv.slice(2);
let printMode = false;
let printPrompt = "";
let modeOverride: PermissionMode | null = null;
const cliAddDirs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "-p" || a === "--print") {
    printMode = true;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      printPrompt = next;
      i++;
    }
  } else if (a === "--add-dir") {
    const d = argv[++i];
    if (d) cliAddDirs.push(resolve(d));
  } else if (a === "--mode") {
    const m = argv[++i] as PermissionMode;
    if (!MODE_ORDER.includes(m)) {
      console.error(`unknown mode "${m}" — options: ${MODE_ORDER.join(", ")}`);
      process.exit(1);
    }
    modeOverride = m;
  } else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option "${a}"\n\n${USAGE}`);
    process.exit(1);
  }
}

const cwd = process.cwd();
ensureDirs(cwd);
ensureGlobalSystemPrompt();
ensureStarterChains();
ensureStarterWorkers();
ensureLegendaryMode();

let settings: ReturnType<typeof loadSettings>;
try {
  settings = loadSettings(cwd);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
settings.addDirs = [...settings.addDirs, ...cliAddDirs];
if (modeOverride) settings.defaultMode = modeOverride;

const client = new LlmClient(settings);
const registry = new ToolRegistry();
for (const tool of builtinTools()) registry.register(tool);
// optional bridge to a running grayskull-web hub (silent retry when absent);
// headless runs skip it (no UI to mirror, and its retry timer would linger)
const link = printMode ? null : new CliLink();
registerWorkerTools({ registry, client, settings, cwd });
registerAgentTools({
  cwd,
  client,
  registry,
  concurrency: settings.agentConcurrency,
  settings,
  leakDialect: () => modelProfile(settings.modelFamily).leakDialect,
  monitor: (ev) => link?.publish({ t: "agent", ev }),
});
const skillGate = { forbidden: new Set<string>() };
registry.register(skillTool(cwd, skillGate));

const perms = new PermissionEngine(settings);
const memory = new MemoryManager(cwd, settings, client);
const mcp = new McpManager(registry, cwd);

if (printMode) {
  await runHeadless();
} else {
  runTui();
}

/** Headless one-shot: prompt → tool loop → final text on stdout. Notes and
 *  tool lines go to stderr so stdout stays pipeable. Permission prompts are
 *  auto-denied (nobody is watching) — use --mode kamikazeee/accept-edits for
 *  unattended work. */
async function runHeadless(): Promise<void> {
  if (!printPrompt && !process.stdin.isTTY) {
    printPrompt = (await Bun.stdin.text()).trim();
  }
  if (!printPrompt) {
    console.error(`no prompt given\n\n${USAGE}`);
    process.exit(1);
  }
  const err = (text: string) => process.stderr.write(text + "\n");
  const bridge: UiBridge = {
    pushItem: (item) => {
      if (item.type === "note") err(`· ${item.text}`);
      else if (item.type === "tool") {
        if (item.state === "running") err(`⚙ ${item.detail}`);
        else if (item.state === "error" || item.state === "denied") err(`✗ ${item.detail} (${item.state})`);
      }
    },
    assistantDelta: () => {},
    reasoningDelta: () => {},
    assistantDone: () => {},
    requestPermission: async (req) => {
      err(`✗ permission auto-denied (headless): ${req.detail} — rerun with --mode kamikazeee to auto-approve`);
      return "no";
    },
    askUser: async (question) => {
      err(`? ask_user auto-answered (headless): ${question.slice(0, 120)}`);
      return "No human is available (headless one-shot run). Decide yourself using best judgment and continue.";
    },
    setBusy: () => {},
  };
  const agent = new GrayskullAgent({ cwd, settings, client, registry, perms, memory, ui: bridge });
  agent.agentListing = () => agentListing(cwd);
  agent.workerListing = () => workerPromptSection();
  agent.skillListing = (exclude) => skillListing(cwd, exclude);
  agent.skillGate = skillGate;

  // headless needs the MCP tools ready BEFORE the first request — but never
  // hang on a wedged server
  await Promise.race([mcp.connectAll(settings), new Promise((r) => setTimeout(r, 20_000))]);

  const final = await agent.runTurn(printPrompt);
  if (final) process.stdout.write(final + "\n");
  await Promise.race([mcp.closeAll(), new Promise((r) => setTimeout(r, 1500))]);
  process.exit(agent.lastError ? 1 : 0);
}

function runTui(): void {
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
  agent.workerListing = () => workerPromptSection();
  agent.skillListing = (exclude) => skillListing(cwd, exclude);
  agent.skillGate = skillGate;

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
      link={link!}
    />,
    { exitOnCtrlC: true },
  );

  // Open handles (MCP children, hub websocket, retry timers) keep the process
  // alive after Ink unmounts — /exit and ctrl+c both land here for a real exit.
  void instance.waitUntilExit().then(async () => {
    link?.stop();
    await Promise.race([mcp.closeAll(), new Promise((r) => setTimeout(r, 1500))]);
    process.exit(0);
  });
}
