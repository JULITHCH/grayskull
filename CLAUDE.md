# GRAYSKULL — Claude Code-style CLI agent for local vLLM

TypeScript + Ink 7 + Bun. Targets the Spark vLLM endpoint (`http://10.8.0.22:8000/v1`,
model `happypatrick/Qwen3.5-122B-A10B-heretic-int4-AutoRound`, key from `$LMSTUDIO_API_KEY`).
Server runs `--tool-call-parser qwen3_xml --reasoning-parser qwen3 --max-model-len 196608`
(spark-vllm-docker `qwen3.5-122b-heretic` recipe, --solo). Defaults follow the Qwen
non-thinking coding preset: temp 0.7, topP 0.8, topK 20; `enableThinking` off, toggled
via `chat_template_kwargs`. Reasoning deltas (`reasoning_content`) stream separately —
rendered dimmed, never scanned for tool calls.

## Commands

- run: `bun run src/index.tsx` (bun is at `~/.bun/bin`, may not be on PATH)
- typecheck: `bunx tsc --noEmit`
- build binary: `bun run build` → `dist/grayskull`

## Architecture (src/)

- `agent/loop.ts` — `runToolLoop` (shared by main agent + sub-agents) and `GrayskullAgent`
  (turn lifecycle: global-memory trigger → compaction check → tool loop → post-turn
  memory extraction). UI talks to it via the mutable `UiBridge` object filled in by App.
- `agent/repair.ts` — weak-model accommodations: zod-validated tool args with retry
  messages, recovery of tool calls emitted as plain text/`<tool_call>` blocks.
- `agent/compact.ts` — context-full handling at `compactThreshold`. `compactStrategy`:
  `memory-swap` (default) writes a task-continuation handoff brief via `memorySwap`,
  fully clears history, reseeds with the brief (model resumes from brief + injected
  memory); `summarize` is classic `compact` (summary + keep-recent). Fires at turn start
  (`runTurn`, on `this.history`) AND mid-turn: `runToolLoop` calls `opts.maybeCompact`
  before each request → `GrayskullAgent.compactInLoop` splices `messages` in place
  (keeps the system message, swaps the conversation tail) so a long single turn frees
  its own window.
- `agent/diagnostics.ts` — post-edit compiler feedback: auto-detected project check
  (typecheck script/tsc/cargo/go vet/ruff, cached 60s) runs after every edit-kind tool
  in `runToolLoop`; failures are appended to the tool result. Config: `diagnostics`
  key in settings. MCP extras: `if` marker-file gating + `${cwd}` arg substitution in
  `mcp/manager.ts`; built-ins lsp-ts/lsp-go (isaacphi/mcp-language-server, installed
  at ~/go/bin) and context7 in `config/settings.ts`.
- `tools/` — built-ins (bash/read/write/edit/grep/glob/ask_user/todo); `ToolRegistry.schemas()`
  converts zod → JSON Schema via `z.toJSONSchema` (zod 4). MCP tools carry raw `jsonSchema`.
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
- `agents/` — sub-agent defs as frontmatter-md in `.grayskull/agents/` + global dir;
  `create_agent` / `spawn_agent` tools (semaphore-capped, depth 1).
- `skills/` — Claude Code-compatible SKILL.md discovery (incl. ~/.claude/skills and the
  plugin cache); exposed as the `skill` tool + `/<name>` slash fallback. Frontmatter
  parser handles YAML block scalars (`description: >`).
- `chains/` — /thinkingchain step pipelines: registry.ts (global `~/.config/grayskull/chains/*.md`,
  `->` syntax, built-in step expansion table, gate detection via `review|test|verify`,
  per-step preset binding `stepPresetName`/`resolveStepProfile` + `profiles:` frontmatter
  override), runner.ts (sequential execution, VERDICT PASS/FAIL gates with jump-back,
  shared vs fresh context modes; applies each step's InferenceProfile via
  `agent.setInferenceProfile` in a try/finally; `chainState` feeds the statusline).
- `llm/profiles.ts` — model-family abstraction (`qwen3.5`/`glm4.5`): leak dialect,
  vLLM parser flags (doc only), and `codegen`/`reason` inference presets (thinking +
  sampling). `LlmClient.setInferenceProfile()` applies a transient per-request override
  (temp/topP/topK/minP/enableThinking) over settings; `oneShot` never inherits it.
  Selected by `settings.modelFamily` (default qwen3.5). GLM handoff: `glm-server-notes.md`.
  `repair.ts` recoverTextToolCall takes the dialect: `qwen` (JSON) or `glm` (XML
  `<tool_call>name<arg_key>/<arg_value>`).
- `config/settings.ts` — zod schema, precedence: defaults < global < local settings.json.
  Seeded global settings include the playwright MCP server (headless Chrome, 23 tools);
  the `webtest` skill (examples/skills/, installed at ~/.config/grayskull/skills/)
  holds the text-only rendering-test playbook (console → snapshot → layout assertions
  via browser_evaluate → screenshots for the human).
- `ui/App.tsx` — single-file Ink UI (transcript, custom input, permission/ask prompts,
  statusline). `ui/external.ts` suspends raw mode for $EDITOR and fzf.
- `web/` — grayskull-web (0.0.0.0:4242): `server.ts` Bun.serve + WS, ui.html embedded
  via `with {type:"text"}`; `session.ts` WebSession wraps GrayskullAgent with a WS
  bridge (per-session registry/MCP/memory/perms, transcript replay, pending perm/ask
  maps). Agent-mesh events come from the `monitor` callback in `agents/runner.ts`.
  Frontend is one self-contained ui.html (vanilla JS, matrix rain, SVG node graph).
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
