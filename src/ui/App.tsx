import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { PermissionMode, TranscriptItem } from "../types";
import { MODE_ORDER } from "../types";
import type { Settings } from "../config/settings";
import type { GrayskullAgent, PermissionRequest, UiBridge } from "../agent/loop";
import type { MemoryManager } from "../memory/memory";
import type { McpManager } from "../mcp/manager";
import type { PermissionEngine } from "../perms/engine";
import type { LlmClient } from "../llm/client";
import type { SessionStore } from "../session/store";
import { todoState } from "../tools/todo";
import { COMMANDS, runSlashCommand, type CommandContext } from "../slash";
import { loadSkills } from "../skills/registry";
import { runChain, chainState } from "../chains/runner";
import type { ChainDef, ChainContextMode } from "../chains/registry";
import type { CliLink } from "../web/clilink";
import { loadGlobalMemory, loadLocalMemory } from "../memory/memory";
import { memoryGraphData } from "../memory/scores";
import { renderMarkdown } from "./markdown";
import { pickFile } from "./external";
import { BANNER, TAGLINE, KAMIKAZEEE_BANNER, KAMIKAZEEE_WARNING } from "./banners";
import { localDir } from "../config/paths";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HISTORY_MAX = 200;

function historyPath(cwd: string): string {
  return join(localDir(cwd), "prompt-history.txt");
}

