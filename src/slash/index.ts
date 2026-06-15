import type { PermissionMode, TranscriptItem } from "../types";
import type { Settings } from "../config/settings";
import type { GrayskullAgent } from "../agent/loop";
import type { MemoryManager } from "../memory/memory";
import { loadGlobalMemory, loadLocalMemory, saveLocalMemory } from "../memory/memory";
import { ScoreStore, bulletHash, archivePath } from "../memory/scores";
import { readFileSync } from "node:fs";
import type { McpManager } from "../mcp/manager";
import type { PermissionEngine } from "../perms/engine";
import type { SessionStore } from "../session/store";
import { SessionStore as Store } from "../session/store";
import {
  GLOBAL_SETTINGS,
  GLOBAL_SYSTEM_PROMPT,
  GLOBAL_MEMORY,
  localSettings,
  localSystemPrompt,
  localMemory,
} from "../config/paths";
import { loadAgents, deleteAgentDef } from "../agents/registry";
import { loadSkills, skillInvocation } from "../skills/registry";
import {
  loadChains,
  saveChain,
  deleteChain,
  parseChainBody,
  isGate,
  BUILTIN_STEPS,
  type ChainDef,
  type ChainContextMode,
} from "../chains/registry";
import { chainState } from "../chains/runner";
import { openInEditor, pickChoice } from "../ui/external";
import { existsSync, writeFileSync } from "node:fs";
import { MODE_ORDER } from "../types";

export interface CommandContext {
  cwd: string;
  settings: Settings;
  agent: GrayskullAgent;
  memory: MemoryManager;
  mcp: McpManager;
  perms: PermissionEngine;
  store: SessionStore;
  push: (item: TranscriptItem) => void;
  setMode: (mode: PermissionMode) => void;
  clearTranscript: () => void;
  exit: () => void;
}

/** A command either handles everything itself, returns a prompt to send to
 *  the model, or asks the App to run/activate a thinking chain. */
export type CommandResult =
  | void
  | { prompt: string }
  | { chain: { def: ChainDef; mode: ChainContextMode; task?: string } };

interface SlashCommand {
  name: string;
  description: string;
  run: (ctx: CommandContext, args: string) => Promise<CommandResult>;
}

const note = (ctx: CommandContext, text: string) => ctx.push({ type: "note", text });

