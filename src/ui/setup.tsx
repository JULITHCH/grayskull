import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Settings } from "../config/settings";
import { GLOBAL_SETTINGS } from "../config/paths";
import type { McpManager } from "../mcp/manager";
import type { LlmClient } from "../llm/client";

/** /setup dialog: edit endpoints in place (applied live), check that the
 *  always-on service stack (searxng, context7, lsp-ts, playwright) is
 *  installed and running, and show install instructions when it isn't. */

interface FieldRow {
  id: string;
  label: string;
  get: () => string;
  /** live-apply to the in-memory settings (persisted separately via save) */
  apply: (v: string) => void;
  hint?: () => string;
}

type ServiceState = "connected" | "connecting" | "failed" | "inactive" | "unconfigured";

interface ServiceRow {
  name: string;
  state: ServiceState;
  detail: string;
  instructions: string[];
}

function getSearxngUrl(settings: Settings): string {
  const cfg = settings.mcpServers["searxng"];
  if (cfg && "command" in cfg && cfg.env?.["SEARXNG_URL"]) return cfg.env["SEARXNG_URL"];
  return "http://127.0.0.1:8080";
}

function buildFields(
  settings: Settings,
  client: LlmClient,
  mcp: McpManager,
  onAsyncChange: () => void,
): FieldRow[] {
  const fields: FieldRow[] = [
    {
      id: "llm.baseURL",
      label: "LLM baseURL",
      get: () => settings.baseURL,
      apply: (v) => {
        settings.baseURL = v;
        client.reconfigure();
      },
    },
    {
      id: "llm.model",
      label: "LLM model",
      get: () => settings.model,
      apply: (v) => {
        settings.model = v;
      },
    },
    {
      id: "llm.apiKeyEnv",
      label: "LLM apiKeyEnv",
      get: () => settings.apiKeyEnv,
      apply: (v) => {
        settings.apiKeyEnv = v;
        client.reconfigure();
      },
      hint: () => (process.env[settings.apiKeyEnv] ? "env ✓ set" : "env ✗ NOT SET"),
    },
    {
      id: "llm.contextWindow",
      label: "context window",
      get: () => String(settings.contextWindow),
      apply: (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) settings.contextWindow = Math.floor(n);
      },
    },
    {
      id: "mcp.searxng",
      label: "searxng URL",
      get: () => getSearxngUrl(settings),
      apply: (v) => {
        const cfg = settings.mcpServers["searxng"];
        if (cfg && "command" in cfg) {
          cfg.env = { ...cfg.env, SEARXNG_URL: v };
          void mcp.reconnect("searxng", settings).then(onAsyncChange);
        }
      },
    },
  ];
  for (const [name, preset] of Object.entries(settings.models)) {
    fields.push({
      id: `preset.${name}`,
      label: `preset ${name}`,
      get: () => preset.baseURL,
      apply: (v) => {
        preset.baseURL = v;
      },
      hint: () => preset.model,
    });
  }
  return fields;
}

/** Persist the edited fields into the global settings.json — patch the raw
 *  file, never dump the merged Settings (that would bake built-in MCP servers
 *  and defaults into the user's file). */
function saveGlobal(settings: Settings, dirty: Set<string>): string {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(GLOBAL_SETTINGS)) {
      raw = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf8")) as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  for (const id of dirty) {
    if (id === "llm.baseURL") raw["baseURL"] = settings.baseURL;
    else if (id === "llm.model") raw["model"] = settings.model;
    else if (id === "llm.apiKeyEnv") raw["apiKeyEnv"] = settings.apiKeyEnv;
    else if (id === "llm.contextWindow") raw["contextWindow"] = settings.contextWindow;
    else if (id === "mcp.searxng") {
      const servers = (raw["mcpServers"] ??= {}) as Record<string, unknown>;
      servers["searxng"] = settings.mcpServers["searxng"];
    } else if (id.startsWith("preset.")) {
      const name = id.slice("preset.".length);
      const models = (raw["models"] ??= {}) as Record<string, unknown>;
      models[name] = settings.models[name];
    }
  }
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify(raw, null, 2) + "\n");
  return GLOBAL_SETTINGS;
}

