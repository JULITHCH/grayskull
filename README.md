# GRAYSKULL

**BY THE POWER OF GRAYSKULL** — a Claude Code-style terminal agent for a local vLLM
instance (`happypatrick/Qwen3.5-122B-A10B-heretic-int4-AutoRound` on a 128GB NVIDIA Spark).

The model is not frontier-smart, so the harness does extra lifting: persistent two-tier
memory, ask-back interviews, tool-call repair, mandatory web verification, sub-agent
fan-out, user-composable thinking chains, and aggressive context hygiene.

---

## Quick start

```sh
grayskull                  # launcher in ~/.local/bin — run it in any project directory
```

or manually:

```sh
export LMSTUDIO_API_KEY=whatever   # vLLM usually accepts anything
bun run src/index.tsx              # bun lives in ~/.bun/bin
```

Build a standalone binary (no bun needed at runtime): `bun run build` → `dist/grayskull`.

First useful thing to type: `/init` — it explores the project, asks you 2-3 questions,
and seeds the project memory.

### Recommended vLLM server flags (on the Spark)

```sh
vllm serve happypatrick/Qwen3.5-122B-A10B-heretic-int4-AutoRound \
  --enable-prefix-caching \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --reasoning-parser qwen3 \
  --chat-template unsloth.jinja \
  --max-model-len 196608
```

Canonical launch is the spark-vllm-docker `qwen3.5-122b-heretic` recipe (`--solo` mode),
which adds the infra flags: `--load-format fastsafetensors`,
`--gpu-memory-utilization 0.76`, `-tp 1`, `--max-num-batched-tokens 8192`,
`--trust-remote-code`.

`--enable-prefix-caching` matters: grayskull keeps the system prompt + memory as a stable
prefix, so every turn after the first reuses the KV cache. `--reasoning-parser qwen3`
splits think-blocks into a separate stream — grayskull renders them dimmed and never
parses tool calls out of them; thinking is off by default (`"enableThinking": false`
in settings flips it via `chat_template_kwargs`, or toggle it live with `/thinking`).

---

## Keys

| key | action |
|---|---|
| `shift+tab` | cycle permission modes |
| `@` | fzf file picker — inserts the picked path into your prompt |
| `↑` / `↓` | browse previous prompts (shell-style, persisted per project) |
| `esc` | interrupt the running turn / chain step |
| `1`-`9` | answer a model question by picking an option |
| `y` / `a` / `n` | permission prompt: yes / always this session / no |
| `ctrl+c` | quit |

## Permission modes (shift+tab)

| mode | behavior |
|---|---|
| `normal` | reads are free; edits and commands prompt, with a diff preview for edits |
| `accept-edits` | file edits auto-approved; bash still prompts (unless allowlisted) |
| `plan` | read-only; the model presents a plan, you switch modes to execute |
| `KAMIKAZEEE` | everything auto-approved. Red banner. You were warned. |

Allowlists/denylists in settings skip prompts permanently, Claude Code syntax:

```json
"permissions": { "allow": ["bash(git *)", "bash(ls*)"], "deny": ["bash(rm -rf*)"] }
```

Answering `a` (always) at a prompt allowlists that tool for the session.

## Built-in tools (what the model can do)

`bash` (full GNU userland, git, fzf), `read`, `write`, `edit` (exact-string replace,
diff previews), `grep`, `glob`, `ask_user`, `todo`, `skill`, `create_agent`,
`spawn_agent`, plus everything MCP servers provide.

