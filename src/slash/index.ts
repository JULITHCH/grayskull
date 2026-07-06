import type { PermissionMode, TranscriptItem } from "../types";
import type { Settings } from "../config/settings";
import type { GrayskullAgent } from "../agent/loop";
import type { MemoryManager } from "../memory/memory";
import { loadGlobalMemory, loadLocalMemory, saveLocalMemory } from "../memory/memory";
import { ScoreStore, bulletHash, archivePath } from "../memory/scores";
import { readFileSync, statSync } from "node:fs";
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
  searchHub,
  fetchSkillDetail,
  installSkill,
  createSkill,
  type InstallScope,
} from "../skills/hub";
import {
  loadChains,
  saveChain,
  deleteChain,
  parseChainBody,
  isGate,
  stepGate,
  BUILTIN_STEPS,
  type ChainDef,
  type ChainContextMode,
} from "../chains/registry";
import { chainState } from "../chains/runner";
import { loadWorker, deleteWorker, saveWorkerConfig, missingConfig, workerListing } from "../workers/registry";
import { addFamily, removeFamily, saveGlobal } from "../setup/core";
import { familyNames, modelProfile } from "../llm/profiles";
import { searchModelsDev, presetFromEntry } from "../llm/modelsdev";
import { activeScheduler, setJobEnabled, removeJob, jobListing, JOB_LOG_DIR } from "../scheduler/scheduler";
import { join } from "node:path";
import { openInEditor } from "../ui/external";
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
  /** open the /setup dialog (Ink dialog in the TUI, modal in web sessions) */
  openSetup?: () => void;
  /** open the remote skill browser (/skills browse), optionally pre-filled */
  openSkillsBrowser?: (query?: string) => void;
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
    name: "setup",
    description: "setup dialog: endpoints + LLM presets, check searxng/context7/lsp/playwright",
    run: async (ctx) => {
      if (!ctx.openSetup) {
        return note(ctx, "/setup needs an interactive UI — run it in the terminal or the web UI");
      }
      ctx.openSetup();
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
    name: "inject",
    description: "steer the running task live: /inject <message>",
    run: async (ctx, args) => {
      const text = args.trim();
      if (!text) return note(ctx, "usage: /inject <message> — steers the task the model is currently working on");
      if (ctx.agent.isActive()) {
        ctx.agent.inject(text);
        return note(ctx, "↪ steering injected — the model will see it at its next step");
      }
      // nothing running to steer → just send it as a normal prompt
      return { prompt: text };
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
    name: "families",
    description: "model families (data-driven): list; /families add|remove <name>",
    run: async (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "add" && parts[1]) {
        const name = addFamily(ctx.settings, parts[1]);
        if (!name) return note(ctx, `family name "${parts[1]}" empty or already taken`);
        saveGlobal(ctx.settings, new Set(["families"]));
        return note(ctx, `family "${name}" added (cloned from "${ctx.settings.modelFamily}") and saved — tune it in /setup`);
      }
      if (parts[0] === "remove" && parts[1]) {
        if (!removeFamily(ctx.settings, parts[1])) {
          return note(ctx, `no custom family "${parts[1]}" (built-ins cannot be removed)`);
        }
        saveGlobal(ctx.settings, new Set(["families"]));
        return note(ctx, `family "${parts[1]}" removed and saved`);
      }
      const lines = familyNames().map((n) => {
        const p = modelProfile(n);
        const custom = n in ctx.settings.families;
        const active = n === ctx.settings.modelFamily;
        return `${active ? "●" : "○"} ${n} [${custom ? "custom" : "built-in"}] — dialect ${p.leakDialect}, parsers ${p.toolCallParser || "-"}/${p.reasoningParser || "-"}, codegen temp ${p.presets.codegen.temperature}, reason temp ${p.presets.reason.temperature}`;
      });
      note(ctx, `${lines.join("\n")}\n\n/families add <name> clones the active family; edit fields in /setup; built-ins are overridden by a custom family with the same name`);
    },
  },
  {
    name: "model",
    description: "switch stack live: /model [name]; /model import <models.dev query>",
    run: async (ctx, args) => {
      const presets = ctx.settings.models;
      const names = Object.keys(presets);
      const want = args.trim();
      const imp = want.match(/^import\s+(.+)$/);
      if (imp) {
        note(ctx, "⌕ querying models.dev…");
        let hits;
        try {
          hits = await searchModelsDev(imp[1]!);
        } catch (err) {
          return note(ctx, `models.dev lookup failed: ${(err as Error).message}`);
        }
        if (hits.length === 0) return note(ctx, `models.dev: nothing matches "${imp[1]}"`);
        if (hits.length > 1) {
          const lines = hits.map(
            (h) =>
              `  ${h.ref} — ctx ${h.context ? Math.round(h.context / 1024) + "k" : "?"}, out ${h.output || "?"}${h.toolCall ? ", tools" : ""}${h.reasoning ? ", reasoning" : ""}${h.vision ? ", vision" : ""}${h.openWeights ? ", open" : ""}`,
          );
          return note(ctx, `models.dev matches — import one with /model import <provider/id>:\n${lines.join("\n")}`);
        }
        const entry = hits[0]!;
        const preset = presetFromEntry(entry, ctx.settings);
        const presetName = entry.id.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
        ctx.settings.models[presetName] = preset;
        saveGlobal(ctx.settings, new Set(["models"]));
        return note(
          ctx,
          `⚡ imported "${presetName}" from models.dev (${entry.name}): family ${preset.family}, ctx ${preset.contextWindow ?? "?"}, maxTokens ${preset.maxTokens ?? "default"} — endpoint kept at ${preset.baseURL}; adjust in /setup, switch with /model ${presetName}`,
        );
      }
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
    name: "legendarymode",
    description: "toggle legendary persona (high-agency, no grovelling): /legendarymode [on|off]",
    run: async (ctx, args) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") ctx.agent.legendary = true;
      else if (arg === "off") ctx.agent.legendary = false;
      else if (arg === "" || arg === "toggle") ctx.agent.legendary = !ctx.agent.legendary;
      else if (arg !== "status") return note(ctx, "usage: /legendarymode [on|off|status]");
      note(
        ctx,
        ctx.agent.legendary
          ? "★ LEGENDARY MODE engaged — persona layered on top of the operational prompt. Edit it at ~/.config/grayskull/legendarymode.md"
          : "legendary mode off",
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
        if (def.scope === "builtin") {
          return note(ctx, `${def.name} is built-in — create a local agent with the same name to override it`);
        }
        openInEditor(def.filePath, ctx.settings.editor);
        return note(ctx, `edited ${def.filePath}`);
      }
      if (parts[0] === "delete" && parts[1]) {
        const def = agents.find((a) => a.name === parts[1]);
        if (def?.scope === "builtin") {
          return note(ctx, `${def.name} is built-in and cannot be deleted`);
        }
        return note(ctx, deleteAgentDef(ctx.cwd, parts[1]) ? `deleted agent ${parts[1]}` : `no agent named ${parts[1]}`);
      }
      if (agents.length === 0) {
        return note(ctx, 'no agents yet. Ask for one: "create an agent that checks for spelling mistakes"');
      }
      note(ctx, agents.map((a) => `${a.name} [${a.scope}] — ${a.description}`).join("\n"));
    },
  },
  {
    name: "workers",
    description: "list workers; /workers config <name> key=value … | edit|delete <name>",
    run: async (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "config" && parts[1]) {
        const def = loadWorker(parts[1]);
        if (!def) return note(ctx, `no worker named ${parts[1]}`);
        const values: Record<string, string> = {};
        for (const kv of parts.slice(2)) {
          const m = kv.match(/^([\w-]+)=(.*)$/);
          if (m) values[m[1]!] = m[2]!;
        }
        if (!Object.keys(values).length) {
          const missing = missingConfig(def);
          return note(ctx, `usage: /workers config ${def.name} key=value …\nfields: ${def.fields.map((f) => `${f.key} — ${f.description}`).join("\n        ")}\nmissing: ${missing.map((f) => f.key).join(", ") || "(none)"}`);
        }
        saveWorkerConfig(def.name, values);
        const missing = missingConfig(def);
        return note(ctx, missing.length ? `saved — still missing: ${missing.map((f) => f.key).join(", ")}` : `saved — ${def.name} fully configured`);
      }
      if (parts[0] === "edit" && parts[1]) {
        const def = loadWorker(parts[1]);
        if (!def) return note(ctx, `no worker named ${parts[1]}`);
        openInEditor(def.filePath, ctx.settings.editor);
        return note(ctx, `edited ${def.filePath}`);
      }
      if (parts[0] === "delete" && parts[1]) {
        return note(ctx, deleteWorker(parts[1]) ? `deleted worker ${parts[1]} (incl. config)` : `no worker named ${parts[1]}`);
      }
      const listing = workerListing();
      note(ctx, listing || 'no workers yet. Ask for one: "erstelle einen worker der auf LinkedIn posten kann"');
    },
  },
  {
    name: "jobs",
    description: "scheduled jobs: list; /jobs run|on|off|delete <name> | log <name>",
    run: async (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const name = parts[1];
      if (parts[0] === "run" && name) {
        const sched = activeScheduler();
        if (!sched) return note(ctx, "the scheduler runs inside grayskull-web — start it (or use run_worker here)");
        note(ctx, `⚙ running job ${name}…`);
        const summary = await sched.runJob(name);
        return note(ctx, summary.slice(0, 1500));
      }
      if ((parts[0] === "on" || parts[0] === "off") && name) {
        return note(ctx, setJobEnabled(name, parts[0] === "on") ? `job ${name} ${parts[0] === "on" ? "enabled" : "disabled"}` : `no job named ${name}`);
      }
      if (parts[0] === "delete" && name) {
        return note(ctx, removeJob(name) ? `deleted job ${name}` : `no job named ${name}`);
      }
      if (parts[0] === "log" && name) {
        const path = join(JOB_LOG_DIR, `${name}.log`);
        if (!existsSync(path)) return note(ctx, `no log for job ${name} yet`);
        const lines = readFileSync(path, "utf8").trim().split("\n");
        return note(ctx, lines.slice(-30).join("\n"));
      }
      const listing = jobListing();
      note(ctx, listing
        ? `${listing}\n\njobs run inside grayskull-web · /jobs run|on|off|delete|log <name>`
        : 'no jobs yet. Ask for one: "poste jeden montag um 9 einen artikel über X auf linkedin"');
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
    description: "skills: list · browse/find <query> (remote hub) · install <source>/<name> · new <name> · repos",
    run: async (ctx, args) => runSkillsCommand(ctx, args),
  },
  {
    name: "resume",
    description: "list past sessions; /resume N loads one",
    run: async (ctx, args) => {
      const past = ctx.store.listPast(); // newest first
      if (past.length === 0) return note(ctx, "no past sessions for this project");
      const n = Number.parseInt(args.trim(), 10);
      if (args.trim() && Number.isInteger(n) && past[n - 1]) {
        const msgs = Store.load(past[n - 1]!);
        ctx.agent.history = msgs;
        return note(ctx, `resumed session ${n} (${msgs.length} messages)`);
      }
      if (args.trim()) return note(ctx, `no session ${args.trim()} — /resume to list`);
      // numbered list works in the browser, over the hub, and in the terminal
      // (no fzf / tty needed)
      const list = past
        .slice(0, 15)
        .map((p, i) => {
          const name = p.split("/").pop()!.replace(/\.jsonl$/, "");
          let kb = 0;
          try {
            kb = Math.max(1, Math.round(statSync(p).size / 1024));
          } catch {
            // unreadable — show without size
          }
          return `  ${i + 1}. ${name}  (${kb} KB)`;
        })
        .join("\n");
      note(ctx, `past sessions — type /resume N to load:\n${list}`);
    },
  },
  {
    name: "rewind",
    description: "undo a turn's file edits: /rewind lists, /rewind N restores",
    run: async (ctx, args) => {
      const cps = ctx.agent.checkpoints.list(); // newest first
      if (cps.length === 0) return note(ctx, "no checkpoints yet — one is taken automatically before each turn's first file edit");
      const want = args.trim();
      if (want) {
        const idx = want === "last" ? 1 : Number.parseInt(want, 10);
        const cp = cps[idx - 1];
        if (!cp) return note(ctx, `no checkpoint ${want} — /rewind to list`);
        const report = ctx.agent.checkpoints.restore(cp.id);
        return note(ctx, `⏪ rewound "${cp.label}" (${cp.startedAt.slice(0, 19)}):\n${report.join("\n")}\n\nNote: only write/edit tool changes are restored — bash side effects are not.`);
      }
      const list = cps
        .slice(0, 10)
        .map((c, i) => `  ${i + 1}. [${c.startedAt.slice(5, 16).replace("T", " ")}] ${c.label} — ${c.files.length} file${c.files.length === 1 ? "" : "s"}`)
        .join("\n");
      note(ctx, `checkpoints (newest first) — /rewind N restores the files as they were BEFORE that turn:\n${list}`);
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

async function runSkillsCommand(ctx: CommandContext, args: string): Promise<CommandResult> {
  const m = args.trim().match(/^(\S*)\s*([\s\S]*)$/);
  const sub = m?.[1] ?? "";
  const rest = (m?.[2] ?? "").trim();
  const repos = ctx.settings.skillRepos;

  if (sub === "repos") {
    const lines = repos.map(
      (r) =>
        `  ${r.disabled ? "○" : "●"} ${r.name.padEnd(18)} ${r.repo}${r.subdir ? `  (${r.subdir})` : ""}`,
    );
    return note(
      ctx,
      `skill databases (settings key "skillRepos" — add {name, repo, subdir?} entries, same name overrides a built-in, disabled:true hides it):\n${lines.join("\n")}`,
    );
  }

  if (sub === "browse" || sub === "find" || sub === "search") {
    // browse prefers the interactive UI; find/search always print
    if (sub === "browse" && ctx.openSkillsBrowser) {
      ctx.openSkillsBrowser(rest || undefined);
      return;
    }
    const errors: string[] = [];
    const hits = await searchHub(repos, rest, 25, (repo, msg) => errors.push(`${repo}: ${msg}`));
    const errText = errors.length ? `\n⚠ ${errors.join("\n⚠ ")}` : "";
    if (hits.length === 0) return note(ctx, `no remote skills match "${rest}"${errText}`);
    const lines = hits.map((h) => `  ${h.name.padEnd(34)} [${h.source}]`);
    return note(
      ctx,
      `remote skills${rest ? ` matching "${rest}"` : ""} — install with /skills install <source>/<name> [global]:\n${lines.join("\n")}${errText}`,
    );
  }

  if (sub === "install") {
    const im = rest.match(/^(\S+?)\/(\S+?)(\s+(global|local))?$/);
    if (!im) return note(ctx, "usage: /skills install <source>/<name> [global] — sources via /skills repos");
    const [, source, name, , scopeArg] = im;
    const scope: InstallScope = scopeArg === "global" ? "global" : "local";
    const hits = await searchHub(repos.filter((r) => r.name === source), name!, 5);
    const hit = hits.find((h) => h.name === name) ?? hits[0];
    if (!hit) return note(ctx, `no skill "${name}" in source "${source}" — /skills find ${name} to search everywhere`);
    try {
      const detail = await fetchSkillDetail(hit, repos);
      const { dir, fileCount } = await installSkill(detail, scope, ctx.cwd);
      return note(
        ctx,
        `⚡ installed "${hit.name}" (${fileCount} file${fileCount === 1 ? "" : "s"}) → ${dir}\n${detail.description.slice(0, 300)}\nInvoke with /${hit.name} — active immediately.`,
      );
    } catch (err) {
      return note(ctx, `install failed: ${(err as Error).message}`);
    }
  }

  if (sub === "new") {
    const nm = rest.match(/^(\S+)\s*(global\s+)?([\s\S]*)$/);
    const name = nm?.[1] ?? "";
    if (!name) return note(ctx, "usage: /skills new <name> [global] [description of what it should do]");
    const scope: InstallScope = nm?.[2] ? "global" : "local";
    const description = (nm?.[3] ?? "").trim();
    let file: string;
    try {
      file = createSkill(name, description, scope, ctx.cwd);
    } catch (err) {
      return note(ctx, `create failed: ${(err as Error).message}`);
    }
    note(ctx, `⚡ scaffolded skill "${name}" → ${file}`);
    if (!description) {
      return note(ctx, `edit it with /settings-style editor or ask the model to draft it. Invoke with /${name}.`);
    }
    // let the agent draft the playbook body from the description
    return {
      prompt: `A new skill was scaffolded at ${file}. Its purpose: "${description}". Rewrite that file into a complete, high-quality SKILL.md: keep the YAML frontmatter (name: ${name}, plus a sharp one-line description of when to use it), then a concrete step-by-step playbook the agent follows when the skill is invoked. Be specific and actionable, no filler. Use the write/edit tool on exactly that path.`,
    };
  }

  // default: list installed skills
  const skills = loadSkills(ctx.cwd);
  const listing = skills.length
    ? skills.map((s) => `/${s.name} [${s.source}] — ${s.description}`).join("\n")
    : "no skills installed. Searched: .grayskull/skills, ~/.config/grayskull/skills, .claude/skills, ~/.claude/skills — each skill is a <name>/SKILL.md with frontmatter.";
  return note(
    ctx,
    `${listing}\n\n/skills browse [query] — search the skill databases · /skills new <name> [desc] — create your own · /skills repos — sources`,
  );
}

async function runThinkingChain(ctx: CommandContext, args: string): Promise<CommandResult> {
  const m = args.trim().match(/^(\S*)\s*([\s\S]*)$/);
  const sub = m?.[1] ?? "";
  let rest = m?.[2] ?? "";

  const listChains = () => {
    const chains = loadChains();
    if (chains.length === 0) return note(ctx, "no chains. Create one: /tc new <name> step1 -> step2 -> …");
    const lines = chains.map((c) => {
      const steps = c.steps.map((s) => (stepGate(s, c) ? `⛩${s}` : s)).join(" → ");
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