function loadPromptHistory(cwd: string): string[] {
  try {
    if (!existsSync(historyPath(cwd))) return [];
    return readFileSync(historyPath(cwd), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/\\n/g, "\n"))
      .slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

function appendPromptHistory(cwd: string, text: string): void {
  try {
    appendFileSync(historyPath(cwd), text.replace(/\n/g, "\\n") + "\n");
  } catch {
    // history must never break the session
  }
}

const MODE_STYLE: Record<PermissionMode, { label: string; color: string }> = {
  normal: { label: "normal", color: "gray" },
  "accept-edits": { label: "accept-edits", color: "yellow" },
  plan: { label: "plan", color: "blue" },
  kamikazeee: { label: "KAMIKAZEEE", color: "red" },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STREAM_TAIL_LINES = 8;
const STREAM_FLUSH_MS = 80;

type QueuedWork =
  | { kind: "prompt"; text: string }
  | { kind: "chain"; def: ChainDef; mode: ChainContextMode; task: string };

interface PendingPermission {
  reqId: string;
  req: PermissionRequest;
  resolve: (answer: "yes" | "always" | "no") => void;
}

interface PendingAsk {
  reqId: string;
  question: string;
  options?: string[];
  resolve: (answer: string) => void;
}

export interface AppProps {
  cwd: string;
  settings: Settings;
  agent: GrayskullAgent;
  bridge: UiBridge;
  memory: MemoryManager;
  mcp: McpManager;
  perms: PermissionEngine;
  client: LlmClient;
  store: SessionStore;
  /** bridge to a grayskull-web hub, when one is running */
  link?: CliLink;
}

export function App(props: AppProps): React.ReactElement {
  const { cwd, settings, agent, bridge, memory, mcp, perms, client, store, link } = props;
  const { exit } = useApp();

  // finished items go to <Static> — printed once, never re-rendered (anti-flicker);
  // only running tools + the stream tail + prompts live in the dynamic region
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>([
    { type: "banner", text: BANNER, color: "yellow" },
    { type: "banner", text: `  ${TAGLINE}`, color: "yellow" },
    { type: "note", text: `  ${settings.model} · ${settings.baseURL} · /help for commands` },
  ]);
  const [runningTools, setRunningTools] = useState<Array<TranscriptItem & { type: "tool" }>>([]);
  const [streamText, setStreamText] = useState("");
  const [streamReason, setStreamReason] = useState("");
  const [input, setInput] = useState("");
  const [mode, setModeState] = useState<PermissionMode>(perms.mode);
  const [busy, setBusy] = useState(false);
  const [busyWhat, setBusyWhat] = useState("");
  const [spin, setSpin] = useState(0);
  const [pendingPerm, setPendingPermState] = useState<PendingPermission | null>(null);
  const [pendingAsk, setPendingAskState] = useState<PendingAsk | null>(null);
  const [hubConnected, setHubConnected] = useState(false);
  // refs mirror the pending prompts so hub commands (stale closures) can resolve them
  const pendingPermRef = useRef<PendingPermission | null>(null);
  const pendingAskRef = useRef<PendingAsk | null>(null);
  const reqCounterRef = useRef(0);
  const itemsRef = useRef<TranscriptItem[]>([]);
  const setPendingPerm = (p: PendingPermission | null) => {
    pendingPermRef.current = p;
    setPendingPermState(p);
  };
  const setPendingAsk = (a: PendingAsk | null) => {
    pendingAskRef.current = a;
    setPendingAskState(a);
  };
  const [memFlash, setMemFlash] = useState("");
  const [, forceRender] = useState(0);

  const streamRef = useRef("");
  const reasonRef = useRef("");
  const queueRef = useRef<QueuedWork[]>([]);
  const runningRef = useRef(false);
  // shell-style prompt history (persisted per project)
  const historyRef = useRef<string[]>(loadPromptHistory(cwd));
  const histIdxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushItem = (item: TranscriptItem) => {
    link?.publish({ t: "item", item });
    if (item.type !== "tool" || item.state !== "running") {
      itemsRef.current.push(item);
      if (itemsRef.current.length > 300) itemsRef.current.shift();
    }
    // tool items arrive twice (running → done): keep running ones in the
    // dynamic region, finalize into <Static> when they complete
    if (item.type === "tool") {
      if (item.state === "running") {
        setRunningTools((prev) => [...prev.filter((t) => t.detail !== item.detail), item]);
      } else {
        setRunningTools((prev) => prev.filter((t) => t.detail !== item.detail));
        setStaticItems((prev) => [...prev, item]);
      }
      return;
    }
    setStaticItems((prev) => [...prev, item]);
  };

  const setMode = (m: PermissionMode) => {
    perms.mode = m;
    setModeState(m);
    if (m === "kamikazeee") {
      pushItem({ type: "banner", text: KAMIKAZEEE_BANNER + "\n" + KAMIKAZEEE_WARNING, color: "red" });
    }
    publishStatus();
  };

  const publishStatus = () => {
    link?.publish({
      t: "status",
      mode: perms.mode,
      busy: runningRef.current,
      ctxPct: Math.min(100, Math.round((client.lastPromptTokens / settings.contextWindow) * 100)),
      mcp: [...mcp.statuses.values()].map((s) => ({ name: s.name, state: s.state, tools: s.toolCount })),
      model: settings.model,
      todo: todoState.items,
      chain: runningRef.current ? chainState.running : null,
      sticky: chainState.sticky
        ? { name: chainState.sticky.def.name, mode: chainState.sticky.mode }
        : null,
    });
  };

  const publishMemory = () => {
    const local = loadLocalMemory(cwd);
    let graph = null;
    try {
      const m = settings.memory;
      graph = memoryGraphData(cwd, local, {
        halfLifeDays: m.halfLifeDays,
        spreadFactor: m.spreadFactor,
        pruneThreshold: m.pruneThreshold,
        reviveThreshold: m.reviveThreshold,
      });
    } catch {
      // graph is decoration — never break the publish
    }
    link?.publish({ t: "memory", global: loadGlobalMemory(), local, graph });
  };

  const resolvePerm = (answer: "yes" | "always" | "no") => {
    const p = pendingPermRef.current;
    if (!p) return;
    setPendingPerm(null);
    link?.publish({ t: "perm_done", reqId: p.reqId });
    p.resolve(answer);
  };

  const resolveAsk = (answer: string) => {
    const a = pendingAskRef.current;
    if (!a) return;
    setPendingAsk(null);
    pushItem({ type: "ask", question: a.question, answer });
    link?.publish({ t: "ask_done", reqId: a.reqId });
    a.resolve(answer);
  };

  // wire the bridge the agent talks to
  useEffect(() => {
    bridge.pushItem = pushItem;
    bridge.assistantDelta = (delta) => {
      streamRef.current += delta;
      link?.publish({ t: "delta", text: delta });
      // throttle: flushing every token redraws the live region too often
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          setStreamText(streamRef.current);
        }, STREAM_FLUSH_MS);
      }
    };
    bridge.reasoningDelta = (delta) => {
      link?.publish({ t: "reasoning", text: delta });
      // show the think-stream dimmed while it runs; it is not kept
      reasonRef.current = (reasonRef.current + delta).slice(-600);
      setStreamReason(reasonRef.current);
    };
    bridge.assistantDone = () => {
      const text = streamRef.current;
      streamRef.current = "";
      reasonRef.current = "";
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      setStreamText("");
      setStreamReason("");
      link?.publish({ t: "stream_end" });
      if (text.trim()) pushItem({ type: "assistant", text });
    };
    bridge.requestPermission = (req) =>
      new Promise((resolve) => {
        const reqId = `p${++reqCounterRef.current}`;
        setPendingPerm({ reqId, req, resolve });
        link?.publish({ t: "perm_req", reqId, detail: req.detail, preview: req.preview ?? null });
      });
    bridge.askUser = (question, options) =>
      new Promise((resolve) => {
        const reqId = `a${++reqCounterRef.current}`;
        setPendingAsk({ reqId, question, options, resolve });
        link?.publish({ t: "ask_req", reqId, question, options: options ?? null });
      });
    bridge.setBusy = (b, what) => {
      setBusy(b);
      setBusyWhat(what ?? "");
      link?.publish({ t: "busy", busy: b, what: what ?? "" });
      publishStatus();
    };
    memory.onUpdate = (scope) => {
      setMemFlash(scope === "global" ? "⚡ global memory" : "✦ memory");
      setTimeout(() => setMemFlash(""), 4000);
      publishMemory();
    };
    memory.onNote = (text) => pushItem({ type: "note", text });
    mcp.onChange = () => {
      forceRender((n) => n + 1);
      publishStatus();
    };

    // grayskull-web hub: register, mirror, accept remote control
    if (link) {
      link.getRegistration = () => ({ cwd, mode: perms.mode, items: itemsRef.current });
      link.onStateChange = (connected) => {
        setHubConnected(connected);
        if (connected) {
          publishStatus();
          publishMemory();
        }
      };
      link.onCommand = (msg) => {
        switch (msg["t"]) {
          case "prompt": {
            const text = String(msg["text"] ?? "").trim();
            if (text) {
              pushItem({ type: "note", text: "⇄ prompt from web" });
              void submitText(text);
            }
            break;
          }
          case "mode":
            if ((MODE_ORDER as string[]).includes(String(msg["mode"]))) {
              setMode(String(msg["mode"]) as PermissionMode);
            }
            break;
          case "interrupt":
            agent.stop();
            break;
          case "answer": {
            const reqId = String(msg["reqId"] ?? "");
            const value = String(msg["value"] ?? "");
            // "always" allowlisting happens in the loop's decide callback
            if (pendingPermRef.current?.reqId === reqId && ["yes", "always", "no"].includes(value)) {
              resolvePerm(value as "yes" | "always" | "no");
            } else if (pendingAskRef.current?.reqId === reqId && value) {
              resolveAsk(value);
            }
            break;
          }
        }
      };
      link.start();
    }
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 90);
    return () => clearInterval(t);
  }, [busy]);

  const submitToAgent = (text: string) => {
    // sticky thinking chain: every plain prompt becomes a chain run
    const sticky = chainState.sticky;
    queueRef.current.push(
      sticky ? { kind: "chain", def: sticky.def, mode: sticky.mode, task: text } : { kind: "prompt", text },
    );
    void drainQueue();
  };

  const submitChain = (def: ChainDef, mode: ChainContextMode, task: string) => {
    queueRef.current.push({ kind: "chain", def, mode, task });
    void drainQueue();
  };

  const drainQueue = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      let next: QueuedWork | undefined;
      while ((next = queueRef.current.shift()) !== undefined) {
        if (next.kind === "prompt") {
          pushItem({ type: "user", text: next.text });
          await agent.runTurn(next.text);
        } else {
          pushItem({ type: "user", text: `⛓ [${next.def.name}] ${next.task}` });
          await runChain({ chain: next.def, task: next.task, mode: next.mode, agent, ui: bridge, memory });
        }
        store.save(agent.history);
      }
    } finally {
      runningRef.current = false;
    }
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    histIdxRef.current = null;
    draftRef.current = "";
    if (historyRef.current[historyRef.current.length - 1] !== text) {
      historyRef.current.push(text);
      if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift();
      appendPromptHistory(cwd, text);
    }
    await submitText(text);
  };

  /** Shared by the keyboard path and prompts arriving from the web hub. */
  const submitText = async (text: string) => {
    if (text.startsWith("/")) {
      const ctx: CommandContext = {
        cwd,
        settings,
        agent,
        memory,
        mcp,
        perms,
        store,
        push: pushItem,
        setMode,
        clearTranscript: () => setStaticItems([]),
        // real teardown (MCP, hub link, process.exit) runs in index.tsx
        // via waitUntilExit once Ink unmounts
        exit: () => exit(),
      };
      const result = await runSlashCommand(ctx, text);
      if (result === "unknown") {
        pushItem({ type: "note", text: `unknown command ${text.split(" ")[0]} — try /help` });
      } else if (result && "prompt" in result) {
        submitToAgent(result.prompt);
      } else if (result && "chain" in result) {
        const { def, mode, task } = result.chain;
        if (task) {
          submitChain(def, mode, task);
        } else {
          chainState.sticky = { def, mode };
          pushItem({
            type: "note",
            text: `⛓ chain "${def.name}" (${mode}) active — every prompt runs through it. /tc off to stop.`,
          });
        }
      }
      return;
    }
    submitToAgent(text);
  };

  useInput((char, key) => {
    // permission prompt steals the keyboard
    if (pendingPerm) {
      const c = char.toLowerCase();
      if (c === "y" || key.return) resolvePerm("yes");
      else if (c === "a") resolvePerm("always");
      else if (c === "n" || key.escape) resolvePerm("no");
      return;
    }

    if (key.tab && key.shift) {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]!;
      setMode(next);
      return;
    }

    if (key.escape) {
      if (busy) agent.stop();
      return;
    }

    // shell-style history: up = older, down = newer, past newest = your draft
    if (key.upArrow) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      if (histIdxRef.current === null) {
        draftRef.current = input;
        histIdxRef.current = hist.length - 1;
      } else if (histIdxRef.current > 0) {
        histIdxRef.current--;
      }
      setInput(hist[histIdxRef.current] ?? "");
      return;
    }
    if (key.downArrow) {
      if (histIdxRef.current === null) return;
      if (histIdxRef.current < historyRef.current.length - 1) {
        histIdxRef.current++;
        setInput(historyRef.current[histIdxRef.current] ?? "");
      } else {
        histIdxRef.current = null;
        setInput(draftRef.current);
      }
      return;
    }

    // ask_user: digits pick an option, otherwise the typed text is the answer
    if (pendingAsk && pendingAsk.options && /^[1-9]$/.test(char) && input === "") {
      const opt = pendingAsk.options[Number(char) - 1];
      if (opt) {
        resolveAsk(opt);
        return;
      }
    }

    if (key.return) {
      if (pendingAsk) {
        const answer = input.trim();
        if (!answer) return;
        resolveAsk(answer);
        setInput("");
        return;
      }
      void handleSubmit();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }

    if (char === "@") {
      const picked = pickFile(cwd);
      setInput((v) => v + (picked ? `@${picked} ` : "@"));
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      setInput((v) => v + char);
    }
  });

  const skillHints = useMemo(
    () => loadSkills(cwd).map((s) => ({ name: s.name, description: `${s.description} [skill]` })),
    [],
  );
  const slashHints = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return [];
    return [...COMMANDS, ...skillHints]
      .filter((c) => `/${c.name}`.startsWith(input))
      .slice(0, 6);
  }, [input, skillHints]);

  const ctxPct = Math.min(
    100,
    Math.round((client.lastPromptTokens / settings.contextWindow) * 100),
  );
  const mcpConnected = [...mcp.statuses.values()].filter((s) => s.state === "connected").length;
  const todoOpen = todoState.items.filter((i) => !i.done).length;
  const streamTail = streamText.split("\n").slice(-STREAM_TAIL_LINES).join("\n");
  const chainChip = chainState.running
    ? `⛓ ${chainState.running.name} ${chainState.running.step}/${chainState.running.total}`
    : chainState.sticky
      ? `⛓ ${chainState.sticky.def.name} [${chainState.sticky.mode}]`
      : "";
  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item, i) => <TranscriptLine key={i} item={item} />}
      </Static>

      {runningTools.map((item) => (
        <TranscriptLine key={item.detail} item={item} />
      ))}

      {streamReason !== "" && streamText === "" && (
        <Box marginTop={1}>
          <Text dimColor italic>
            ∴ {streamReason.split("\n").slice(-4).join("\n")}
          </Text>
        </Box>
      )}

      {streamTail !== "" && (
        <Box marginTop={1}>
          <Text>{streamTail}</Text>
        </Box>
      )}

      {pendingPerm && <PermissionPrompt pending={pendingPerm} />}

      {pendingAsk && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text color="cyan" bold>
            ? {pendingAsk.question}
          </Text>
          {pendingAsk.options?.map((o, i) => (
            <Text key={i} color="cyan">
              {"  "}{i + 1}. {o}
            </Text>
          ))}
          <Text dimColor>{pendingAsk.options ? "press a number or type an answer + enter" : "type an answer + enter"}</Text>
        </Box>
      )}

      {busy && (
        <Box marginTop={1}>
          <Text color="magenta">
            {SPINNER[spin]} {busyWhat || "working"}… <Text dimColor>(esc to interrupt)</Text>
          </Text>
        </Box>
      )}

      <Box borderStyle="round" borderColor={MODE_STYLE[mode].color} paddingX={1} marginTop={1}>
        <Text color={MODE_STYLE[mode].color}>{"> "}</Text>
        <Text>{input}</Text>
        <Text color={MODE_STYLE[mode].color}>▋</Text>
      </Box>

      {slashHints.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {slashHints.map((c) => (
            <Text key={c.name} dimColor>
              /{c.name} — {c.description}
            </Text>
          ))}
        </Box>
      )}

      <Box paddingX={1} justifyContent="space-between">
        <Text>
          <Text color={MODE_STYLE[mode].color} bold inverse>
            {" "}{MODE_STYLE[mode].label}{" "}
          </Text>
          <Text dimColor> shift+tab</Text>
        </Text>
        <Text dimColor>
          {hubConnected ? "⇄ web · " : ""}
          {chainChip ? (
            <Text color="magenta">{chainChip}{" · "}</Text>
          ) : null}
          {memFlash ? `${memFlash} · ` : ""}
          {todoOpen > 0 ? `todo ${todoOpen} · ` : ""}
          ctx {ctxPct}% · mcp {mcpConnected}/{mcp.statuses.size}
        </Text>
      </Box>
    </Box>
  );
}

