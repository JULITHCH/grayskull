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
 * Make a tool call safe to store in history and REPLAY. GLM's vLLM server
 * re-parses each prior tool call's `arguments` with json.loads when rendering
 * the next request, and 400s on malformed/truncated JSON (a known GLM-4.5
 * streaming quirk emits incomplete argument strings). Valid JSON is kept
 * verbatim; empty or unparseable arguments are coerced to `{}` so the replay
 * never fails. The original (possibly malformed) args still drive validateCall
 * for execution, so the model still gets a useful repair message.
 */
export function sanitizeToolCallArgs(call: ToolCall): ToolCall {
  const trimmed = (call.function.arguments ?? "").trim();
  if (trimmed) {
    try {
      JSON.parse(trimmed);
      return call;
    } catch {
      // fall through to coercion
    }
  }
  return { ...call, function: { ...call.function, arguments: "{}" } };
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
  const json = recoverJsonToolCall(text, knownTools);
  if (json) return json;
  // last resort: the loose XML-ish dialect some Qwen3.6 builds derail into
  return recoverXmlNamedToolCall(text, knownTools);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** First known-tool marker at/after `from`, written as `[name]` or `<name …>`. */
function findToolMarker(
  text: string,
  knownTools: Set<string>,
  from = 0,
): { name: string; start: number; end: number } | null {
  let best: { name: string; start: number; end: number } | null = null;
  for (const t of knownTools) {
    const re = new RegExp(`\\[${escapeRe(t)}\\]|<${escapeRe(t)}(?:\\s[^>]*)?>`, "g");
    re.lastIndex = from;
    const m = re.exec(text);
    if (m && (best === null || m.index < best.start)) {
      best = { name: t, start: m.index, end: m.index + m[0].length };
    }
  }
  return best;
}

function coerceArg(args: Record<string, unknown>, key: string, raw: string): void {
  const v = raw.trim();
  try {
    args[key] = JSON.parse(v);
  } catch {
    args[key] = v;
  }
}

/**
 * Recover a tool call emitted in the loose XML-ish dialect some Qwen3.6 builds
 * fall into mid-stream: the tool name in [brackets] or <angle> tags, then one
 * argument tag per field — either `<key>value</key>` or
 * `<parameter name="key">value</parameter>`. Tolerant of the stray `</think>`
 * / `</parameter>` fragments these glitches sprinkle in. Only fires when the
 * leading token is a known tool and at least one argument tag follows; args are
 * scoped to the first call (cut at the next tool marker) so chained leaks don't
 * bleed together.
 */
function recoverXmlNamedToolCall(text: string, knownTools: Set<string>): ToolCall | null {
  const marker = findToolMarker(text, knownTools);
  if (!marker) return null;
  const next = findToolMarker(text, knownTools, marker.end);
  const segment = text.slice(marker.end, next ? next.start : undefined);
  const args: Record<string, unknown> = {};
  for (const m of segment.matchAll(/<parameter\s+name=["']?([\w-]+)["']?\s*>([\s\S]*?)<\/parameter>/gi)) {
    coerceArg(args, m[1]!, m[2]!);
  }
  for (const m of segment.matchAll(/<([\w-]+)>([\s\S]*?)<\/\1>/g)) {
    const key = m[1]!;
    if (key === "parameter" || key === "think" || knownTools.has(key) || key in args) continue;
    coerceArg(args, key, m[2]!);
  }
  if (Object.keys(args).length === 0) return null;
  return {
    id: "recovered_0",
    type: "function",
    function: { name: marker.name, arguments: JSON.stringify(args) },
  };
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
