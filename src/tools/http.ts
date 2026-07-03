import { z } from "zod";
import type { ToolDef } from "../types";

const MAX_BODY = 20_000;

const schema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method."),
  url: z.string().url().describe("Full request URL, e.g. https://discord.com/api/v10/channels/123/messages"),
  headers: z.record(z.string(), z.string()).optional().describe("Request headers, e.g. { \"Authorization\": \"Bot <token>\" }. Content-Type is set automatically when json_body is given."),
  json_body: z.unknown().optional().describe("Request body as a JSON VALUE (object/array) — it is serialized and sent as application/json. Prefer this for any API call: it eliminates all shell-quoting/escaping problems. Pass the actual structure, e.g. { \"content\": \"text with 'quotes' and\\nnewlines\" }."),
  body: z.string().optional().describe("Raw string body — only for non-JSON payloads (form-encoded, plain text). Use json_body for JSON."),
  timeout_seconds: z.number().int().min(1).max(120).optional().describe("Abort after this many seconds (default 30)."),
});

/**
 * Structured HTTP for workers/agents: the model passes a JSON value, we
 * serialize and send it. Nothing touches a shell, so quotes, apostrophes,
 * newlines and unicode in the payload can never break escaping — the failure
 * mode of hand-built `curl -d '{...}'` commands.
 */
export const httpTool: ToolDef = {
  name: "http_request",
  description:
    "Make an HTTP request to an API and return status + response body. ALWAYS prefer this over curl for calling web APIs: pass the request body as `json_body` (a real JSON object) and it is serialized safely — no shell quoting, so quotes/apostrophes/newlines/unicode in the payload never break the request. Use bash+curl only when you need something this can't express.",
  kind: "execute",
  schema,
  describeCall: (args) => `http_request(${String(args["method"] ?? "GET")} ${String(args["url"] ?? "")})`,
  execute: async (args, ctx) => {
    const { method, url, headers, json_body, body, timeout_seconds } = schema.parse(args);
    const h: Record<string, string> = { ...(headers ?? {}) };
    let payload: string | undefined;
    if (json_body !== undefined) {
      payload = JSON.stringify(json_body);
      if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type")) {
        h["Content-Type"] = "application/json";
      }
    } else if (body !== undefined) {
      payload = body;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (timeout_seconds ?? 30) * 1000);
    // chain the caller's interrupt signal if present
    const onAbort = () => ac.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method,
        headers: h,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: ac.signal,
      });
      let text = await res.text();
      if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY) + `\n…[truncated ${text.length - MAX_BODY} chars]`;
      const ok = res.ok ? "OK" : "ERROR";
      return `${ok} ${res.status} ${res.statusText}\n${text || "(empty response body)"}`;
    } catch (err) {
      if (ac.signal.aborted && !ctx.signal?.aborted) {
        return `error: request to ${url} timed out after ${timeout_seconds ?? 30}s`;
      }
      return `error: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};