function TranscriptLine({ item }: { item: TranscriptItem }): React.ReactElement {
  switch (item.type) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="green" bold>
            {"❯ "}
          </Text>
          <Text color="green">{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      );
    case "tool": {
      const icon =
        item.state === "running" ? "◐" : item.state === "done" ? "●" : item.state === "denied" ? "⊘" : "✗";
      const color = item.state === "error" || item.state === "denied" ? "red" : "cyan";
      const resultLines = (item.result ?? "").split("\n");
      const snippet = resultLines.slice(0, 3).join("\n");
      const showDiff = item.state === "done" && item.preview;
      return (
        <Box flexDirection="column">
          <Text color={color}>
            {icon} {item.detail}
          </Text>
          {showDiff ? (
            <DiffView patch={item.preview!} />
          ) : (
            item.state !== "running" &&
            snippet && (
              <Text dimColor>
                {"  "}{snippet.slice(0, 300)}
                {resultLines.length > 3 || (item.result ?? "").length > 300 ? " …" : ""}
              </Text>
            )
          )}
        </Box>
      );
    }
    case "ask":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">? {item.question}</Text>
          {item.answer && <Text color="cyan" dimColor>{"  → "}{item.answer}</Text>}
        </Box>
      );
    case "note":
      return (
        <Box marginTop={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case "banner":
      return (
        <Box marginTop={1}>
          <Text color={item.color ?? "yellow"} bold>
            {item.text}
          </Text>
        </Box>
      );
  }
}

/** Colorized unified diff, headers stripped, capped — Claude Code style. */
function DiffView({ patch, maxLines = 30 }: { patch: string; maxLines?: number }): React.ReactElement {
  const lines = patch
    .split("\n")
    .filter((l) => !/^(Index:|={3,}|---|\+\+\+)/.test(l) && l !== "\\ No newline at end of file");
  const shown = lines.slice(0, maxLines);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((l, i) => (
        <Text
          key={i}
          color={l.startsWith("+") ? "green" : l.startsWith("-") ? "red" : l.startsWith("@@") ? "cyan" : undefined}
          dimColor={!l.startsWith("+") && !l.startsWith("-")}
        >
          {l || " "}
        </Text>
      ))}
      {lines.length > maxLines && <Text dimColor>… {lines.length - maxLines} more diff lines</Text>}
    </Box>
  );
}

function PermissionPrompt({ pending }: { pending: PendingPermission }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        permission: {pending.req.detail}
      </Text>
      {pending.req.preview && (
        <Box marginTop={1}>
          <DiffView patch={pending.req.preview} maxLines={25} />
        </Box>
      )}
      <Text dimColor>[y]es · [a]lways this session · [n]o</Text>
    </Box>
  );
}
