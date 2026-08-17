/**
 * OpenAPI 3.1 description of grayskull's OpenAI-compatible API + the Swagger UI
 * page that renders it. The spec is what another tool imports; the page is for
 * humans (and for "Try it out" — the browser is already cookie-authenticated).
 *
 * Swagger UI itself is loaded from a CDN. If it can't be reached (offline box),
 * the page falls back to a plain built-in renderer of the same spec, so the
 * endpoint documentation is never unavailable.
 */

const CHAT_REQUEST = {
  type: "object",
  required: ["messages"],
  properties: {
    model: {
      type: "string",
      default: "grayskull",
      description:
        "`grayskull` runs a full agent turn (tools, skills, sub-agents). `grayskull-raw` is a plain completion against the configured model. " +
        "Append `:<preset>` to pick an LLM preset (see GET /v1/models). An unknown id falls back to `grayskull` and sets the `x-grayskull-model-fallback` response header.",
    },
    messages: {
      type: "array",
      description:
        "Standard OpenAI messages. The LAST user message is the turn; everything else is history (the API is stateless — send the whole conversation each time). " +
        "`content` may be a string or an array of `text` / `image_url` parts; images are passed to the model as vision input.",
      items: {
        type: "object",
        required: ["role"],
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }, { type: "null" }] },
          name: { type: "string" },
          tool_call_id: { type: "string" },
          tool_calls: { type: "array", items: { type: "object" } },
        },
      },
    },
    web_search: {
      type: "boolean",
      default: false,
      description:
        "grayskull extension: allow the agent to use the web-search tools (searxng) for THIS request. Off by default — the operator can flip the default in ⚙ settings → API. " +
        "OpenAI's `web_search_options` object is accepted as an equivalent opt-in.",
    },
    web_search_options: { type: "object", description: "Accepted as an alias for `web_search: true`." },
    stream: { type: "boolean", default: false, description: "Server-sent events, OpenAI chunk format, terminated by `data: [DONE]`." },
    stream_options: {
      type: "object",
      properties: { include_usage: { type: "boolean" } },
      description: "`include_usage: true` appends a final usage-only chunk.",
    },
    temperature: { type: "number", description: "Honored per request (transient override of the configured sampling)." },
    top_p: { type: "number", description: "Honored per request." },
    max_tokens: { type: "integer", description: "Honored as a per-request cap on the model's output (also `max_completion_tokens`)." },
    max_completion_tokens: { type: "integer" },
    stop: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 4 }],
      description: "Honored — the answer is cut at the first match, streaming included.",
    },
    n: { type: "integer", default: 1, description: "Must be 1: one request is one agent turn." },
    tools: {
      type: "array",
      items: { type: "object" },
      description:
        "Caller-supplied tools. grayskull cannot execute them, so a request carrying `tools` is served in RAW mode: the model's tool calls come back verbatim with `finish_reason: \"tool_calls\"` and you run them. " +
        "Without this field the agent uses its OWN tools (files, bash, skills, sub-agents) inside its sandbox.",
    },
    tool_choice: { oneOf: [{ type: "string" }, { type: "object" }] },
    response_format: {
      type: "object",
      description: "`json_object` / `json_schema` are honored best-effort by instructing the model to emit a single JSON value.",
    },
    user: { type: "string", description: "Accepted and ignored." },
    seed: { type: "integer", description: "Accepted and ignored (the upstream server decides)." },
    logit_bias: { type: "object", description: "Accepted and ignored." },
    presence_penalty: { type: "number", description: "Accepted and ignored." },
    frequency_penalty: { type: "number", description: "Accepted and ignored." },
  },
} as const;

const CHAT_RESPONSE = {
  type: "object",
  properties: {
    id: { type: "string", example: "chatcmpl-6f1c…" },
    object: { type: "string", example: "chat.completion" },
    created: { type: "integer" },
    model: { type: "string" },
    system_fingerprint: { type: "string", example: "grayskull" },
    choices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          message: {
            type: "object",
            properties: {
              role: { type: "string", example: "assistant" },
              content: { type: ["string", "null"] },
              tool_calls: { type: "array", items: { type: "object" } },
            },
          },
          finish_reason: { type: "string", enum: ["stop", "length", "tool_calls"] },
          logprobs: { type: ["object", "null"] },
        },
      },
    },
    usage: {
      type: "object",
      description: "Exact in raw mode. For an agent turn (many model calls) prompt/completion tokens are estimates.",
      properties: {
        prompt_tokens: { type: "integer" },
        completion_tokens: { type: "integer" },
        total_tokens: { type: "integer" },
      },
    },
    x_grayskull: {
      type: "object",
      description: "Extension: what the harness actually did.",
      properties: {
        mode: { type: "string", enum: ["agent", "raw"] },
        web_search: { type: "boolean" },
        tools_used: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
    },
  },
} as const;