Weak-model armor: every tool call is schema-validated; invalid calls get an actionable
error fed back (max 3 repair attempts), and tool calls the model emits as plain text
(```json blocks / `<tool_call>` leakage) are detected and recovered.

`ask_user` is first-class: the system prompt orders the model to ask you 1-3 concrete
questions *before* working when requirements are ambiguous — answers flow into project
memory, so it gets smarter about your domain with every question.

---

## Memory (two tiers)

**Global vault** — `~/.config/grayskull/GRAYSKULL.md`. Applies to every project. Updated
**only** when you explicitly say so: phrases like *"always remember …"*, *"from now on
always …"*, or the `/remember <fact>` command. Never auto-written.

**Project memory** — `.grayskull/memory.md`. Updated **automatically after every turn**
by a background extraction pass. Sections: project facts, domain knowledge, decisions,
user answers, gotchas. Capped (~3k tokens, configurable); compresses itself when over.

**Knowledge distillation**: when a turn used web search/fetch, the useful external
knowledge (API signatures, versions, config syntax) is distilled into project memory —
so the model doesn't re-search the same things next time.

**Brain-like scoring** (project memory only): every fact carries an activation score
modeled on human memory (ACT-R style):

- **decay** — scores halve every `halfLifeDays` (default 7) without use (forgetting curve)
- **reinforcement** — facts a turn actually touches get `+1` (capped at 3)
- **spreading activation** — the top-3 lexically similar neighbors of a used fact get a
  smaller boost too (`spreadFactor`, default 0.25): related knowledge stays warm
- **archive, not delete** — facts fading below `pruneThreshold` (0.15) move to
  `.grayskull/memory-archive.md`; if a later turn strongly matches an archived fact
  (`reviveThreshold` 0.55) it is **revived** at medium strength — forgotten, not destroyed
- strongest facts are injected first; over the token budget the weakest are dropped from
  the prompt (the file keeps them)
- the global vault is **exempt** — "always remember" never decays
- kill switch: `"memory": { "scoring": false }`

Both memories are injected into the system prompt every turn and survive context
compaction — that's what makes compaction safe.

```
/memory                # show both, with activation scores
/memory archive        # show faded (archived) facts
/memory edit [global]  # open in $EDITOR
/remember <fact>       # write to the global vault
/forget <pattern>      # prune project memory lines
```

## Settings (global + local)

Precedence: built-in defaults < `~/.config/grayskull/settings.json` <
`./.grayskull/settings.json`. Edit with `/settings` (global) or `/settings local`.

Covers: `baseURL`, `model`, `apiKeyEnv`, `contextWindow` (196608), `maxTokens`, sampling
(`temperature` 0.7, `topP` 0.8, `topK` 20, `presencePenalty`, `repetitionPenalty` — the
Qwen non-thinking coding preset), `enableThinking`, `compactThreshold`, `defaultMode`,
`editor`, `agentConcurrency`, `memory` (enabled / maxTokens / globalTriggers / scoring
knobs), `permissions` (allow/deny), `mcpServers`.

**System prompt**: `/system` opens the global one (`~/.config/grayskull/system-prompt.md`)
in `$EDITOR`; `/system local` creates/edits a per-project prompt that is *appended*
(set `"replaceSystemPrompt": true` in local settings to replace instead).

## Web search + fetch (always on)

searxng on `:8080`, bridged through the `mcp-searxng` stdio MCP server — a built-in
default, no setup needed. Two tools: `searxng_web_search` and `web_url_read`. The system
prompt makes the model **fetch** the top results after searching instead of trusting
snippets, and fetched knowledge feeds the memory distiller.

## MCP servers

Declared in settings (global or per project):

```json
"mcpServers": {
  "searxng":  { "type": "stdio", "command": "npx", "args": ["-y", "mcp-searxng"],
                "env": { "SEARXNG_URL": "http://127.0.0.1:8080" } },
  "somehttp": { "type": "http", "url": "http://localhost:9000/mcp" }
}
```

Tools appear to the model as `mcp__<server>__<tool>`. `/mcp` shows status,
`/mcp reconnect <name>` reconnects. Connection failures are reported, never fatal.

## Code intelligence (always on, full auto)

Three layers that catch weak-model mistakes mechanically:

- **Auto-diagnostics** — after every `edit`/`write` the project's check runs and failures
  are injected into the tool result, so the model fixes its own breakage in the same
  turn. Auto-detected per project: `typecheck` script → `bunx tsc --noEmit` →
  `cargo check` → `go vet` → `ruff`; override or disable via
  `"diagnostics": { "command": "...", "enabled": false }` in local settings.
- **LSP (mcp-language-server)** — semantic navigation: `definition`, `references`,
  `hover`, `rename_symbol`, `diagnostics`, `edit_file`. Attaches automatically per
  project type (`lsp-ts` when a `tsconfig.json` exists, `lsp-go` for `go.mod`) — the
  `if` field on any MCP server config gates it on a marker file, and `${cwd}` in args
  resolves per session. The system prompt steers the model to LSP over grep.
- **Context7** — current, version-specific library docs (`resolve-library-id` →
  `get-library-docs`); kills stale-API hallucinations and feeds the memory distiller.

## Browser testing (Playwright MCP)

The seeded global settings include a `playwright` MCP server
(`npx @playwright/mcp --browser chrome --headless`, 23 tools) driving your installed
Chrome. Delete the entry from settings if you don't want it.

The model has no vision, so rendering issues are caught the text way — the global
`webtest` skill (`/webtest <url>`, also in `examples/skills/`) encodes the playbook:

1. console errors first (most rendering bugs are JS errors)
2. accessibility snapshot = structure check
3. `browser_evaluate` layout assertions: element overflow, sibling overlaps,
   horizontal scrollbar, zero-size elements — measured in pixels, no eyes needed
4. interactions (clicks, keys) with re-checks; repeat at mobile width
5. screenshots saved to `.grayskull/screenshots/` **for the human** — you see what it can't

## Sub-agents + auto agent creation

Say: *"create an agent that checks for spelling mistakes. iterate through all modules"* —
the model calls `create_agent` (definition saved to `.grayskull/agents/spell-checker.md`,
shown for approval outside KAMIKAZEEE), then fans out `spawn_agent` once per module.
Spawns run concurrently (capped by `agentConcurrency`, default 2 — vLLM batches them),
each in a fresh context; only the final reports return to your conversation.

Agent definitions are markdown + frontmatter (`name`, `description`, `tools`), global in
`~/.config/grayskull/agents/` or per-project in `.grayskull/agents/` (local wins).
Sub-agents can't spawn sub-agents and can't ask you questions.

```
/agents                 # list
/agents edit <name>     # $EDITOR
/agents delete <name>
```

## Skills (Claude Code compatible)

`SKILL.md` folders discovered from, in rising precedence:
installed Claude Code plugins (`~/.claude/plugins/cache`), `~/.claude/skills/`,
`./.claude/skills/`, `~/.config/grayskull/skills/`, `./.grayskull/skills/`.
Your existing Claude Code skills work without copying anything.

Three ways skills fire:

- **auto-utilization (harness-level)**: every prompt — and every chain step and
  sub-agent task — is lexically matched against the skill catalog; up to 2 winners are
  injected straight into the turn's context (`⚡ skill auto-loaded: pixijs` note). The
  model can't skip what's already in front of it. Conservative matching: distinctive
  name tokens (fuzzy, so "pixi" hits "pixijs") or strong description overlap.
- you: `/<skill-name> [args]` (autocompletes alongside slash commands)
- the model: it sees the skill list in its system prompt and calls the `skill` tool
  itself when a request matches

`/skills` lists everything found.

**Skill packs** drop straight in — e.g. the official PixiJS collection (26 skills with a
router skill that dispatches to specialists, from https://pixijs.com/llms) is installed:

```sh
git clone --depth 1 https://github.com/pixijs/pixijs-skills /tmp/ps \
  && cp -r /tmp/ps/skills/* ~/.config/grayskull/skills/ && rm -rf /tmp/ps
```

On code tasks the model routes itself: `skill(pixijs) → pixijs-application →
pixijs-scene-sprite → …` before writing. Long pack descriptions are capped at 220 chars
in the system-prompt listing; the full body loads on invocation.

## Thinking chains — /thinkingchain (alias /tc)

Named, reusable step pipelines the model is walked through in order — structure the
model can't impose on itself:

```
/tc new full-dev websearch -> plan -> review with websearch -> implementation
                 -> review with websearch -> testing -> create readme.md
/tc run full-dev <task>      # one-shot   (shorthand: /tc full-dev <task>)
/tc use full-dev             # sticky: EVERY prompt runs through the chain
/tc off                      # back to normal
/tc list · steps · edit <name> · delete <name>
```

- **Steps are freeform text**, split on `->`. Built-in names (`websearch`/`research`,
  `plan`, `review`, `implement`, `test`, `readme`/`document`, `refactor` — `/tc steps`)
  expand to tuned instructions; anything else is used verbatim. Composition works:
  "review with websearch" = review behavior + web tools.
- **Gates**: steps containing `review`/`test`/`verify` must end `VERDICT: PASS` or
  `VERDICT: FAIL: <reasons>`. On FAIL the chain jumps back to the previous non-gate step
  with the reasons attached (max 2 retries per step), then continues with a warning.
- **Context modes**, per chain default + `--fresh`/`--shared` override at run/use time:
  - `shared` (default) — steps run in the main conversation, full visibility
  - `fresh` — each step gets an isolated context with a handoff summary of the previous
    steps; one combined summary lands in history and memory at the end
- **Per-step inference profiles**: each step runs with a thinking + sampling preset,
  flipped together. `implement`/`refactor`/`readme` → `codegen` (thinking OFF,
  deterministic); `plan`/`review`/`diagnose`/`test`/`websearch` and gates → `reason`
  (thinking ON). Presets come from the active model profile (see below). Override per
  chain with a `profiles:` line in the chain file, e.g. `profiles: implement=reason`.
  Each step's banner shows `⛓ profile: reason (think:on · temp 0.6 · top_p 0.95)`.
- Chains are **global**: `~/.config/grayskull/chains/<name>.md`. Starters seeded on
  first run: `full-dev` (the pipeline above) and `quick` (`plan -> implement -> test`).
- Statusline shows `⛓ name 3/7` during a run, `⛓ name [shared]` while sticky.

## Model profiles — Qwen3.5 / GLM-4.5-Air

`modelFamily` in settings selects a model profile that adapts three family-specific
things: the plaintext tool-call **leak-recovery dialect**, the chain-step **sampling
presets**, and the recorded vLLM **parser flags**. The thinking toggle
(`chat_template_kwargs.enable_thinking`) is the same on both families.

- `qwen3.5` (default) — leak dialect `qwen` (JSON `<tool_call>`/```json), parsers
  `qwen3_xml` / `qwen3`.
- `glm4.5` — leak dialect `glm` (GLM's `<tool_call>name<arg_key>/<arg_value></tool_call>`
  XML), parsers `glm45` / `glm45`. Switch with
  `{"modelFamily":"glm4.5","baseURL":"http://10.8.0.22:8001/v1","model":"glm-4.5-air"}`.

This emulates "two models" from GLM-4.5-Air's hybrid reasoning: codegen steps run
thinking-OFF, plan/diagnose/test run thinking-ON. See `glm-server-notes.md` for the
verified GLM values and the server launch flags. Adding a family = one entry in
`src/llm/profiles.ts`.

## Web UI — grayskull-web

```sh
grayskull-web          # serves on http://0.0.0.0:4242  (grayskull-web <port> to override)
```

Matrix-style control room in the browser (single self-contained page, Bun-native
WebSockets, zero frontend build):

- **multiple live sessions** — left panel; each runs a full agent (own cwd, settings,
  memory, MCP, permissions), create more with + NEW SESSION
- **chat** with token streaming, dimmed reasoning stream, colorized diffs, tool cards
- **AGENT MESH** (right) — live node graph: the GRAYSKULL core, every spawned sub-agent
  (⚔) and MCP server (⇄) as nodes; edges animate while a node works, nodes glow amber
  on activity and fade when done. **Click any node** → modal with its live activity log
  (spawn task, every tool call, streamed output, final report)
- **MEMORY ACTIVATION graph** — project memory as a living node graph: node size and
  glow = activation score, edges = the lexical similarity that drives spreading
  activation, clustered by section. Click a memory → its text, score, uses and linked
  memories. TEXT toggle for the flat view. Updates after every turn — watch it learn
- **CHAIN // TODO panel** — running thinking chains as a live pipeline (steps light up,
  ⛩ gates dashed, retries flash red) + the model's todo list with a progress bar
- **slash commands work in web sessions** too (`/tc`, `/memory`, `/compact`, …);
  editor/picker commands stay terminal-only
- permission and ask_user requests pop as modals (y/a/n keys work)
- mode buttons incl. KAMIKAZEEE — which flips the whole UI into a red-alert theme,
  matrix rain included
- digital rain + CRT scanlines, session replay on reconnect, esc interrupts

**CLI sessions join the hub.** Every terminal `grayskull` automatically connects to a
running grayskull-web (retrying quietly in the background, `⇄ web` in the statusline
when linked) and shows up in the session list with a ⌨ badge. From the browser you can
read its live transcript, send prompts, switch modes (incl. KAMIKAZEEE), answer
permission/ask dialogs and interrupt — while the terminal stays fully usable; both UIs
mirror each other in real time, and a prompt answered in one closes the dialog in the
other. Hub URL override: `GRAYSKULL_HUB=ws://host:4242/cli`.

No auth — it binds to 0.0.0.0 for LAN use, don't expose it to the internet.

## Context management

- Live `ctx %` in the statusline (real prompt-token usage from vLLM).
- Auto-compaction at 70% of the 196k window (configurable `compactThreshold`): older
  turns are summarized by the model into a briefing, recent turns stay verbatim,
  memory files are untouched. Manual: `/compact`.

## Sessions

Every session is logged as JSONL under `~/.config/grayskull/sessions/<project>/`.
`/resume` opens an fzf picker over past sessions of the current project and restores the
full conversation. `/clear` wipes the current conversation and screen.

---

## Slash commands

| command | what it does |
|---|---|
| `/help` | commands + keys |
| `/init` | explore the project, ask questions, seed project memory |
| `/system [local]` | edit system prompt in `$EDITOR` |
| `/settings [local]` | edit settings.json |
| `/memory [edit [global]]` | show / edit memories |
| `/remember <fact>` | save to the global vault |
| `/forget <pattern>` | prune project memory |
| `/compact` | compact the conversation now |
| `/mode [name]` | show or set permission mode |
| `/thinking [on\|off]` | toggle the model's reasoning mode live (no restart) |
| `/mcp [reconnect <name>]` | MCP status / reconnect |
| `/agents [edit\|delete <name>]` | manage sub-agents |
| `/skills` | list discovered skills |
| `/<skill-name> [args]` | run a skill |
| `/thinkingchain`, `/tc` | thinking chains (see above) |
| `/resume` | restore a past session (fzf) |
| `/clear` | clear conversation + screen |
| `/exit` | quit |

## Layout on disk

```
~/.config/grayskull/            global: settings.json, system-prompt.md,
                                GRAYSKULL.md (vault), agents/, chains/, skills/, sessions/
<project>/.grayskull/           local: settings.json, system-prompt.md,
                                memory.md, agents/, skills/
```

## Development

```sh
bun install
bunx tsc --noEmit     # typecheck (keep clean)
bun run start
```

Architecture notes for agents working on this repo: see `CLAUDE.md`.
