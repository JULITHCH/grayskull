import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
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
const MAX_RENDERED_ITEMS = 60;

type QueuedWork =
  | { kind: "prompt"; text: string }
  | { kind: "chain"; def: ChainDef; mode: ChainContextMode; task: string };

interface PendingPermission {
  req: PermissionRequest;
  resolve: (answer: "yes" | "always" | "no") => void;
}

interface PendingAsk {
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
}

export function App(props: AppProps): React.ReactElement {
  const { cwd, settings, agent, bridge, memory, mcp, perms, client, store } = props;
  const { exit } = useApp();

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamReason, setStreamReason] = useState("");
  const [input, setInput] = useState("");
  const [mode, setModeState] = useState<PermissionMode>(perms.mode);
  const [busy, setBusy] = useState(false);
  const [busyWhat, setBusyWhat] = useState("");
  const [spin, setSpin] = useState(0);
  const [pendingPerm, setPendingPerm] = useState<PendingPermission | null>(null);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
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

  const pushItem = (item: TranscriptItem) => {
    setItems((prev) => {
      // tool items arrive twice (running → done): replace the running card
      if (item.type === "tool") {
        for (let i = prev.length - 1; i >= 0 && i >= prev.length - 10; i--) {
          const p = prev[i];
          if (p && p.type === "tool" && p.detail === item.detail && p.state === "running") {
            const next = [...prev];
            next[i] = item;
            return next;
          }
        }
      }
      return [...prev, item];
    });
  };

  const setMode = (m: PermissionMode) => {
    perms.mode = m;
    setModeState(m);
    if (m === "kamikazeee") {
      pushItem({ type: "banner", text: KAMIKAZEEE_BANNER + "\n" + KAMIKAZEEE_WARNING, color: "red" });
    }
  };

  // wire the bridge the agent talks to
  useEffect(() => {
    bridge.pushItem = pushItem;
    bridge.assistantDelta = (delta) => {
      streamRef.current += delta;
      setStreamText(streamRef.current);
    };
    bridge.reasoningDelta = (delta) => {
      // show the think-stream dimmed while it runs; it is not kept
      reasonRef.current = (reasonRef.current + delta).slice(-600);
      setStreamReason(reasonRef.current);
    };
    bridge.assistantDone = () => {
      const text = streamRef.current;
      streamRef.current = "";
      reasonRef.current = "";
      setStreamText("");
      setStreamReason("");
      if (text.trim()) pushItem({ type: "assistant", text });
    };
    bridge.requestPermission = (req) =>
      new Promise((resolve) => setPendingPerm({ req, resolve }));
    bridge.askUser = (question, options) =>
      new Promise((resolve) => setPendingAsk({ question, options, resolve }));
    bridge.setBusy = (b, what) => {
      setBusy(b);
      setBusyWhat(what ?? "");
    };
    memory.onUpdate = (scope) => {
      setMemFlash(scope === "global" ? "⚡ global memory" : "✦ memory");
      setTimeout(() => setMemFlash(""), 4000);
    };
    memory.onNote = (text) => pushItem({ type: "note", text });
    mcp.onChange = () => forceRender((n) => n + 1);
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
        clearTranscript: () => setItems([]),
        exit: () => {
          void mcp.closeAll();
          exit();
        },
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
      if (c === "y" || key.return) {
        pendingPerm.resolve("yes");
        setPendingPerm(null);
      } else if (c === "a") {
        pendingPerm.resolve("always");
        setPendingPerm(null);
      } else if (c === "n" || key.escape) {
        pendingPerm.resolve("no");
        setPendingPerm(null);
      }
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
      const idx = Number(char) - 1;
      const opt = pendingAsk.options[idx];
      if (opt) {
        pushItem({ type: "ask", question: pendingAsk.question, answer: opt });
        pendingAsk.resolve(opt);
        setPendingAsk(null);
        return;
      }
    }

    if (key.return) {
      if (pendingAsk) {
        const answer = input.trim();
        if (!answer) return;
        pushItem({ type: "ask", question: pendingAsk.question, answer });
        pendingAsk.resolve(answer);
        setPendingAsk(null);
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
  const chainChip = chainState.running
    ? `⛓ ${chainState.running.name} ${chainState.running.step}/${chainState.running.total}`
    : chainState.sticky
      ? `⛓ ${chainState.sticky.def.name} [${chainState.sticky.mode}]`
      : "";
  const visibleItems = items.slice(-MAX_RENDERED_ITEMS);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">{BANNER}</Text>
        <Text color="yellow" bold>
          {"  "}{TAGLINE}
        </Text>
        <Text dimColor>
          {"  "}{settings.model} · {settings.baseURL} · /help for commands
        </Text>
      </Box>

      {items.length > visibleItems.length && (
        <Text dimColor>… {items.length - visibleItems.length} earlier entries …</Text>
      )}
      {visibleItems.map((item, i) => (
        <TranscriptLine key={items.length - visibleItems.length + i} item={item} />
      ))}

      {streamReason !== "" && streamText === "" && (
        <Box marginTop={1}>
          <Text dimColor italic>
            ∴ {streamReason.split("\n").slice(-4).join("\n")}
          </Text>
        </Box>
      )}

      {streamText !== "" && (
        <Box marginTop={1}>
          <Text>{streamText}</Text>
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
      return (
        <Box flexDirection="column">
          <Text color={color}>
            {icon} {item.detail}
          </Text>
          {item.state !== "running" && snippet && (
            <Text dimColor>
              {"  "}{snippet.slice(0, 300)}
              {resultLines.length > 3 || (item.result ?? "").length > 300 ? " …" : ""}
            </Text>
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

function PermissionPrompt({ pending }: { pending: PendingPermission }): React.ReactElement {
  const previewLines = (pending.req.preview ?? "").split("\n").slice(0, 25);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        permission: {pending.req.detail}
      </Text>
      {previewLines.length > 0 && pending.req.preview && (
        <Box flexDirection="column" marginTop={1}>
          {previewLines.map((l, i) => (
            <Text key={i} color={l.startsWith("+") ? "green" : l.startsWith("-") ? "red" : undefined} dimColor={!l.startsWith("+") && !l.startsWith("-")}>
              {l}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>[y]es · [a]lways this session · [n]o</Text>
    </Box>
  );
}
