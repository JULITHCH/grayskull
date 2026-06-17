import type OpenAI from "openai";
import type { ZodType } from "zod";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

export type PermissionMode = "normal" | "accept-edits" | "plan" | "kamikazeee";

export const MODE_ORDER: PermissionMode[] = [
  "normal",
  "accept-edits",
  "plan",
  "kamikazeee",
];

/** What a tool does to the world — drives permission decisions per mode. */
export type ToolKind = "read" | "edit" | "execute";

export interface ToolContext {
  cwd: string;
  /** Ask the human a question mid-task; resolves with their answer. */
  askUser: (question: string, options?: string[]) => Promise<string>;
  /** Emit a progress note to the transcript. */
  note: (text: string) => void;
  /** Fires when the user interrupts (esc) — long-running tools must stop. */
  signal?: AbortSignal;
}

export interface ToolDef {
  name: string;
  description: string;
  kind: ToolKind;
  /** zod schema for args; MCP tools carry a raw JSON schema instead. */
  schema?: ZodType;
  jsonSchema?: Record<string, unknown>;
  /** Human-readable one-liner for the permission prompt, e.g. `bash(git status)`. */
  describeCall: (args: Record<string, unknown>) => string;
  /** Optional rich preview (e.g. a diff) shown in the permission prompt. */
  previewCall?: (args: Record<string, unknown>, cwd: string) => Promise<string | undefined>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export type TranscriptItem =
  | { type: "user"; text: string; images?: string[] }
  | { type: "assistant"; text: string; streaming?: boolean }
  | { type: "tool"; name: string; detail: string; preview?: string; result?: string; state: "running" | "done" | "error" | "denied" }
  | { type: "ask"; question: string; answer?: string }
  | { type: "note"; text: string }
  | { type: "banner"; text: string; color?: string };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Live sub-agent activity, consumed by the web UI's agent mesh. */
export type AgentMonitorEvent =
  | { kind: "spawn"; id: string; agent: string; task: string }
  | { kind: "tool"; id: string; agent: string; detail: string; state: string }
  | { kind: "delta"; id: string; agent: string; text: string }
  | { kind: "done"; id: string; agent: string; report: string };

export interface AgentDef {
  name: string;
  description: string;
  /** tool names this agent may use; defaults to read-only set */
  tools: string[];
  systemPrompt: string;
  scope: "global" | "local";
  filePath: string;
}
