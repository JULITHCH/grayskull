import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Settings, ModelPreset } from "../config/settings";
import { GLOBAL_SETTINGS } from "../config/paths";
import type { McpManager } from "../mcp/manager";
import type { LlmClient } from "../llm/client";

/** UI-agnostic /setup logic, shared by the Ink dialog (ui/setup.tsx) and the
 *  web UI modal (web/session.ts).
 *
 *  Everything is schema-driven: PRESET_SPEC / ACTIVE_SPEC describe the fields
 *  of an LLM (kind, label, options); both UIs render whatever the specs list
 *  and applyField/saveGlobal handle any spec key generically. Extending the
 *  configuration = adding one FieldSpec line. */

export type FieldKind = "text" | "number" | "enum" | "toggle";

export interface FieldSpec {
  /** settings/preset property name */
  key: string;
  label: string;
  kind: FieldKind;
  /** for kind "enum" */
  options?: readonly string[];
  /** short explainer shown next to the field */
  help?: string;
  /** number/text may be cleared (removes the key from a preset) */
  optional?: boolean;
}

/** model families — the tool-call leak dialect + chain sampling presets
 *  (llm/profiles.ts); mirrored by the zod enum in config/settings.ts */
export const FAMILIES = ["qwen3.5", "glm4.5"] as const;

/** What an LLM preset consists of. Extend here — TUI, web modal and
 *  persistence pick the new field up automatically. */
export const PRESET_SPEC: readonly FieldSpec[] = [
  { key: "family", label: "family", kind: "enum", options: FAMILIES, help: "tool-call format + thinking presets" },
  { key: "baseURL", label: "endpoint", kind: "text", help: "OpenAI-compatible /v1 URL" },
  { key: "model", label: "model id", kind: "text", help: "as served by vLLM" },
  { key: "apiKeyEnv", label: "api key env", kind: "text", optional: true, help: "env var holding the key" },
  { key: "contextWindow", label: "context window", kind: "number", optional: true },
  { key: "maxTokens", label: "max output tokens", kind: "number", optional: true },
  { key: "temperature", label: "temperature", kind: "number", optional: true },
  { key: "topP", label: "top_p", kind: "number", optional: true },
  { key: "topK", label: "top_k", kind: "number", optional: true },
  { key: "enableThinking", label: "thinking", kind: "toggle", optional: true },
] as const;

/** The live stack (top-level settings keys). Same shape as a preset, but
 *  edits apply to the running session immediately. */
export const ACTIVE_SPEC: readonly FieldSpec[] = [
  { key: "modelFamily", label: "family", kind: "enum", options: FAMILIES, help: "tool-call format + thinking presets" },
  { key: "baseURL", label: "endpoint", kind: "text", help: "OpenAI-compatible /v1 URL" },
  { key: "model", label: "model id", kind: "text" },
  { key: "apiKeyEnv", label: "api key env", kind: "text", help: "env var holding the key" },
  { key: "contextWindow", label: "context window", kind: "number" },
  { key: "maxTokens", label: "max output tokens", kind: "number" },
  { key: "temperature", label: "temperature", kind: "number" },
  { key: "topP", label: "top_p", kind: "number" },
  { key: "topK", label: "top_k", kind: "number" },
  { key: "enableThinking", label: "thinking", kind: "toggle" },
] as const;

export interface SetupField {
  /** "active.<key>" | "preset.<name>.<key>" | "mcp.searxng.url" */
  id: string;
  label: string;
  kind: FieldKind;
  value: string;
  options?: readonly string[];
  hint?: string;
}

export interface SetupGroup {
  id: string;
  title: string;
  /** preset name when the group can be removed (LLM presets) */
  removable?: string;
  fields: SetupField[];
}

export type ServiceState = "connected" | "connecting" | "failed" | "inactive" | "unconfigured";

export interface ServiceRow {
  name: string;
  state: ServiceState;
  detail: string;
  instructions: string[];
}

export function getSearxngUrl(settings: Settings): string {
  const cfg = settings.mcpServers["searxng"];
  if (cfg && "command" in cfg && cfg.env?.["SEARXNG_URL"]) return cfg.env["SEARXNG_URL"];
  return "http://127.0.0.1:8080";
}

function fieldValue(source: Record<string, unknown>, spec: FieldSpec): string {
  const v = source[spec.key];
  if (v === undefined || v === null) return "";
  if (spec.kind === "toggle") return v ? "on" : "off";
  return String(v);
}

function specFields(prefix: string, spec: readonly FieldSpec[], source: Record<string, unknown>): SetupField[] {
  return spec.map((f) => {
    const field: SetupField = {
      id: `${prefix}.${f.key}`,
      label: f.label,
      kind: f.kind,
      value: fieldValue(source, f),
    };
    if (f.options) field.options = f.options;
    let hint = f.help;
    // surface whether the configured api-key env var actually exists
    if (f.key.toLowerCase().includes("apikeyenv")) {
      const env = String(source[f.key] ?? "");
      if (env) hint = process.env[env] ? "env ✓ set" : "env ✗ NOT SET";
    }
    if (hint) field.hint = hint;
    return field;
  });
}

