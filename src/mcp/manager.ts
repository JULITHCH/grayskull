import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, Settings } from "../config/settings";
import type { ToolDef } from "../types";
import type { ToolRegistry } from "../tools";

export interface McpServerStatus {
  name: string;
  state: "connected" | "failed" | "connecting";
  toolCount: number;
  error?: string;
}

export class McpManager {
  private clients = new Map<string, Client>();
  readonly statuses = new Map<string, McpServerStatus>();
  private registry: ToolRegistry;
  onChange?: () => void;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** Connect all configured servers; failures are reported, never fatal. */
  async connectAll(settings: Settings): Promise<void> {
    await Promise.allSettled(
      Object.entries(settings.mcpServers).map(([name, cfg]) =>
        this.connect(name, cfg),
      ),
    );
  }

  async connect(name: string, cfg: McpServerConfig): Promise<void> {
    this.statuses.set(name, { name, state: "connecting", toolCount: 0 });
    this.onChange?.();
    try {
      const client = new Client({ name: "grayskull", version: "0.1.0" });
      const transport =
        "url" in cfg
          ? new StreamableHTTPClientTransport(new URL(cfg.url), {
              requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
            })
          : new StdioClientTransport({
              command: cfg.command,
              args: cfg.args ?? [],
              env: { ...process.env as Record<string, string>, ...cfg.env },
              stderr: "ignore",
            });
      await client.connect(transport);
      this.clients.set(name, client);

      const { tools } = await client.listTools();
      this.registry.unregisterPrefix(`mcp__${name}__`);
      for (const t of tools) {
        this.registry.register(mcpToolDef(name, client, t.name, t.description ?? "", t.inputSchema as Record<string, unknown>, t.annotations?.readOnlyHint === true));
      }
      this.statuses.set(name, { name, state: "connected", toolCount: tools.length });
    } catch (err) {
      this.statuses.set(name, {
        name,
        state: "failed",
        toolCount: 0,
        error: (err as Error).message,
      });
    }
    this.onChange?.();
  }

  async reconnect(name: string, settings: Settings): Promise<void> {
    const cfg = settings.mcpServers[name];
    if (!cfg) return;
    await this.clients.get(name)?.close().catch(() => {});
    this.clients.delete(name);
    await this.connect(name, cfg);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }
}

function mcpToolDef(
  server: string,
  client: Client,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  readOnly: boolean,
): ToolDef {
  const name = `mcp__${server}__${toolName}`;
  return {
    name,
    description: description.slice(0, 1024) || `${toolName} (from MCP server ${server})`,
    // searxng is search/fetch only; other servers are read-only only if they say so
    kind: readOnly || server === "searxng" ? "read" : "execute",
    jsonSchema: inputSchema,
    describeCall: (args) => `${name}(${JSON.stringify(args).slice(0, 80)})`,
    execute: async (args) => {
      const result = await client.callTool({ name: toolName, arguments: args });
      const parts: string[] = [];
      for (const item of (result.content ?? []) as Array<Record<string, unknown>>) {
        if (item["type"] === "text") parts.push(String(item["text"]));
        else parts.push(JSON.stringify(item));
      }
      let out = parts.join("\n");
      if (out.length > 30_000) out = out.slice(0, 30_000) + "\n[truncated]";
      return out || "(empty result)";
    },
  };
}
