# GRAYSKULL — Claude Code-style CLI agent for local models (multi-model)

TypeScript + Ink 7 + Bun. Default endpoint is the Spark box (key from
`$LMSTUDIO_API_KEY`), which runs THREE resident vLLM systemd services concurrently:
`:8000` Qwen3.6-35B-A3B-NVFP4 (main; MTP spec decode, `--tool-call-parser qwen3_xml
--reasoning-parser qwen3 --max-model-len 262144`, reasoning_content empty on this
build), `:8001` Llama-3.1-8B NVFP4 (`llama3_json`), `:8002` Nemotron-Nano-9B
(`qwen3_xml`, 8k ctx). `/model` switches presets instantly; heavy solo recipes
(qwen35 122B-heretic, glm GLM-4.5-Air) replace the trio when launched. Defaults
follow the Qwen non-thinking coding preset: temp 0.7, topP 0.8, topK 20;
`enableThinking` off, toggled via `chat_template_kwargs`. Reasoning deltas
(`reasoning_content`) stream separately — rendered dimmed, never scanned for
tool calls.

## Commands

- run: `bun run src/index.tsx` (bun is at `~/.bun/bin`, may not be on PATH)
- headless one-shot: `bun run src/index.tsx -p "<prompt>" [--mode kamikazeee] [--add-dir <d>]`
  — final answer on stdout, tool/progress lines on stderr, permission asks
  auto-denied (index.tsx `runHeadless`; CliLink skipped, MCP awaited ≤20s)
- typecheck: `bunx tsc --noEmit`
- build binary: `bun run build` → `dist/grayskull`

## Architecture (src/)

- `agent/loop.ts` — `runToolLoop` (shared by main agent + sub-agents) and `GrayskullAgent`
  (turn lifecycle: global-memory trigger → compaction check → tool loop → post-turn
  memory extraction). UI talks to it via the mutable `UiBridge` object filled in by App.
- `agent/repair.ts` — weak-model accommodations: zod-validated tool args with retry
  messages, recovery of tool calls emitted as plain text/`<tool_call>` blocks.
- live steering: `/inject` → `GrayskullAgent.inject()` queues text; `runToolLoop` drains
  it via `opts.drainInjections` at each iteration top (after maybeCompact) and appends it
  as a user message before the next request. `agent.isActive()` lets `/inject` fall back
  to a normal prompt when idle. Plain mid-run input still queues (UI `queueRef`).
- `agent/compact.ts` — context-full handling at `compactThreshold`. `compactStrategy`:
  `memory-swap` (default) writes a task-continuation handoff brief via `memorySwap`,
  fully clears history, reseeds with the brief (model resumes from brief + injected
  memory); `summarize` is classic `compact` (summary + keep-recent). Fires at turn start
  (`runTurn`, on `this.history`) AND mid-turn: `runToolLoop` calls `opts.maybeCompact`
  before each request → `GrayskullAgent.compactInLoop` splices `messages` in place
  (keeps the system message, swaps the conversation tail) so a long single turn frees
  its own window.
- `agent/visual.ts` — visual-verify gate: visual turn (prompt image or rendering
  vocabulary en/de) + edits + no `mcp__playwright__*` call after the last edit →
  `runToolLoop`'s `beforeFinal` hook blocks the turn-ending reply once and injects
  a render+instrument+assert procedure (window.__game debug hook, browser_evaluate
  invariants, screenshot). Config `visualVerify.enabled`; `canvastest` skill
  (examples/skills/) is the deep playbook. Born from the pacman5 postmortem.
- `agent/plan.ts` — plan-first gate: substantial turn (creation/restructure
  vocabulary en/de) → `runToolLoop`'s `beforeEdit` hook refuses the first code edit
  (once) until a blueprint exists in `.grayskull/plans/`, injecting the
  research→blueprint→review procedure; proactive systemHint + triage/blueprint
  workflow in DEFAULT_SYSTEM_PROMPT (TRIVIAL vs SUBSTANTIAL, 5 phases:
  research/blueprint/review/execute/verify). Chain steps exempt (chainStepActive,
  runIsolated disarms). Config `planFirst.enabled`.
