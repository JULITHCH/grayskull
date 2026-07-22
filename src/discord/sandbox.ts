import { resolve, sep } from "node:path";
import { PermissionEngine, type PermissionDecision } from "../perms/engine";
import type { Settings } from "../config/settings";
import type { ToolDef } from "../types";

/** File tools whose `path` argument must stay inside the bot directory. A
 *  missing path defaults to the tool ctx.cwd (= the bot dir), which is fine. */
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "glob"]);

/** Web-facing tools the bot may always use (searches + fetches). */
const WEB_TOOL_RE = /^mcp__(searxng|context7)__/;

/**
 * Permission engine for the Discord bot: a hard sandbox instead of the
 * interactive ask flow. The bot may read/write ONLY inside its bot directory,
 * search the web, and make HTTP requests — everything else is denied outright
 * (there is no human watching to approve prompts, so nothing ever "asks").
 */
export class SandboxPermissionEngine extends PermissionEngine {
  private readonly root: string;

  constructor(settings: Settings, root: string) {
    super(settings);
    this.root = resolve(root);
  }

  override decide(tool: ToolDef, args: Record<string, unknown>): PermissionDecision {
    if (WEB_TOOL_RE.test(tool.name)) return { kind: "allow" };
    if (tool.name === "http_request" || tool.name === "todo") return { kind: "allow" };
    if (FILE_TOOLS.has(tool.name)) {
      const path = args["path"];
      if (path === undefined || this.inside(String(path))) return { kind: "allow" };
      return {
        kind: "deny",
        reason: `sandbox: only files inside your bot directory (${this.root}) are accessible — use relative paths`,
      };
    }
    return { kind: "deny", reason: `sandbox: the "${tool.name}" tool is not available to the Discord bot` };
  }

  private inside(path: string): boolean {
    const full = resolve(this.root, path);
    return full === this.root || full.startsWith(this.root + sep);
  }
}