export const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "list commands and keys",
    run: async (ctx) => {
      const lines = COMMANDS.map((c) => `/${c.name} — ${c.description}`).join("\n");
      note(ctx, `${lines}\n\nkeys: shift+tab cycle modes · @ pick file with fzf · esc interrupt · ctrl+c exit`);
    },
  },
  {
    name: "system",
    description: "edit system prompt in $EDITOR (/system local for project)",
    run: async (ctx, args) => {
      const local = args.trim() === "local";
      const path = local ? localSystemPrompt(ctx.cwd) : GLOBAL_SYSTEM_PROMPT;
      if (local && !existsSync(path)) writeFileSync(path, "# Project instructions\n");
      openInEditor(path, ctx.settings.editor);
      note(ctx, `edited ${path} — applies from the next message`);
    },
  },
  {
    name: "settings",
    description: "edit settings.json (/settings local for project)",
    run: async (ctx, args) => {
      const local = args.trim() === "local";
      const path = local ? localSettings(ctx.cwd) : GLOBAL_SETTINGS;
      if (local && !existsSync(path)) writeFileSync(path, "{\n}\n");
      openInEditor(path, ctx.settings.editor);
      note(ctx, `edited ${path} — restart grayskull to apply endpoint/MCP changes`);
    },
  },
  {
    name: "memory",
    description: "show memory (with scores); /memory edit [global] | archive",
    run: async (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "edit") {
        const global = parts[1] === "global";
        const path = global ? GLOBAL_MEMORY : localMemory(ctx.cwd);
        if (!existsSync(path)) writeFileSync(path, "");
        openInEditor(path, ctx.settings.editor);
        note(ctx, `edited ${path}`);
        return;
      }
      if (parts[0] === "archive") {
        const arch = archivePath(ctx.cwd);
        const content = existsSync(arch) ? readFileSync(arch, "utf8").trim() : "";
        note(ctx, content || "archive empty — nothing has faded yet");
        return;
      }
      const g = loadGlobalMemory() || "(empty)";
      let l = loadLocalMemory(ctx.cwd) || "(empty)";
      if (l !== "(empty)" && ctx.settings.memory.scoring) {
        const m = ctx.settings.memory;
        const store = new ScoreStore(ctx.cwd, {
          halfLifeDays: m.halfLifeDays,
          spreadFactor: m.spreadFactor,
          pruneThreshold: m.pruneThreshold,
          reviveThreshold: m.reviveThreshold,
        });
        l = l
          .split("\n")
          .map((line) => {
            const b = line.match(/^(\s*-\s+)(.+)$/);
            if (!b) return line;
            return `${b[1]}(${store.effective(bulletHash(b[2]!)).toFixed(2)}) ${b[2]}`;
          })
          .join("\n");
      }
      note(ctx, `# Global (GRAYSKULL.md) — never decays\n${g}\n\n# Project (.grayskull/memory.md) — (activation score)\n${l}`);
    },
  },
  {
    name: "remember",
    description: "save a fact to the GLOBAL vault: /remember <fact>",
    run: async (ctx, args) => {
      if (!args.trim()) {
        note(ctx, "usage: /remember <fact to keep forever, across all projects>");
        return;
      }
      const updated = await ctx.memory.rememberGlobal(args.trim());
      note(ctx, `⚡ global memory updated:\n${updated}`);
    },
  },
  {
    name: "forget",
    description: "remove matching lines from project memory: /forget <pattern>",
    run: async (ctx, args) => {
      const pattern = args.trim();
      if (!pattern) {
        note(ctx, "usage: /forget <substring or regex>");
        return;
      }
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const current = loadLocalMemory(ctx.cwd);
      const kept = current.split("\n").filter((line) => !(line.trim().startsWith("-") && re.test(line)));
      const removed = current.split("\n").length - kept.length;
      saveLocalMemory(ctx.cwd, kept.join("\n"));
      note(ctx, `removed ${removed} memory line(s)`);
    },
  },
  {
    name: "compact",
    description: "compact the conversation now",
    run: async (ctx) => {
      await ctx.agent.manualCompact();
      note(ctx, "context compacted");
    },
  },
  {
    name: "mcp",
    description: "MCP server status; /mcp reconnect <name>",
    run: async (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "reconnect" && parts[1]) {
        await ctx.mcp.reconnect(parts[1], ctx.settings);
      }
      const lines = [...ctx.mcp.statuses.values()]
        .map((s) => `${s.state === "connected" ? "●" : "○"} ${s.name}: ${s.state}, ${s.toolCount} tools${s.error ? ` (${s.error})` : ""}`)
        .join("\n");
      note(ctx, lines || "no MCP servers configured");
    },
  },
  {
    name: "mode",
    description: "show or set mode: /mode kamikazeee",
    run: async (ctx, args) => {
      const want = args.trim().toLowerCase() as PermissionMode;
      if (MODE_ORDER.includes(want)) {
        ctx.setMode(want);
      } else {
        note(ctx, `mode: ${ctx.perms.mode} (cycle with shift+tab; options: ${MODE_ORDER.join(", ")})`);
      }
    },
  },
  {
    name: "model",
    description: "switch the whole model stack live: /model [name]",
    run: async (ctx, args) => {
      const presets = ctx.settings.models;
      const names = Object.keys(presets);
      const want = args.trim();
      if (!want) {
        const lines = names.map((n) => {
          const p = presets[n]!;
          const active = p.baseURL === ctx.settings.baseURL && p.model === ctx.settings.model;
          return `${active ? "●" : "○"} ${n} — ${p.family} · ${p.model} @ ${p.baseURL}`;
        });
        return note(ctx, `${lines.join("\n")}\n\ncurrent: ${ctx.settings.model} (${ctx.settings.modelFamily})\nswitch with /model <name>`);
      }
      const preset = presets[want];
      if (!preset) {
        return note(ctx, `no model "${want}". Known: ${names.join(", ")}`);
      }
      ctx.agent.applyModelSwitch(preset);
      note(
        ctx,
        `⚡ switched to "${want}": ${preset.family} · ${preset.model} @ ${preset.baseURL} (ctx ${ctx.settings.contextWindow}, temp ${ctx.settings.temperature}). History kept; /clear to reset.`,
      );
    },
  },
  {
    name: "thinking",
    description: "toggle model thinking mode: /thinking [on|off]",
    run: async (ctx, args) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        ctx.settings.enableThinking = arg === "on";
      } else if (arg === "" || arg === "toggle") {
        ctx.settings.enableThinking = !ctx.settings.enableThinking;
      } else if (arg !== "status") {
        return note(ctx, "usage: /thinking [on|off|status]");
      }
      note(
        ctx,
        `thinking is ${ctx.settings.enableThinking ? "ON — model reasons before answering (slower, dimmed reasoning shown)" : "OFF"}`,
      );
    },
  },
  {
    name: "agents",
    description: "list agents; /agents edit|delete <name>",
    run: async (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const agents = loadAgents(ctx.cwd);
      if (parts[0] === "edit" && parts[1]) {
        const def = agents.find((a) => a.name === parts[1]);
        if (!def) return note(ctx, `no agent named ${parts[1]}`);
        openInEditor(def.filePath, ctx.settings.editor);
        return note(ctx, `edited ${def.filePath}`);
      }
      if (parts[0] === "delete" && parts[1]) {
        return note(ctx, deleteAgentDef(ctx.cwd, parts[1]) ? `deleted agent ${parts[1]}` : `no agent named ${parts[1]}`);
      }
      if (agents.length === 0) {
        return note(ctx, 'no agents yet. Ask for one: "create an agent that checks for spelling mistakes"');
      }
      note(ctx, agents.map((a) => `${a.name} [${a.scope}] — ${a.description}`).join("\n"));
    },
  },
  {
    name: "thinkingchain",
    description: "step pipelines: run|use|off|new|edit|delete|steps (alias /tc)",
    run: async (ctx, args) => runThinkingChain(ctx, args),
  },
  {
    name: "tc",
    description: "alias for /thinkingchain",
    run: async (ctx, args) => runThinkingChain(ctx, args),
  },
  {
    name: "skills",
    description: "list skills (SKILL.md, Claude Code compatible)",
    run: async (ctx) => {
      const skills = loadSkills(ctx.cwd);
      if (skills.length === 0) {
        return note(
          ctx,
          "no skills found. Searched: .grayskull/skills, ~/.config/grayskull/skills, .claude/skills, ~/.claude/skills — each skill is a <name>/SKILL.md with frontmatter. Invoke with /<name>.",
        );
      }
      note(ctx, skills.map((s) => `/${s.name} [${s.source}] — ${s.description}`).join("\n"));
    },
  },
  {
    name: "resume",
    description: "load a past session (picked with fzf)",
    run: async (ctx) => {
      const past = ctx.store.listPast();
      if (past.length === 0) return note(ctx, "no past sessions for this project");
      const picked = pickChoice(past, "session");
      if (!picked) return;
      ctx.agent.history = Store.load(picked);
      note(ctx, `resumed ${picked} (${ctx.agent.history.length} messages)`);
    },
  },
  {
    name: "clear",
    description: "clear conversation and screen",
    run: async (ctx) => {
      ctx.agent.history = [];
      ctx.clearTranscript();
    },
  },
  {
    name: "init",
    description: "explore the project and seed project memory",
    run: async () => ({
      prompt:
        "Explore this project: list the top-level files, read the README and main config/manifest files, identify the language, build/run/test commands, and overall structure. Then ask me 2-3 questions about anything important you cannot infer (purpose, conventions, current goals). Summarize your findings at the end — they will be saved to project memory automatically.",
    }),
  },
  {
    name: "exit",
    description: "quit (also /quit, /bye)",
    run: async (ctx) => ctx.exit(),
  },
  {
    name: "quit",
    description: "alias for /exit",
    run: async (ctx) => ctx.exit(),
  },
  {
    name: "bye",
    description: "alias for /exit",
    run: async (ctx) => ctx.exit(),
  },
];

