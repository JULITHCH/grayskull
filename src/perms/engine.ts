import type { PermissionMode, ToolDef } from "../types";
import type { Settings } from "../config/settings";

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask" };

/**
 * Pattern grammar (same shape as Claude Code):
 *   "bash(git *)"  — bash tool, command matching the glob-ish prefix
 *   "edit"         — any call of the edit tool
 *   "mcp__searxng__*" — any tool whose NAME matches the glob
 */
function matchPattern(pattern: string, toolName: string, callDesc: string): boolean {
  const m = pattern.match(/^([^(]+)\((.*)\)$/);
  if (m) {
    const [, patTool, patArg] = m;
    if (!globMatch(patTool!.trim(), toolName)) return false;
    // callDesc looks like `bash(git status)` — extract the inner part
    const inner = callDesc.slice(callDesc.indexOf("(") + 1, -1);
    return globMatch(patArg!, inner);
  }
  return globMatch(pattern, toolName);
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map(escapeRe).join(".*") + "$",
  );
  return re.test(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PermissionEngine {
  mode: PermissionMode;
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
    this.mode = settings.defaultMode;
  }

  /** Session-scoped "always allow" entries added from the permission prompt. */
  private sessionAllow: string[] = [];

  allowForSession(pattern: string): void {
    this.sessionAllow.push(pattern);
  }

  decide(tool: ToolDef, args: Record<string, unknown>): PermissionDecision {
    const callDesc = tool.describeCall(args);
    const { allow, deny } = this.settings.permissions;

    for (const p of deny) {
      if (matchPattern(p, tool.name, callDesc)) {
        return { kind: "deny", reason: `blocked by deny rule "${p}"` };
      }
    }

    if (this.mode === "plan" && tool.kind !== "read") {
      return {
        kind: "deny",
        reason: "plan mode: read-only. Present your plan as text; the user will switch modes to execute.",
      };
    }

    if (tool.kind === "read") return { kind: "allow" };
    if (this.mode === "kamikazeee") return { kind: "allow" };

    for (const p of [...allow, ...this.sessionAllow]) {
      if (matchPattern(p, tool.name, callDesc)) return { kind: "allow" };
    }

    if (this.mode === "accept-edits" && tool.kind === "edit") return { kind: "allow" };

    return { kind: "ask" };
  }
}