export async function checkServices(
  settings: Settings,
  mcp: McpManager,
  cwd: string,
): Promise<ServiceRow[]> {
  const rows: ServiceRow[] = [];
  const status = (name: string) => mcp.statuses.get(name);
  const npx = Bun.which("npx") !== null;
  const bridgeState = (name: string): string => {
    const s = status(name);
    if (!s) return "bridge not connected";
    return s.state === "connected" ? `running · ${s.toolCount} tools` : `bridge ${s.state}`;
  };

  // searxng — the MCP bridge connects even when the instance is down, so
  // probe the instance itself
  {
    const url = getSearxngUrl(settings);
    let reachable = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      reachable = res.status < 500;
    } catch {
      reachable = false;
    }
    const s = status("searxng");
    const instructions: string[] = [];
    if (!npx) instructions.push("bridge needs npx — install Node.js + npm");
    if (!reachable) {
      instructions.push(
        `no SearXNG answering at ${url} — start one:`,
        "docker run -d --name searxng --restart unless-stopped -p 8080:8080 docker.io/searxng/searxng:latest",
        "then press r to reconnect (or edit the searxng URL above)",
      );
    }
    if (s?.state === "failed" && s.error) instructions.push(`bridge error: ${s.error}`);
    rows.push({
      name: "searxng",
      state: !reachable && s?.state === "connected" ? "failed" : (s?.state ?? "unconfigured"),
      detail: `${bridgeState("searxng")} · instance ${reachable ? "reachable" : "UNREACHABLE"} @ ${url}`,
      instructions,
    });
  }

  // context7 — auto-installs via npx on first connect
  {
    const s = status("context7");
    const instructions: string[] = [];
    if (!npx) instructions.push("needs npx — install Node.js + npm (server auto-installs via `npx -y @upstash/context7-mcp`)");
    if (s?.state === "failed") {
      instructions.push(
        `bridge error: ${s.error ?? "unknown"}`,
        "check network access to registry.npmjs.org, then press r",
      );
    }
    rows.push({
      name: "context7",
      state: s?.state ?? "unconfigured",
      detail: bridgeState("context7"),
      instructions,
    });
  }

  // lsp-ts — needs the mcp-language-server binary + typescript-language-server,
  // and only attaches to projects with a tsconfig.json (marker-file gate)
  {
    const bin = join(homedir(), "go", "bin", "mcp-language-server");
    const haveBin = existsSync(bin);
    const haveTls = Bun.which("typescript-language-server") !== null;
    const gated = !existsSync(join(cwd, "tsconfig.json"));
    const s = status("lsp-ts");
    const instructions: string[] = [];
    if (!haveBin) instructions.push("install the MCP bridge: go install github.com/isaacphi/mcp-language-server@latest");
    if (!haveTls) instructions.push("install the server: npm i -g typescript-language-server typescript");
    if (gated) instructions.push("inactive here: only connects in projects with a tsconfig.json");
    if (s?.state === "failed" && s.error) instructions.push(`bridge error: ${s.error}`);
    rows.push({
      name: "lsp-ts",
      state: s?.state ?? "inactive",
      detail: `${s ? bridgeState("lsp-ts") : gated ? "inactive (no tsconfig.json)" : "not connected"} · binary ${haveBin ? "✓" : "missing"} · typescript-language-server ${haveTls ? "✓" : "missing"}`,
      instructions,
    });
  }

  // playwright — seeded in the global settings.json, not a built-in
  {
    const cfg = settings.mcpServers["playwright"];
    const s = status("playwright");
    const instructions: string[] = [];
    if (!cfg) {
      instructions.push(
        "not configured — add to ~/.config/grayskull/settings.json:",
        '"mcpServers": { "playwright": { "command": "npx",',
        '  "args": ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--headless"] } }',
        "then restart grayskull",
      );
    }
    if (cfg && !npx) instructions.push("needs npx — install Node.js + npm");
    if (s?.state === "failed") {
      instructions.push(
        `bridge error: ${s.error ?? "unknown"}`,
        "if the browser is missing: npx playwright install chrome — then press r",
      );
    }
    rows.push({
      name: "playwright",
      state: s?.state ?? (cfg ? "inactive" : "unconfigured"),
      detail: cfg ? bridgeState("playwright") : "not configured",
      instructions,
    });
  }

  return rows;
}

const STATE_ICON: Record<ServiceState, { icon: string; color: string }> = {
  connected: { icon: "●", color: "green" },
  connecting: { icon: "◐", color: "yellow" },
  failed: { icon: "✗", color: "red" },
  inactive: { icon: "○", color: "gray" },
  unconfigured: { icon: "○", color: "gray" },
};

export interface SetupDialogProps {
  cwd: string;
  settings: Settings;
  mcp: McpManager;
  client: LlmClient;
  onNote: (text: string) => void;
  onClose: () => void;
}