- `agent/expand.ts` — prompt-expand pre-pass (step 1 of two, before the plan
  gate's blueprint): when the plan gate is armed (`plan.isActive()`),
  `GrayskullAgent.runTurn` runs `expandPrompt` (one `client.oneShot`, background-
  safe → "" on failure) to rewrite the terse request into a Goal / Constraints /
  Task-breakdown spec where each sub-task is assigned `→ owner: <persona>` from the
  enabled-agent roster. The brief is shown to the user, persisted to
  `.grayskull/plans/<slug>.brief.md`, and prepended to the turn (original text kept
  below) so planning + auto-match see it. Config `promptExpand.enabled`.
- `agent/hooks.ts` — user lifecycle hooks (`hooks` array in settings.json, Claude
  Code conventions): PreToolUse / PostToolUse / Stop / UserPromptSubmit shell
  commands, JSON payload on stdin, `matcher` globs the tool name, exit code 2
  BLOCKS (stderr → message the model sees), stdout of non-blocking hooks is
  appended as context. Wired in `runToolLoop` (pre blocks before the permission
  prompt; post appends to the tool result; Stop can refuse the turn end, capped
  at 2 per turn) and `runTurn` (prompt-submit). Broken hooks degrade silently.
- `agent/checkpoints.ts` — /rewind insurance: `runToolLoop` snapshots each file
  before an edit-kind tool touches it → `.grayskull/checkpoints/<seq>/`
  (one checkpoint per turn: manifest.json + `N.snap`, pruned to
  `checkpoints.keep`). `/rewind` lists turns, `/rewind N` restores pre-turn
  contents (turn-created files deleted). bash/MCP side effects not covered.
- `agent/diagnostics.ts` — post-edit compiler feedback: auto-detected project check
  (typecheck script/tsc/cargo/go vet/ruff, cached 60s) runs after every edit-kind tool
  in `runToolLoop`; failures are appended to the tool result. Config: `diagnostics`
  key in settings. MCP extras: `if` marker-file gating + `${cwd}` arg substitution in
  `mcp/manager.ts`; built-ins lsp-ts/lsp-go (isaacphi/mcp-language-server, installed
  at ~/go/bin) and context7 in `config/settings.ts`.
- `tools/` — built-ins (bash/bash_output/read/write/edit/grep/glob/ask_user/todo);
  `ToolRegistry.schemas()` converts zod → JSON Schema via `z.toJSONSchema` (zod 4).
  MCP tools carry raw `jsonSchema`. bash `background=true` runs detached (dev
  servers/watchers): returns a job id immediately, output buffered 200KB in
  tools/bash.ts module state; `bash_output(id)` reads deltas, `kill=true` kills
  the process group, no id lists jobs.
- `perms/engine.ts` — modes: normal / accept-edits / plan / kamikazeee (shift+tab cycle);
  Claude Code-style patterns `bash(git *)`.
- `memory/memory.ts` — global vault `~/.config/grayskull/GRAYSKULL.md` (explicit
  "always remember" trigger or `/remember` only) + per-project `.grayskull/memory.md`
  (auto-extracted after every turn via `client.oneShot`, fire-and-forget).
- `memory/scores.ts` — ACT-R-style activation scoring for project memory: exponential
  decay (half-life), reinforcement of bullets "fired" by a turn (lexical containment),
  spreading activation to similar neighbors, prune-to-archive + revival. Sidecar
  `.grayskull/memory-scores.json` keyed by bullet-text hash; memory.md stays the
  source of truth. Pure code, no LLM; global vault exempt.
- `mcp/manager.ts` — official MCP SDK; searxng (`npx -y mcp-searxng`, SEARXNG_URL
  :8080) is a built-in always-on default merged in `config/settings.ts`.
- `agents/` — personas as frontmatter-md in `.grayskull/agents/` + global dir
  (fields: `tools`, `skills` always-loaded, `triggers` match-only keywords);
  `create_agent` / `spawn_agent` tools (semaphore-capped, depth 1; spawn refuses
  disabled personas + unions `def.skills` into the sub-agent). Built-ins
  (registry.ts BUILTIN_AGENTS, shadowable/disable-able): read-only `explorer` /
  `reviewer` / `security-auditor`, plus specialist personas `architect`,
  `frontend-engineer`, `backend-engineer`, `test-engineer`, `docs-writer`.
  **Enable/disable** lives in `settings.disabledAgents` (single source of truth so
  built-ins toggle too; `saveGlobal` persists it) — disabled personas are hidden
  from the catalog (`agentListing`), auto-trigger, and spawn. **Auto-trigger**:
  `autoMatchAgents` (mirror of skills' `autoMatchSkills`, reuses `tokenize` +
  `fuzzyTokenMatch`) scores enabled personas by name-part / trigger-keyword /
  description overlap against the turn text; `GrayskullAgent.autoAgents` emits
  `⚔ persona matched` notes and `agentDirectiveBlock` injects a "delegate this
  slice to X" block after `# Available sub-agents` in `buildSystemMessage`. CRUD:
  TUI `/agents [new|edit|enable|disable|delete] <name>` (new/edit open `$EDITOR`,
  `TERMINAL_ONLY` in web); web Agents roster in the MESH panel (`+ AGENT`, per-row
  toggle/✎/✕) → `agents_open`/`agent_save`/`agent_toggle`/`agent_delete` WS msgs →
  `WebSession` methods. See `agent/expand.ts` for the expand→plan pre-pass that
  assigns these personas up front.
- `skills/` — Claude Code-compatible SKILL.md discovery (incl. ~/.claude/skills and the
  plugin cache); exposed as the `skill` tool + `/<name>` slash fallback. Frontmatter
  parser handles YAML block scalars (`description: >`). `skills/hub.ts` — remote skill
  databases: GitHub repos of `<dir>/SKILL.md` skills, one tree-API request per repo
  cached 24h (`~/.config/grayskull/skill-repos/`), bodies via raw.githubusercontent
  (optional `GITHUB_TOKEN`). Five built-in sources (anthropic, superpowers, daymade,
  tech-leads-club, antigravity ≈6k skills); `skillRepos` setting adds/overrides/disables
  by name (merged in loadSettings like BUILTIN_MCP). `/skills browse [q]` opens the
  search-box browser (TUI `ui/skillhub.tsx`, web `skills_*` WS messages + modal);
  `find`/`install <source>/<name> [global]` work headless; `/skills new <name>
  [global] [desc]` scaffolds into `.grayskull/skills/` (desc → returned prompt makes
  the agent draft the SKILL.md body).
- `chains/` — /thinkingchain step pipelines: registry.ts (global `~/.config/grayskull/chains/*.md`,
  `->` syntax, built-in step expansion table, gate detection via `review|test|verify`,
  per-step preset binding `stepPresetName`/`resolveStepProfile` + `profiles:` frontmatter
  override), runner.ts (sequential execution, VERDICT PASS/FAIL gates with jump-back,
  shared vs fresh context modes; applies each step's InferenceProfile via
  `agent.setInferenceProfile` in a try/finally; `chainState` feeds the statusline).
- `llm/profiles.ts` — model families as DATA: leak dialect, vLLM parser flags
  (doc only), `codegen`/`reason` inference presets (thinking + sampling).
  Built-ins `qwen3.5`/`glm4.5` are seeds; `settings.families` adds/overrides
  families (zod `FamilyProfileSchema`), installed via `registerFamilies` from
  `loadSettings`/`registerCustomFamilies` — `modelFamily` and preset `family`
  are free strings, unknown names fall back to qwen3.5. Managed via `/families`
  (add/remove, clones the active family) and per-family /setup groups
  (`FAMILY_SPEC`, dotted keys, saved whole like `models`). The registry is
  process-global: in grayskull-web the most recently loaded session's
  `families` wins on same-name collisions across projects.
  `LlmClient.setInferenceProfile()` applies a transient per-request override
  (temp/topP/topK/minP/enableThinking) over settings; `oneShot` never inherits it.
  GLM handoff: `glm-server-notes.md`. `repair.ts` recoverTextToolCall takes the
  dialect: `qwen` (JSON) or `glm` (XML `<tool_call>name<arg_key>/<arg_value>`).
- `llm/modelsdev.ts` — models.dev metadata import: full dump cached 24h at
  `~/.config/grayskull/models-dev.json`; `/model import <query>` searches
  (exact `provider/id` or substring, tool-callers ranked first) and seeds a
  /model preset (contextWindow, maxTokens capped at DEFAULT_MAX_TOKENS; endpoint
  stays the active baseURL — models.dev knows models, not your server).
- `config/settings.ts` — zod schema, precedence: defaults < global < local settings.json.
  Seeded global settings include the playwright MCP server (headless Chrome, 23 tools);
  the `webtest` skill (examples/skills/, installed at ~/.config/grayskull/skills/)
  holds the text-only rendering-test playbook (console → snapshot → layout assertions
  via browser_evaluate → screenshots for the human).
- `ui/App.tsx` — single-file Ink UI (transcript, custom input, permission/ask prompts,
  statusline). `ui/external.ts` suspends raw mode for $EDITOR and fzf. `ui/setup.tsx` —
  /setup Ink dialog; the UI-agnostic logic lives in `setup/core.ts` and is
  schema-driven: `PRESET_SPEC`/`ACTIVE_SPEC`/`FAMILY_SPEC`/`CONF_SPEC` field
  tables (kind text/number/enum/toggle; dotted keys reach nested objects;
  enum options may be a function, resolved at render) define the whole
  configuration — extend there and TUI + web modal + persistence pick it up.
  listGroups (active + per-preset + per-family + BEHAVIOR + websearch groups),
  applyField (typed coercion, live via `client.reconfigure`/`mcp.reconnect`;
  `conf.*` edits are zod-revalidated and rolled back if out of bounds),
  addPreset/removePreset (models record saved whole so deleted seeded defaults
  stay gone; removable handle `family:<name>` routes to removeFamily),
  addFamily/removeFamily, saveGlobal (patches raw global settings.json),
  checkServices (searxng probed over HTTP, lsp binaries, playwright config +
  fix instructions). Web modal: ⚙ cog chip in the header (or /setup) opens a
  TABBED settings dialog — ACTIVE MODEL / LLM PRESETS (with + ADD LLM and a
  models.dev search+import panel) / FAMILIES (+ ADD FAMILY) / BEHAVIOR /
  SERVICES; session.ts setup* + modelsdev* methods, `setup_*`,
  `setup_family_add`, `modelsdev_search`, `modelsdev_import` WS messages.
  Opened through `CommandContext.openSetup` (set by both TUI App and WebSession).
- `web/` — grayskull-web (0.0.0.0:4242): `server.ts` Bun.serve + WS, ui.html embedded
  via `with {type:"text"}`. `auth.ts` — login for exposed interfaces: argon2id
  password (`grayskull-web --set-password`, hash in settings `web.passwordHash`;
  none = auth off + startup warning), HMAC-signed expiry cookie (secret at
  ~/.config/grayskull/web-secret, survives restarts), per-IP login rate limit,
  /logout (also in the ⌘K palette). Gated: everything incl. /ws upgrade except
  /login, PWA manifest/icons, and /cli (loopback-only — keep it unproxied
  behind a same-host reverse proxy). Login page = CSS 3D cube: flies in with
  GRAYSKULL on the front, flips to the form on its back (failed attempt skips
  the intro and shakes; reduced-motion gets the form directly).
  `session.ts` WebSession wraps GrayskullAgent with a WS
  bridge (per-session registry/MCP/memory/perms, transcript replay, pending perm/ask
  maps). Agent-mesh events come from the `monitor` callback in `agents/runner.ts`.
  Frontend is one self-contained ui.html (vanilla JS, matrix rain, SVG node graph).
  `term.ts`: per-session PTY shells (Bun.spawn `terminal` option, native — NOT
  node-pty, which EOFs interactive shells under Bun); spawned lazily in the
  session cwd on `term_open`, streamed as `term_out` broadcasts, 200KB replay
  buffer; frontend is xterm.js embedded from node_modules (`/xterm.js` etc.),
  drawer above the input bar, ctrl+` toggles, esc inside stays in the shell.
  `clilink.ts`: the TUI dials ws://127.0.0.1:4242/cli (10s silent retry), registers
  with a transcript snapshot, mirrors all bridge events and accepts remote commands
  (prompt/mode/interrupt/answer); the server's /cli endpoint stores CliSession state
  and routes browser commands by sid. Perm/ask prompts carry reqIds; perm_done/
  ask_done broadcasts close the losing UI's dialog.

## Conventions

- Bun runtime: `bun <file>`, `bun install`, `bunx`; Bun.Glob in glob tool.
- Plain functions + small classes, no DI framework; services wired once in `index.tsx`.
- Background model calls (memory, compaction) must never throw into the session —
  wrap in try/catch and degrade silently.
- tsconfig is strict with `noUncheckedIndexedAccess`; keep `bunx tsc --noEmit` clean.
