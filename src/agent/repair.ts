import type { ToolCall } from "../types";
import type { ToolDef } from "../types";
import type { LeakDialect } from "../llm/profiles";
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
 * Recover a tool call the model emitted as plain text instead of a real
 * tool_calls entry. The leakage format is family-specific:
 *
 *  - "qwen": JSON, in a ```json fence or `<tool_call>{...}</tool_call>` block.
 *  - "glm" : GLM-4.5's XML-ish form (NOT JSON), e.g.
 *        <tool_call>read
 *        <arg_key>path</arg_key>
 *        <arg_value>x.ts</arg_value>
 *        </tool_call>
 *
 * The GLM path is tried first when that dialect is selected, then the JSON path
 * is always tried as a fallback (cheap, and a GLM model can still leak JSON).
 */
export function recoverTextToolCall(
  text: string,
  knownTools: Set<string>,
  dialect: LeakDialect = "qwen",
): ToolCall | null {
  if (dialect === "glm") {
    const glm = recoverGlmToolCall(text, knownTools);
    if (glm) return glm;
  }
  return recoverJsonToolCall(text, knownTools);
}

function recoverJsonToolCall(text: string, knownTools: Set<string>): ToolCall | null {
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

/**
 * GLM-4.5 format: `<tool_call>NAME` then one or more
 * `<arg_key>K</arg_key><arg_value>V</arg_value>` pairs, closed by `</tool_call>`.
 * Values are typed loosely (JSON.parse when it parses, else the raw string) to
 * match the glm45 parser's behaviour. Delimiters per the vLLM glm4_moe parser
 * and the GLM chat template.
 */
function recoverGlmToolCall(text: string, knownTools: Set<string>): ToolCall | null {
  for (const block of text.matchAll(/<tool_call>\s*([\s\S]*?)<\/tool_call>/g)) {
    const body = block[1] ?? "";
    // function name = first non-empty token before the first <arg_key>
    const head = body.slice(0, body.search(/<arg_key>/i));
    const name = head.replace(/[\r\n]/g, " ").trim().split(/\s/)[0];
    if (!name || !knownTools.has(name)) continue;
    const args: Record<string, unknown> = {};
    const pairRe = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
    for (const p of body.matchAll(pairRe)) {
      const key = (p[1] ?? "").trim();
      const rawVal = (p[2] ?? "").trim();
      if (!key) continue;
      try {
        args[key] = JSON.parse(rawVal);
      } catch {
        args[key] = rawVal;
      }
    }
    return {
      id: "recovered_0",
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  }
  return null;
}
