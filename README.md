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
  --enable-auto-tool-choice --tool-call-parser hermes \
  --enable-prefix-caching \
  --max-model-len 131072
```

`--enable-prefix-caching` matters: grayskull keeps the system prompt + memory as a stable
prefix, so every turn after the first reuses the KV cache.

---

## Keys

| key | action |
|---|---|
| `shift+tab` | cycle permission modes |
| `@` | fzf file picker — inserts the picked path into your prompt |
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

Both memories are injected into the system prompt every turn and survive context
compaction — that's what makes compaction safe.

```
/memory                # show both
/memory edit [global]  # open in $EDITOR
/remember <fact>       # write to the global vault
/forget <pattern>      # prune project memory lines
```

## Settings (global + local)

Precedence: built-in defaults < `~/.config/grayskull/settings.json` <
`./.grayskull/settings.json`. Edit with `/settings` (global) or `/settings local`.

Covers: `baseURL`, `model`, `apiKeyEnv`, `contextWindow`, `maxTokens`, sampling
(`temperature`, `topP`, `topK`), `compactThreshold`, `defaultMode`, `editor`,
`agentConcurrency`, `memory` (enabled / maxTokens / extra globalTriggers),
`permissions` (allow/deny), `mcpServers`.

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

Two ways to fire one:

- you: `/<skill-name> [args]` (autocompletes alongside slash commands)
- the model: it sees the skill list in its system prompt and calls the `skill` tool
  itself when a request matches

`/skills` lists everything found.

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
- Chains are **global**: `~/.config/grayskull/chains/<name>.md`. Starters seeded on
  first run: `full-dev` (the pipeline above) and `quick` (`plan -> implement -> test`).
- Statusline shows `⛓ name 3/7` during a run, `⛓ name [shared]` while sticky.

## Context management

- Live `ctx %` in the statusline (real prompt-token usage from vLLM).
- Auto-compaction at 70% of the 131k window (configurable `compactThreshold`): older
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