const ERROR_RESPONSE = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        message: { type: "string" },
        type: { type: "string" },
        param: { type: ["string", "null"] },
        code: { type: ["string", "null"] },
      },
    },
  },
} as const;

export function openApiSpec(origin: string, modelIds: string[]): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "GRAYSKULL — OpenAI-compatible API",
      version: "1.0.0",
      description:
        "Drive the grayskull agent from any OpenAI-compatible client: point the client's base URL at `" + origin + "/v1` " +
        "and use a key generated in grayskull-web (⚙ settings → API → + GENERATE KEY).\n\n" +
        "**Two modes.** `grayskull` runs a real agent turn — it reads files, greps, runs skills and sub-agents inside its working directory, " +
        "then answers. `grayskull-raw` skips the agent and talks to the configured local model directly.\n\n" +
        "**Web search is OFF by default.** Send `\"web_search\": true` to allow the searxng tools for a request.\n\n" +
        "**Permissions.** API turns are read-only by default: the agent may read and search, but not write files or run commands. " +
        "The operator can switch this to `full` in ⚙ settings → API.\n\n" +
        "**Statelessness.** Like OpenAI, every request carries its full message history; nothing is remembered between calls " +
        "(unless the operator enables project memory for the API).",
    },
    servers: [{ url: origin, description: "this grayskull-web instance" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "chat", description: "Chat completions — the endpoint other tools connect to" },
      { name: "models", description: "What this instance can run" },
    ],
    paths: {
      "/v1/chat/completions": {
        post: {
          tags: ["chat"],
          summary: "Create a chat completion (runs a grayskull agent turn)",
          operationId: "createChatCompletion",
          requestBody: { required: true, content: { "application/json": { schema: CHAT_REQUEST } } },
          responses: {
            "200": {
              description: "Completion, or an SSE stream when `stream: true`.",
              content: {
                "application/json": { schema: CHAT_RESPONSE },
                "text/event-stream": {
                  schema: { type: "string", description: "`data: {chunk}` lines, `object: \"chat.completion.chunk\"`, terminated by `data: [DONE]`. Reasoning tokens arrive as `delta.reasoning_content`." },
                },
              },
            },
            "400": { description: "Invalid request", content: { "application/json": { schema: ERROR_RESPONSE } } },
            "401": { description: "Missing or wrong API key", content: { "application/json": { schema: ERROR_RESPONSE } } },
            "502": { description: "Upstream model or agent failure", content: { "application/json": { schema: ERROR_RESPONSE } } },
            "503": { description: "API disabled in settings", content: { "application/json": { schema: ERROR_RESPONSE } } },
          },
        },
      },
      "/v1/completions": {
        post: {
          tags: ["chat"],
          summary: "Legacy text completion (same engine, `prompt` instead of `messages`)",
          operationId: "createCompletion",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: {
                    model: { type: "string", default: "grayskull" },
                    prompt: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
                    stream: { type: "boolean" },
                    web_search: { type: "boolean", default: false },
                    max_tokens: { type: "integer" },
                    temperature: { type: "number" },
                    stop: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Completion (`object: \"text_completion\"`)", content: { "application/json": { schema: { type: "object" } } } },
            "400": { description: "Invalid request", content: { "application/json": { schema: ERROR_RESPONSE } } },
          },
        },
      },
      "/v1/models": {
        get: {
          tags: ["models"],
          summary: "List available models",
          operationId: "listModels",
          responses: {
            "200": {
              description: "Model list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      object: { type: "string", example: "list" },
                      data: { type: "array", items: { $ref: "#/components/schemas/Model" } },
                    },
                  },
                  example: { object: "list", data: modelIds.slice(0, 6).map((id) => ({ id, object: "model", created: 1700000000, owned_by: "grayskull" })) },
                },
              },
            },
          },
        },
      },
      "/v1/models/{model}": {
        get: {
          tags: ["models"],
          summary: "Retrieve one model",
          operationId: "retrieveModel",
          parameters: [{ name: "model", in: "path", required: true, schema: { type: "string" }, example: modelIds[0] ?? "grayskull" }],
          responses: {
            "200": { description: "Model", content: { "application/json": { schema: { $ref: "#/components/schemas/Model" } } } },
            "404": { description: "Unknown model", content: { "application/json": { schema: ERROR_RESPONSE } } },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "`Authorization: Bearer gsk-…` — generate keys in grayskull-web: ⚙ settings → API. `x-api-key` is accepted too.",
        },
      },
      schemas: {
        Model: {
          type: "object",
          properties: {
            id: { type: "string" },
            object: { type: "string", example: "model" },
            created: { type: "integer" },
            owned_by: { type: "string", example: "grayskull" },
            context_window: { type: "integer" },
            x_grayskull: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["agent", "raw"] },
                model: { type: "string" },
                endpoint: { type: "string" },
              },
            },
          },
        },
        ChatCompletionRequest: CHAT_REQUEST,
        ChatCompletion: CHAT_RESPONSE,
        Error: ERROR_RESPONSE,
      },
    },
  };
}

