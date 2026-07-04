#!/usr/bin/env bun
// Headless one-shot driver: run a single grayskull turn (or thinkingchain)
// without the Ink UI, unattended (kamikazeee). Used by automated eval loops.
//
//   cd <target-project> && bun /path/to/heman/scripts/headless.ts [--chain <name>] "<prompt>"
//   bun scripts/headless.ts --prompt-file task.md
//
// Env: HEADLESS_TIMEOUT_MIN (default 45) hard-kills the run with exit 124.

import { ensureDirs } from "../src/config/paths";
import { ensureGlobalSystemPrompt, ensureLegendaryMode, loadSettings } from "../src/config/settings";
import { LlmClient } from "../src/llm/client";
import { ToolRegistry, builtinTools } from "../src/tools";
import { PermissionEngine } from "../src/perms/engine";
import { MemoryManager } from "../src/memory/memory";
import { McpManager } from "../src/mcp/manager";
import { GrayskullAgent, type UiBridge } from "../src/agent/loop";
import { registerAgentTools } from "../src/agents/runner";
import { modelProfile } from "../src/llm/profiles";
import { agentListing } from "../src/agents/registry";
import { skillTool } from "../src/skills/tool";
import { skillListing } from "../src/skills/registry";
import { ensureStarterChains, loadChains } from "../src/chains/registry";
import { runChain } from "../src/chains/runner";
import { ensureStarterWorkers } from "../src/workers/registry";
import { registerWorkerTools, workerPromptSection } from "../src/workers/tools";

function parseArgs(argv: string[]): { prompt: string; chain?: string } {
  let chain: string | undefined;
  let promptFile: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--chain") chain = argv[++i];
    else if (a === "--prompt-file") promptFile = argv[++i];
    else rest.push(a);
  }
  const prompt = promptFile ? require("fs").readFileSync(promptFile, "utf8") : rest.join(" ");
  if (!prompt.trim()) {
    console.error('usage: headless.ts [--chain <name>] [--prompt-file <f>] "<prompt>"');
    process.exit(2);
  }
  return { prompt: prompt.trim(), chain };
}

const { prompt, chain: chainName } = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
ensureDirs(cwd);
ensureGlobalSystemPrompt();
ensureStarterChains();
ensureStarterWorkers();
ensureLegendaryMode();

const settings = loadSettings(cwd);
const client = new LlmClient(settings);
const registry = new ToolRegistry();
for (const tool of builtinTools()) registry.register(tool);
registerWorkerTools({ registry, client, settings, cwd });
registerAgentTools({
  cwd,
  client,
  registry,
  concurrency: settings.agentConcurrency,
  settings,
  leakDialect: () => modelProfile(settings.modelFamily).leakDialect,
});
const skillGate = { forbidden: new Set<string>() };
registry.register(skillTool(cwd, skillGate));

const perms = new PermissionEngine(settings);
perms.mode = "kamikazeee"; // unattended: auto-allow tools, auto-answer ask_user
const memory = new MemoryManager(cwd, settings, client);
const mcp = new McpManager(registry, cwd);

const started = Date.now();
const stamp = () => `[${Math.round((Date.now() - started) / 1000)}s]`;
let streamedThisLine = false;
const endStream = () => {
  if (streamedThisLine) {
    process.stdout.write("\n");
    streamedThisLine = false;
  }
};

const bridge: UiBridge = {
  pushItem: (item) => {
    endStream();
    if (item.type === "tool") {
      if (item.state === "running") return; // log once, on completion
      const suffix = item.state === "done" ? "" : ` [${item.state}]`;
      console.log(`${stamp()} ⚒ ${item.detail}${suffix}`);
      if (item.state === "error" && item.result) console.log(`    ↳ ${item.result.slice(0, 500)}`);
    } else if (item.type === "note") {
      console.log(`${stamp()} • ${item.text}`);
    } else if (item.type === "banner") {
      console.log(`${stamp()} ${item.text}`);
    } else if (item.type === "assistant" && !item.streaming) {
      console.log(`${stamp()} assistant: ${item.text}`);
    }
  },
  assistantDelta: (d) => {
    process.stdout.write(d);
    streamedThisLine = true;
  },
  reasoningDelta: () => {}, // dropped in headless logs
  assistantDone: () => endStream(),
  // kamikazeee handles both of these before they reach the bridge; safety nets:
  requestPermission: async () => "yes",
  askUser: async () => "Decide yourself using best judgment and continue.",
  setBusy: () => {},
};

const agent = new GrayskullAgent({ cwd, settings, client, registry, perms, memory, ui: bridge });
agent.agentListing = () => agentListing(cwd);
agent.workerListing = () => workerPromptSection();
agent.skillListing = (exclude) => skillListing(cwd, exclude);
agent.skillGate = skillGate;

const timeoutMin = Number(process.env.HEADLESS_TIMEOUT_MIN || 45);
const watchdog = setTimeout(() => {
  endStream();
  console.error(`${stamp()} ✖ watchdog: ${timeoutMin}min elapsed, killing run`);
  process.exit(124);
}, timeoutMin * 60_000);
watchdog.unref?.();

console.log(`${stamp()} headless grayskull — cwd=${cwd} model=${settings.model}`);
console.log(`${stamp()} prompt: ${prompt.slice(0, 300)}${prompt.length > 300 ? "…" : ""}`);

try {
  // MCP must be up before the turn starts (playwright etc.), unlike the TUI
  // where it connects in the background while the user types
  await mcp.connectAll(settings);
  console.log(`${stamp()} mcp connected: ${registry.schemas().filter((s) => s.name.startsWith("mcp__")).length} tools`);

  if (chainName) {
    const def = loadChains().find((c) => c.name === chainName);
    if (!def) {
      console.error(`chain not found: ${chainName} (have: ${loadChains().map((c) => c.name).join(", ")})`);
      process.exit(2);
    }
    await runChain({ chain: def, task: prompt, mode: def.context, agent, ui: bridge, memory });
  } else {
    await agent.runTurn(prompt);
  }
  endStream();
  const failed = agent.lastError !== null;
  console.log(`${stamp()} ${failed ? `✖ turn errored: ${agent.lastError}` : "✔ turn complete"}`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  endStream();
  console.error(`${stamp()} ✖ fatal: ${(err as Error).message}`);
  process.exit(1);
}