export function SetupDialog(props: SetupDialogProps): React.ReactElement {
  const { cwd, settings, mcp, client, onNote, onClose } = props;
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [checking, setChecking] = useState(true);
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editCur, setEditCur] = useState(0);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const aliveRef = useRef(true);

  const recheck = async (reconnectFailed: boolean): Promise<void> => {
    setChecking(true);
    if (reconnectFailed) {
      const failed = [...mcp.statuses.values()].filter((s) => s.state === "failed").map((s) => s.name);
      await Promise.allSettled(failed.map((n) => mcp.reconnect(n, settings)));
    }
    const rows = await checkServices(settings, mcp, cwd);
    if (!aliveRef.current) return;
    setServices(rows);
    setChecking(false);
  };

  useEffect(() => {
    void recheck(false);
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const fields = buildFields(settings, client, mcp, () => {
    if (aliveRef.current) void recheck(false);
  });

  const startEdit = () => {
    const f = fields[sel];
    if (!f) return;
    const v = f.get();
    setEditValue(v);
    setEditCur(v.length);
    setEditing(true);
  };

  const commitEdit = () => {
    const f = fields[sel];
    setEditing(false);
    if (!f) return;
    const v = editValue.trim();
    if (v === "" || v === f.get()) return;
    try {
      f.apply(v);
      setDirty((prev) => new Set(prev).add(f.id));
    } catch (err) {
      onNote(`setup: could not apply ${f.label}: ${(err as Error).message}`);
    }
  };

  useInput((char, key) => {
    if (editing) {
      if (key.return) return commitEdit();
      if (key.escape) return setEditing(false);
      if (key.leftArrow) return setEditCur((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setEditCur((c) => Math.min(editValue.length, c + 1));
      if (key.ctrl && char === "a") return setEditCur(0);
      if (key.ctrl && char === "e") return setEditCur(editValue.length);
      if (key.backspace || key.delete) {
        if (editCur > 0) {
          setEditValue(editValue.slice(0, editCur - 1) + editValue.slice(editCur));
          setEditCur(editCur - 1);
        }
        return;
      }
      if (char && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        const chunk = char.replace(/\[20[01]~/g, "");
        if (!chunk) return;
        setEditValue(editValue.slice(0, editCur) + chunk + editValue.slice(editCur));
        setEditCur(editCur + chunk.length);
      }
      return;
    }
    if (key.escape || char === "q") return onClose();
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(fields.length - 1, s + 1));
    if (key.return || char === "e") return startEdit();
    if (char === "r") return void recheck(true);
    if (char === "s") {
      if (dirty.size === 0) return onNote("setup: nothing changed — nothing to save");
      try {
        const path = saveGlobal(settings, dirty);
        setDirty(new Set());
        onNote(`setup: saved ${dirty.size} change${dirty.size > 1 ? "s" : ""} → ${path}`);
      } catch (err) {
        onNote(`setup: save failed: ${(err as Error).message}`);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        ⚙ GRAYSKULL setup
      </Text>

      <Box marginTop={1}>
        <Text bold>Endpoints</Text>
        {dirty.size > 0 && <Text color="yellow"> · {dirty.size} unsaved (press s)</Text>}
      </Box>
      {fields.map((f, i) => {
        const isSel = i === sel;
        const isEdit = isSel && editing;
        return (
          <Box key={f.id}>
            <Text color={isSel ? "cyan" : undefined}>
              {isSel ? "▸ " : "  "}
              {f.label.padEnd(20)}
            </Text>
            {isEdit ? (
              <Text>
                {editValue.slice(0, editCur)}
                <Text inverse>{editValue[editCur] ?? " "}</Text>
                {editValue.slice(editCur + 1)}
              </Text>
            ) : (
              <Text color={dirty.has(f.id) ? "yellow" : undefined}>{f.get()}</Text>
            )}
            {!isEdit && f.hint && <Text dimColor>{"  "}{f.hint()}</Text>}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text bold>Services</Text>
        {checking && <Text dimColor> checking…</Text>}
      </Box>
      {services.map((s) => (
        <Box key={s.name} flexDirection="column">
          <Text>
            <Text color={STATE_ICON[s.state].color}>{STATE_ICON[s.state].icon}</Text>
            {" "}
            {s.name.padEnd(12)}
            <Text dimColor>{s.detail}</Text>
          </Text>
          {s.instructions.map((line, i) => (
            <Text key={i} color="yellow" dimColor>
              {"      ↳ "}
              {line}
            </Text>
          ))}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor>
          {editing
            ? "enter apply · esc cancel edit"
            : "↑↓ select · enter edit (applies live) · s save → settings.json · r recheck+reconnect · esc close"}
        </Text>
      </Box>
    </Box>
  );
}
