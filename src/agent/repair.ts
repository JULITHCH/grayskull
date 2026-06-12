import type { ToolCall } from "../types";
import type { ToolDef } from "../types";
import { ZodError } from "zod";

/**
 * Weak-model accommodations for tool calling:
 *  - validate args against the tool's zod schema and produce an actionable
 *    error message the model can correct from (fed back as the tool result)
 *  - recover tool calls that local models sometimes emit as plain text
 *    (a fenced JSON block instead of a real tool_calls entry)
 */

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

export function validateCall(tool: ToolDef, rawArgs: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
  } catch (err) {
    return {
      ok: false,
      error: `Your arguments for ${tool.name} were not valid JSON (${(err as Error).message}). Re-emit the tool call with correct JSON. Do not write the call as text.`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `Arguments for ${tool.name} must be a JSON object.` };
  }
  if (!tool.schema) return { ok: true, args: parsed as Record<string, unknown> };
  const result = tool.schema.safeParse(parsed);
  if (result.success) return { ok: true, args: result.data as Record<string, unknown> };
  const issues = (result.error as ZodError).issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  return {
    ok: false,
    error: `Invalid arguments for ${tool.name}:\n${issues}\nRe-emit the tool call with corrected arguments.`,
  };
}

/**
 * Detect a tool call written as text, e.g.
 *   ```json
 *   {"name": "read", "arguments": {"path": "x.ts"}}
 *   ```
 * or `<tool_call>{...}</tool_call>` leakage from Qwen-style templates.
 */
export function recoverTextToolCall(
  text: string,
  knownTools: Set<string>,
): ToolCall | null {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(m[1]!);
  }
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    candidates.push(m[1]!);
  }
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
      const name = (obj["name"] ?? obj["tool"] ?? obj["function"]) as string | undefined;
      if (!name || !knownTools.has(name)) continue;
      const args = obj["arguments"] ?? obj["parameters"] ?? obj["args"] ?? {};
      return {
        id: "recovered_0",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      };
    } catch {
      // not JSON — keep scanning
    }
  }
  return null;
}