const SWAGGER_VERSION = "5.17.14";

/** Swagger UI, with a built-in fallback renderer when the CDN is unreachable. */
export function docsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRAYSKULL API — OpenAI-compatible</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" onerror="window.__cssFailed=true">
<style>
  body { margin:0; background:#0b0f0b; color:#b8ffb8; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:14px 18px; border-bottom:1px solid #1e3a1e; }
  header h1 { margin:0 0 4px; font-size:16px; letter-spacing:.14em; color:#7CFF7C; }
  header p { margin:2px 0; font-size:12px; color:#6f9f6f; }
  code { background:#132013; padding:1px 5px; border-radius:3px; color:#b8ffb8; }
  #fallback { padding:16px 18px; max-width:1000px; }
  #fallback h2 { color:#7CFF7C; font-size:13px; letter-spacing:.1em; margin:18px 0 6px; }
  #fallback pre { background:#111a11; border:1px solid #1e3a1e; padding:10px; overflow-x:auto; font-size:12px; }
  .op { border:1px solid #1e3a1e; padding:8px 10px; margin-bottom:8px; }
  .m { color:#0b0f0b; background:#7CFF7C; padding:1px 6px; font-weight:bold; margin-right:8px; }
  a { color:#7CFF7C; }
</style>
</head>
<body>
<header>
  <h1>GRAYSKULL · OPENAI-COMPATIBLE API</h1>
  <p>Base URL for your client: <code id="baseUrl"></code> &nbsp;·&nbsp; key: <code>Authorization: Bearer gsk-…</code> (⚙ settings → API)</p>
  <p>Spec: <a href="/api/openapi.json">/api/openapi.json</a> &nbsp;·&nbsp; web search is <b>off</b> unless a request sends <code>"web_search": true</code></p>
</header>
<div id="swagger-ui"></div>
<div id="fallback" hidden></div>
<script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js"
        onerror="renderFallback('Swagger UI could not be loaded from the CDN (offline?) — showing the built-in view.')"></script>
<script>
document.getElementById("baseUrl").textContent = location.origin + "/v1";
function renderFallback(note) {
  const el = document.getElementById("fallback");
  el.hidden = false;
  document.getElementById("swagger-ui").hidden = true;
  fetch("/api/openapi.json").then((r) => r.json()).then((spec) => {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    let html = '<p style="color:#e0b000">' + esc(note) + "</p>";
    html += "<h2>ENDPOINTS</h2>";
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        html += '<div class="op"><span class="m">' + method.toUpperCase() + "</span><code>" + esc(path) + "</code><div style='margin-top:6px;color:#6f9f6f'>" + esc(op.summary || "") + "</div></div>";
      }
    }
    html += "<h2>QUICK START</h2><pre>" + esc(
      "curl " + location.origin + "/v1/chat/completions \\\\\\n" +
      "  -H 'Authorization: Bearer gsk-…' -H 'content-type: application/json' \\\\\\n" +
      '  -d \\'{"model":"grayskull","messages":[{"role":"user","content":"hi"}],"web_search":false}\\''
    ) + "</pre>";
    html += "<h2>FULL SPEC</h2><pre>" + esc(JSON.stringify(spec, null, 2)) + "</pre>";
    el.innerHTML = html;
  }).catch((e) => { el.textContent = "could not load /api/openapi.json: " + e; });
}
window.addEventListener("load", () => {
  if (!window.SwaggerUIBundle) return renderFallback("Swagger UI could not be loaded from the CDN (offline?) — showing the built-in view.");
  window.SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#swagger-ui", deepLinking: true, tryItOutEnabled: true, persistAuthorization: true });
});
</script>
</body>
</html>`;
}