async function runThinkingChain(ctx: CommandContext, args: string): Promise<CommandResult> {
  const m = args.trim().match(/^(\S*)\s*([\s\S]*)$/);
  const sub = m?.[1] ?? "";
  let rest = m?.[2] ?? "";

  const listChains = () => {
    const chains = loadChains();
    if (chains.length === 0) return note(ctx, "no chains. Create one: /tc new <name> step1 -> step2 -> …");
    const lines = chains.map((c) => {
      const steps = c.steps.map((s) => (isGate(s) ? `⛩${s}` : s)).join(" → ");
      return `${c.name} [${c.context}]${c.description ? ` — ${c.description}` : ""}\n  ${steps}`;
    });
    const sticky = chainState.sticky
      ? `\nactive: ${chainState.sticky.def.name} (${chainState.sticky.mode}) — /tc off to deactivate`
      : "";
    note(ctx, lines.join("\n") + sticky + "\n\n⛩ = review gate (can send the chain back a step)");
  };

  // mode flag can appear anywhere in the remainder
  let modeOverride: ChainContextMode | undefined;
  rest = rest
    .replace(/\s?--(fresh|shared)\b/g, (_, m1: string) => {
      modeOverride = m1 as ChainContextMode;
      return "";
    })
    .trim();

  const findChain = (name: string): ChainDef | undefined => {
    const def = loadChains().find((c) => c.name === name);
    if (!def) note(ctx, `no chain named "${name}" — /tc lists chains`);
    return def;
  };

  switch (sub) {
    case "":
    case "list":
      return listChains();
    case "steps": {
      const seen = new Set<string>();
      const lines = Object.entries(BUILTIN_STEPS)
        .filter(([, v]) => (seen.has(v) ? false : (seen.add(v), true)))
        .map(([k, v]) => `${k}${isGate(k) ? " ⛩" : ""} — ${v.slice(0, 90)}…`);
      return note(ctx, `built-in steps (anything else is used verbatim):\n${lines.join("\n")}`);
    }
    case "new": {
      const nm = rest.match(/^(\S+)\s+([\s\S]+)$/);
      if (!nm) return note(ctx, "usage: /tc new <name> step1 -> step2 -> …");
      const steps = parseChainBody(nm[2]!);
      if (steps.length === 0) return note(ctx, "no steps found — separate steps with ->");
      const path = saveChain({ name: nm[1]!, steps, context: modeOverride ?? "shared" });
      return note(ctx, `chain "${nm[1]}" saved to ${path}:\n${steps.join(" → ")}`);
    }
    case "edit": {
      const def = findChain(rest);
      if (!def) return;
      openInEditor(def.filePath, ctx.settings.editor);
      return note(ctx, `edited ${def.filePath}`);
    }
    case "delete":
      return note(ctx, deleteChain(rest) ? `deleted chain ${rest}` : `no chain named ${rest}`);
    case "off":
      chainState.sticky = null;
      return note(ctx, "chain deactivated — prompts run normally again");
    case "use": {
      const def = findChain(rest.split(/\s+/)[0] ?? "");
      if (!def) return;
      return { chain: { def, mode: modeOverride ?? def.context } };
    }
    case "run": {
      const rm = rest.match(/^(\S+)\s+([\s\S]+)$/);
      if (!rm) return note(ctx, "usage: /tc run <name> [--fresh|--shared] <task>");
      const def = findChain(rm[1]!);
      if (!def) return;
      return { chain: { def, mode: modeOverride ?? def.context, task: rm[2]! } };
    }
    default: {
      // shorthand: /tc <name> <task> == /tc run <name> <task>
      const def = loadChains().find((c) => c.name === sub);
      if (def && rest) return { chain: { def, mode: modeOverride ?? def.context, task: rest } };
      return note(ctx, "usage: /tc [list|steps|new|edit|delete|run|use|off] — /tc <name> <task> runs directly");
    }
  }
}

export async function runSlashCommand(
  ctx: CommandContext,
  input: string,
): Promise<CommandResult | "unknown"> {
  const m = input.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return "unknown";
  const cmd = COMMANDS.find((c) => c.name === m[1]);
  if (cmd) return cmd.run(ctx, m[2] ?? "");
  // /name falls through to a skill of that name (Claude Code style)
  const skill = loadSkills(ctx.cwd).find((s) => s.name === m[1]);
  if (skill) return { prompt: skillInvocation(skill, m[2] ?? "") };
  return "unknown";
}