/** Serializable group descriptors — the same dialog in the TUI and browser. */
export function listGroups(settings: Settings): SetupGroup[] {
  const groups: SetupGroup[] = [
    {
      id: "active",
      title: "ACTIVE MODEL (edits apply live)",
      fields: specFields("active", ACTIVE_SPEC, settings as unknown as Record<string, unknown>),
    },
  ];
  for (const [name, preset] of Object.entries(settings.models)) {
    const isActive = preset.baseURL === settings.baseURL && preset.model === settings.model;
    groups.push({
      id: `preset.${name}`,
      title: `LLM ${name}${isActive ? " ● active" : ""}`,
      removable: name,
      fields: specFields(`preset.${name}`, PRESET_SPEC, preset as unknown as Record<string, unknown>),
    });
  }
  groups.push({
    id: "web",
    title: "WEB SEARCH",
    fields: [
      { id: "mcp.searxng.url", label: "searxng URL", kind: "text", value: getSearxngUrl(settings) },
    ],
  });
  return groups;
}

/** Coerce a raw string to the spec's type; null = invalid. Empty string on an
 *  optional field means "unset". */
function coerce(spec: FieldSpec, raw: string): string | number | boolean | null | undefined {
  const v = raw.trim();
  if (v === "") return spec.optional ? undefined : null;
  switch (spec.kind) {
    case "text":
      return v;
    case "enum":
      return spec.options?.includes(v) ? v : null;
    case "number": {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "toggle":
      return /^(on|true|1|yes)$/i.test(v) ? true : /^(off|false|0|no)$/i.test(v) ? false : null;
  }
}

export interface ApplyContext {
  settings: Settings;
  client: LlmClient;
  mcp: McpManager;
  /** called after async side effects (searxng reconnect) settle */
  onAsyncChange?: () => void;
}

/** Live-apply one field edit to the in-memory settings. Returns false when the
 *  id is unknown or the value is invalid; persistence is a separate save. */
export function applyField(id: string, value: string, ctx: ApplyContext): boolean {
  const { settings, client, mcp } = ctx;

  if (id === "mcp.searxng.url") {
    const v = value.trim();
    const cfg = settings.mcpServers["searxng"];
    if (!v || !cfg || !("command" in cfg)) return false;
    cfg.env = { ...cfg.env, SEARXNG_URL: v };
    void mcp.reconnect("searxng", settings).then(() => ctx.onAsyncChange?.());
    return true;
  }

  const active = id.match(/^active\.(\w+)$/);
  if (active) {
    const spec = ACTIVE_SPEC.find((f) => f.key === active[1]);
    if (!spec) return false;
    const v = coerce(spec, value);
    if (v === null || v === undefined) return false; // active fields are never unset
    (settings as unknown as Record<string, unknown>)[spec.key] = v;
    // endpoint/key changes need a fresh connection
    if (spec.key === "baseURL" || spec.key === "apiKeyEnv") client.reconfigure();
    return true;
  }

  const preset = id.match(/^preset\.([^.]+)\.(\w+)$/);
  if (preset) {
    const p = settings.models[preset[1]!];
    const spec = PRESET_SPEC.find((f) => f.key === preset[2]);
    if (!p || !spec) return false;
    const v = coerce(spec, value);
    if (v === null) return false;
    const rec = p as unknown as Record<string, unknown>;
    if (v === undefined) delete rec[spec.key];
    else rec[spec.key] = v;
    return true;
  }

  return false;
}

/** Add a new /model preset cloned from the active stack. Returns the
 *  normalized name, or null when the name is empty/taken. */
export function addPreset(settings: Settings, name: string): string | null {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!n || settings.models[n]) return null;
  const preset: ModelPreset = {
    family: settings.modelFamily,
    baseURL: settings.baseURL,
    model: settings.model,
    apiKeyEnv: settings.apiKeyEnv,
    contextWindow: settings.contextWindow,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    topP: settings.topP,
    topK: settings.topK,
  };
  settings.models[n] = preset;
  return n;
}

/** Remove a preset — grayskull's seeded defaults included. Once the models
 *  record is saved, settings.json owns it entirely (zod's defaults only apply
 *  while the key is absent), so removed defaults stay gone. */
export function removePreset(settings: Settings, name: string): boolean {
  if (!settings.models[name]) return false;
  delete settings.models[name];
  return true;
}

/** Persist the edited fields into the global settings.json — patch the raw
 *  file, never dump the merged Settings (that would bake built-in MCP servers
 *  and defaults into the user's file). */
export function saveGlobal(settings: Settings, dirty: Set<string>): string {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(GLOBAL_SETTINGS)) {
      raw = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf8")) as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  for (const id of dirty) {
    const active = id.match(/^active\.(\w+)$/);
    if (active && ACTIVE_SPEC.some((f) => f.key === active[1])) {
      raw[active[1]!] = (settings as unknown as Record<string, unknown>)[active[1]!];
    } else if (id === "mcp.searxng.url") {
      const servers = (raw["mcpServers"] ??= {}) as Record<string, unknown>;
      servers["searxng"] = settings.mcpServers["searxng"];
    } else if (id === "models" || id.startsWith("preset.")) {
      // presets are saved as the whole record: settings.json then owns the
      // list, which is what makes deleting a seeded default stick
      raw["models"] = settings.models;
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
        "then recheck (or edit the searxng URL above)",
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
        "check network access to registry.npmjs.org, then recheck",
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
        "if the browser is missing: npx playwright install chrome — then recheck",
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

/** Reconnect every failed MCP server, then re-run all checks. */
export async function recheckServices(
  settings: Settings,
  mcp: McpManager,
  cwd: string,
  reconnectFailed: boolean,
): Promise<ServiceRow[]> {
  if (reconnectFailed) {
    const failed = [...mcp.statuses.values()].filter((s) => s.state === "failed").map((s) => s.name);
    await Promise.allSettled(failed.map((n) => mcp.reconnect(n, settings)));
  }
  return checkServices(settings, mcp, cwd);
}
