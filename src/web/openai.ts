import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadSettings, type Settings } from "../config/settings";
import { GLOBAL_DIR } from "../config/paths";
import { LlmClient, estimateMessagesTokens, estimateTokens, type ToolSchema } from "../llm/client";
import type { ChatMessage, ToolCall } from "../types";
import { ApiSessionPool, type ApiSession } from "./apisession";
import { openApiSpec, docsPage } from "./openapi";

/**
 * OpenAI-compatible HTTP API for grayskull-web.
 *
 * `/v1/chat/completions` runs a REAL agent turn (tools, skills, sub-agents,
 * sandboxed to the API cwd) and returns it as an OpenAI chat completion, so any
 * client that speaks OpenAI — Open WebUI, LibreChat, n8n, the openai SDK,
 * anything with a "custom base URL" field — drives grayskull without knowing
 * anything about it.
 *
 * Deliberate deviations, all documented in the OpenAPI spec:
 *   - `web_search` (and OpenAI's `web_search_options`) toggles the searxng
 *     tools per request; the default is OFF (settings `api.webSearch`)
 *   - a request carrying `tools` is served in RAW mode (a plain completion
 *     against the configured model, tool calls returned verbatim) — the agent
 *     cannot execute a caller's tools, so pretending otherwise would be worse
 *   - `usage` is exact in raw mode and estimated for agent turns (an agent turn
 *     is many model calls, not one)
 */

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, openai-organization, openai-beta",
  "access-control-max-age": "86400",
};

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  prompt?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: boolean } | undefined;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  n?: unknown;
  stop?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  web_search?: unknown;
  web_search_options?: unknown;
  response_format?: { type?: string } | undefined;
}

interface ResolvedModel {
  /** what the client asked for — echoed back verbatim */
  requested: string;
  mode: "agent" | "raw";
  preset: string | null;
  fallback: boolean;
}

export class OpenAiApi {
  private readonly pool: ApiSessionPool;

  constructor(
    private readonly defaultCwd: string,
    private readonly log: (text: string) => void = console.error,
  ) {
    this.pool = new ApiSessionPool(
      () => this.settings().api.cwd || this.defaultCwd,
      () => this.settings().api.maxSessions,
      this.log,
    );
  }

  /** Always read fresh: keys and toggles change in the GUI without a restart. */
  private settings(): Settings {
    try {
      return loadSettings(this.defaultCwd);
    } catch {
      return loadSettings(GLOBAL_DIR);
    }
  }

  async closeAll(): Promise<void> {
    await this.pool.closeAll();
  }

  /** Bearer key check. Returns null when the caller is authorized. */
  private authorize(req: Request, cookieAuthed: boolean, settings: Settings): Response | null {
    const keys = settings.api.keys;
    const header = req.headers.get("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const presented = bearer || (req.headers.get("x-api-key") ?? "").trim();
    if (presented && keys.some((k) => constantTimeEqual(k.key, presented))) return null;
    // The browser (Swagger UI "Try it out") rides its login cookie — but ONLY
    // when a login actually exists: without a web password `cookieAuthed` is
    // true for every caller, which would make API keys decorative.
    if (cookieAuthed && settings.web.passwordHash) return null;
    // NO open fallback: /v1/* always requires a key. Keyless-and-open (mirroring
    // the passwordless UI) was tried and rejected — an endpoint made for other
    // tools gets pointed at from all over the network and must fail closed.
    return errorResponse(
      401,
      !keys.length
        ? "No API keys exist yet — the API refuses every request until one is generated in grayskull-web (⚙ settings → API → + GENERATE KEY)."
        : presented
          ? "Incorrect API key provided. Generate one in grayskull-web: ⚙ settings → API → + GENERATE KEY."
          : "You didn't provide an API key. Send it as an Authorization header: 'Authorization: Bearer gsk-…'.",
      "invalid_request_error",
      null,
      "invalid_api_key",
    );
  }

  /** Returns null when the path isn't ours, so the caller keeps routing. */
  async handle(req: Request, url: URL, cookieAuthed: boolean): Promise<Response | null> {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isApiPath =
      path.startsWith("/v1/") || path === "/v1" || path === "/openapi.json" || path === "/api/openapi.json" || path === "/api/docs";
    if (!isApiPath) return null;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const settings = this.settings();
    if (!settings.api.enabled) {
      return errorResponse(503, "The grayskull OpenAI-compatible API is disabled (⚙ settings → API → enabled).", "server_error");
    }
    // the documentation is not a secret and a browser that got past the web
    // login must be able to read it — only /v1/* needs a key
    const isDocs = path === "/api/docs" || path === "/api/openapi.json" || path === "/openapi.json" || path === "/v1/openapi.json";
    const denied = this.authorize(req, cookieAuthed, settings);
    if (denied && !(isDocs && cookieAuthed)) return denied;

    if (path === "/api/docs" && req.method === "GET") {
      return new Response(docsPage(), { headers: { "content-type": "text/html; charset=utf-8", ...CORS } });
    }
    if (isDocs && req.method === "GET") {
      return json(openApiSpec(url.origin, this.modelIds(settings)), 200);
    }
    if (path === "/v1/models" && req.method === "GET") {
      return json({ object: "list", data: this.modelIds(settings).map((id) => modelObject(id, settings)) }, 200);
    }
    if (path.startsWith("/v1/models/") && req.method === "GET") {
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      const known = this.modelIds(settings);
      if (!known.includes(id)) {
        return errorResponse(404, `The model '${id}' does not exist`, "invalid_request_error", "model", "model_not_found");
      }
      return json(modelObject(id, settings), 200);
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      return this.chatCompletions(req, settings, false);
    }
    if (path === "/v1/completions" && req.method === "POST") {
      return this.chatCompletions(req, settings, true);
    }
    if (path === "/v1/embeddings" || path === "/v1/images/generations" || path === "/v1/audio/speech") {
      return errorResponse(
        404,
        `grayskull implements the chat surface of the OpenAI API (/v1/models, /v1/chat/completions, /v1/completions) — ${path} is not available.`,
        "invalid_request_error",
        null,
        "unsupported_endpoint",
      );
    }
    return errorResponse(404, `Unknown endpoint ${path}. See ${url.origin}/api/docs`, "invalid_request_error");
  }

  /** `grayskull` (agent) + `grayskull-raw` (plain model), each also per preset. */
  private modelIds(settings: Settings): string[] {
    const presets = Object.keys(settings.models);
    return [
      "grayskull",
      "grayskull-raw",
      ...presets.map((p) => `grayskull:${p}`),
      ...presets.map((p) => `grayskull-raw:${p}`),
    ];
  }

  private resolveModel(requested: string, settings: Settings): ResolvedModel {
    const id = (requested || "grayskull").trim();
    const [head, ...rest] = id.split(":");
    const presetPart = rest.join(":");
    const preset = presetPart && settings.models[presetPart] ? presetPart : null;
    if (head === "grayskull" || head === "grayskull-agent" || head === "agent") {
      return { requested: id, mode: "agent", preset, fallback: false };
    }
    if (head === "grayskull-raw" || head === "raw") {
      return { requested: id, mode: "raw", preset, fallback: false };
    }
    // a bare preset name is a raw completion against that preset
    if (settings.models[id]) return { requested: id, mode: "raw", preset: id, fallback: false };
    // anything else (a client hard-coded to "gpt-4o") gets the agent, flagged
    // in a response header — a 404 would just block the integration
    return { requested: id, mode: "agent", preset: null, fallback: true };
  }

  private async chatCompletions(req: Request, settings: Settings, legacy: boolean): Promise<Response> {
    let body: ChatRequest;
    try {
      body = (await req.json()) as ChatRequest;
    } catch {
      return errorResponse(400, "We could not parse the JSON body of your request.", "invalid_request_error");
    }
    if (!body || typeof body !== "object") {
      return errorResponse(400, "Invalid request body: expected a JSON object.", "invalid_request_error");
    }
    const n = Number(body.n ?? 1);
    if (n > 1) {
      return errorResponse(400, "grayskull runs one agent turn per request: 'n' must be 1.", "invalid_request_error", "n");
    }
    const stream = body.stream === true;
    const model = this.resolveModel(String(body.model ?? "grayskull"), settings);
    const stops = parseStops(body.stop);
    const maxTokens = numberOrUndefined(body.max_completion_tokens) ?? numberOrUndefined(body.max_tokens);
    const temperature = numberOrUndefined(body.temperature);
    const topP = numberOrUndefined(body.top_p);
    // web search: off unless this request asks for it (or the operator flipped
    // the default). `web_search_options` is OpenAI's own field for the same idea
    const webSearch =
      body.web_search === true || (body.web_search_options !== undefined && body.web_search_options !== null)
        ? true
        : body.web_search === false
          ? false
          : settings.api.webSearch;

    let messages: ChatMessage[];
    if (legacy) {
      const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : String(body.prompt ?? "");
      if (!prompt.trim()) return errorResponse(400, "'prompt' is required.", "invalid_request_error", "prompt");
      messages = [{ role: "user", content: prompt }];
    } else {
      if (!Array.isArray(body.messages) || !body.messages.length) {
        return errorResponse(400, "'messages' is required and must be a non-empty array.", "invalid_request_error", "messages");
      }
      messages = body.messages as ChatMessage[];
    }

    // a caller-supplied tool set can only be honored by the raw model: the
    // agent runs ITS tools locally and would never hand a call back
    const clientTools = toolSchemas(body.tools);
    const rawMode = model.mode === "raw" || clientTools.length > 0;
    const started = Date.now();
    const id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    const extraHeaders: Record<string, string> = {
      ...CORS,
      "x-grayskull-mode": rawMode ? "raw" : "agent",
      "x-grayskull-web-search": webSearch ? "on" : "off",
      // header values must stay ASCII (latin-1) — no arrows, no umlauts
      ...(model.fallback ? { "x-grayskull-model-fallback": `${model.requested.replace(/[^\x20-\x7e]/g, "?")} -> grayskull (agent)` } : {}),
    };

    this.log(
      `api: ${legacy ? "completion" : "chat"} model=${model.requested} mode=${rawMode ? "raw" : "agent"} ` +
        `stream=${stream} web_search=${webSearch ? "on" : "off"} messages=${messages.length}`,
    );

    if (rawMode) {
      return this.rawCompletion({
        id, req, settings, model, messages, clientTools, stream, legacy,
        temperature, topP, maxTokens, stops, started, extraHeaders,
        includeUsage: body.stream_options?.include_usage === true,
      });
    }
    return this.agentCompletion({
      id, req, settings, model, messages, stream, legacy, webSearch,
      temperature, topP, maxTokens, stops, started, extraHeaders,
      includeUsage: body.stream_options?.include_usage === true,
      jsonMode: body.response_format?.type === "json_object" || body.response_format?.type === "json_schema",
    });
  }

  /** Raw mode: one completion against the configured model, no agent loop. */
  private async rawCompletion(o: {
    id: string; req: Request; settings: Settings; model: ResolvedModel; messages: ChatMessage[];
    clientTools: ToolSchema[]; stream: boolean; legacy: boolean; temperature?: number; topP?: number;
    maxTokens?: number; stops: string[]; started: number; extraHeaders: Record<string, string>; includeUsage: boolean;
  }): Promise<Response> {
    const settings = { ...o.settings };
    const preset = o.model.preset ? o.settings.models[o.model.preset] : undefined;
    if (preset) {
      settings.baseURL = preset.baseURL;
      settings.model = preset.model;
      settings.modelFamily = preset.family;
      if (preset.apiKeyEnv !== undefined) settings.apiKeyEnv = preset.apiKeyEnv;
      if (preset.contextWindow !== undefined) settings.contextWindow = preset.contextWindow;
      if (preset.maxTokens !== undefined) settings.maxTokens = preset.maxTokens;
    }
    if (o.maxTokens) settings.maxTokens = Math.min(settings.maxTokens, o.maxTokens);
    if (o.temperature !== undefined) settings.temperature = o.temperature;
    if (o.topP !== undefined) settings.topP = o.topP;
    const client = new LlmClient(settings);

    if (!o.stream) {
      try {
        const result = await client.complete(o.messages, o.clientTools, {}, o.req.signal);
        const text = applyStops(result.text, o.stops);
        const usage = result.usage
          ? { prompt_tokens: result.usage.promptTokens, completion_tokens: result.usage.completionTokens, total_tokens: result.usage.promptTokens + result.usage.completionTokens }
          : estimateUsage(o.messages, text);
        return json(
          completionBody(o.id, o.model.requested, text, result.toolCalls, o.legacy, usage, result.finishReason),
          200,
          { ...o.extraHeaders, "openai-processing-ms": String(Date.now() - o.started) },
        );
      } catch (err) {
        return errorResponse(502, `upstream model error: ${(err as Error).message}`, "server_error");
      }
    }

    return this.sse(o.id, o.model.requested, o.legacy, o.extraHeaders, async (emit) => {
      let full = "";
      let stopped = false;
      const result = await client.complete(
        o.messages,
        o.clientTools,
        {
          onTextDelta: (d) => {
            if (stopped) return;
            const { out, done } = clipAtStop(full, d, o.stops);
            full += out;
            if (out) emit.delta(out);
            if (done) stopped = true;
          },
          onReasoningDelta: (d) => emit.reasoning(d),
        },
        o.req.signal,
      );
      if (result.toolCalls.length) emit.toolCalls(result.toolCalls);
      const usage = result.usage
        ? { prompt_tokens: result.usage.promptTokens, completion_tokens: result.usage.completionTokens, total_tokens: result.usage.promptTokens + result.usage.completionTokens }
        : estimateUsage(o.messages, full);
      emit.finish(result.toolCalls.length ? "tool_calls" : stopped ? "stop" : result.finishReason === "length" ? "length" : "stop", o.includeUsage ? usage : null);
    });
  }

  /** Agent mode: a full grayskull turn behind the OpenAI response shape. */
  private async agentCompletion(o: {
    id: string; req: Request; settings: Settings; model: ResolvedModel; messages: ChatMessage[];
    stream: boolean; legacy: boolean; webSearch: boolean; temperature?: number; topP?: number; maxTokens?: number;
    stops: string[]; started: number; extraHeaders: Record<string, string>; includeUsage: boolean; jsonMode: boolean;
  }): Promise<Response> {
    const split = splitMessages(o.messages);
    if (!split) {
      return errorResponse(400, "'messages' must contain at least one user message.", "invalid_request_error", "messages");
    }
    const { history, text, images } = split;
    const prompt = o.jsonMode
      ? `${text}\n\n[Output format] Reply with a single valid JSON value and nothing else — no prose, no code fence.`
      : text;

    const session = await this.pool.acquire();
    const applyPreset = () => {
      if (!o.model.preset) return null;
      const preset = o.settings.models[o.model.preset];
      if (!preset) return null;
      const before = session.agent.snapshotModelPreset();
      session.agent.applyModelSwitch(preset);
      return before;
    };

    if (!o.stream) {
      const restore = applyPreset();
      try {
        const result = await session.run({
          history, text: prompt, images, webSearch: o.webSearch,
          temperature: o.temperature, topP: o.topP, maxTokens: o.maxTokens,
          signal: o.req.signal,
          onTool: (d) => this.log(`api:   ⚙ ${d}`),
        });
        if (!result.text && result.error) {
          return errorResponse(502, `agent turn failed: ${result.error}`, "server_error");
        }
        const answer = applyStops(result.text, o.stops);
        const usage = estimateUsage([...history, { role: "user", content: prompt }], answer);
        const bodyOut = completionBody(o.id, o.model.requested, answer, [], o.legacy, usage, "stop") as Record<string, unknown>;
        bodyOut["x_grayskull"] = { mode: "agent", web_search: o.webSearch, tools_used: result.toolsUsed, cwd: session.cwd };
        return json(bodyOut, 200, { ...o.extraHeaders, "openai-processing-ms": String(Date.now() - o.started) });
      } finally {
        if (restore) session.agent.applyModelSwitch(restore);
        this.pool.release(session);
      }
    }

    return this.sse(o.id, o.model.requested, o.legacy, o.extraHeaders, async (emit) => {
      const restore = applyPreset();
      let full = "";
      let stopped = false;
      try {
        const result = await session.run({
          history, text: prompt, images, webSearch: o.webSearch,
          temperature: o.temperature, topP: o.topP, maxTokens: o.maxTokens,
          signal: o.req.signal,
          onText: (d) => {
            if (stopped) return;
            const { out, done } = clipAtStop(full, d, o.stops);
            full += out;
            if (out) emit.delta(out);
            if (done) stopped = true;
          },
          onReasoning: (d) => emit.reasoning(d),
          onTool: (d) => this.log(`api:   ⚙ ${d}`),
        });
        // nothing streamed (a model that only answered after its tools) —
        // send the final text so the client never gets an empty stream
        if (!full.trim() && result.text.trim()) emit.delta(applyStops(result.text, o.stops));
        const usage = estimateUsage([...history, { role: "user", content: prompt }], full || result.text);
        emit.finish("stop", o.includeUsage ? usage : null);
      } finally {
        if (restore) session.agent.applyModelSwitch(restore);
        this.pool.release(session);
      }
    });
  }

  /** SSE plumbing shared by both modes. */
  private sse(
    id: string,
    model: string,
    legacy: boolean,
    headers: Record<string, string>,
    body: (emit: {
      delta: (text: string) => void;
      reasoning: (text: string) => void;
      toolCalls: (calls: ToolCall[]) => void;
      finish: (reason: string, usage: Usage | null) => void;
    }) => Promise<void>,
  ): Response {
    const object = legacy ? "text_completion" : "chat.completion.chunk";
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const log = this.log;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const write = (payload: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            closed = true; // client hung up
          }
        };
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          legacy
            ? { id, object, created, model, choices: [{ index: 0, text: String(delta["content"] ?? ""), finish_reason: finish, logprobs: null }] }
            : { id, object, created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] };
        write(chunk({ role: "assistant", content: "" }, null));
        try {
          await body({
            delta: (text) => write(chunk({ content: text }, null)),
            reasoning: (text) => write(chunk({ reasoning_content: text }, null)),
            toolCalls: (calls) =>
              write(
                chunk(
                  {
                    tool_calls: calls.map((c, i) => ({
                      index: i, id: c.id, type: "function",
                      function: { name: c.function.name, arguments: c.function.arguments },
                    })),
                  },
                  null,
                ),
              ),
            finish: (reason, usage) => {
              write(chunk({}, reason));
              if (usage) write({ id, object, created, model, choices: [], usage });
            },
          });
        } catch (err) {
          log(`api: stream failed: ${(err as Error).message}`);
          write({ error: { message: (err as Error).message, type: "server_error", param: null, code: null } });
          write(chunk({}, "stop"));
        }
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch {
            // client gone — nothing left to flush
          }
        }
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...headers,
      },
    });
  }
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function modelObject(id: string, settings: Settings): Record<string, unknown> {
  const presetName = id.includes(":") ? id.slice(id.indexOf(":") + 1) : null;
  const preset = presetName ? settings.models[presetName] : undefined;
  return {
    id,
    object: "model",
    created: 1700000000,
    owned_by: "grayskull",
    // extras: harmless for strict clients, useful for the ones that show them
    context_window: preset?.contextWindow ?? settings.contextWindow,
    x_grayskull: {
      mode: id.startsWith("grayskull-raw") ? "raw" : "agent",
      model: preset?.model ?? settings.model,
      endpoint: preset?.baseURL ?? settings.baseURL,
    },
  };
}

/**
 * OpenAI messages → agent history + the final user turn (text + images).
 *
 * The caller's `system` messages canNOT stay in the history: the agent puts its
 * own system message first and vLLM rejects a second one further down
 * ("System message must be at the beginning"). They are hoisted into the turn
 * text as an explicit instruction block instead — same authority, legal shape.
 */
function splitMessages(messages: ChatMessage[]): { history: ChatMessage[]; text: string; images: string[] } | null {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return null;
  const turn = messages[lastUser]!;
  const { text, images } = contentParts(turn.content);
  const rest = messages.filter((_, i) => i !== lastUser);
  const systems: string[] = [];
  const history: ChatMessage[] = [];
  for (const m of rest) {
    if (m.role === "system" || m.role === "developer") {
      const part = contentParts(m.content).text.trim();
      if (part) systems.push(part);
    } else history.push(m);
  }
  const prefix = systems.length ? `[Instructions from the API caller — follow them for this reply]\n${systems.join("\n\n")}\n\n` : "";
  return { history, text: prefix + text, images };
}

/** Content is a string or OpenAI's parts array (text + image_url). */
function contentParts(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const text: string[] = [];
  const images: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (part?.["type"] === "text" && typeof part["text"] === "string") text.push(part["text"]);
      else if (part?.["type"] === "image_url") {
        const url = (part["image_url"] as { url?: unknown } | undefined)?.url;
        if (typeof url === "string") images.push(url);
      }
    }
  }
  return { text: text.join("\n"), images };
}

function toolSchemas(tools: unknown): ToolSchema[] {
  if (!Array.isArray(tools)) return [];
  const out: ToolSchema[] = [];
  for (const t of tools as Array<Record<string, unknown>>) {
    const fn = t?.["function"] as Record<string, unknown> | undefined;
    if (!fn || typeof fn["name"] !== "string") continue;
    out.push({
      name: fn["name"],
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      parameters: (fn["parameters"] as Record<string, unknown>) ?? { type: "object", properties: {} },
    });
  }
  return out;
}

function completionBody(
  id: string,
  model: string,
  text: string,
  toolCalls: ToolCall[],
  legacy: boolean,
  usage: Usage,
  finishReason: string | null,
): Record<string, unknown> {
  const finish = toolCalls.length ? "tool_calls" : finishReason === "length" ? "length" : "stop";
  const created = Math.floor(Date.now() / 1000);
  if (legacy) {
    return {
      id, object: "text_completion", created, model,
      choices: [{ index: 0, text, finish_reason: finish, logprobs: null }],
      usage,
    };
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: "grayskull",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((c) => ({
                  id: c.id, type: "function",
                  function: { name: c.function.name, arguments: c.function.arguments },
                })),
              }
            : {}),
        },
        finish_reason: finish,
        logprobs: null,
      },
    ],
    usage,
  };
}

function estimateUsage(messages: ChatMessage[], answer: string): Usage {
  const prompt_tokens = estimateMessagesTokens(messages);
  const completion_tokens = estimateTokens(answer);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function parseStops(stop: unknown): string[] {
  if (typeof stop === "string") return [stop];
  if (Array.isArray(stop)) return stop.filter((s): s is string => typeof s === "string").slice(0, 4);
  return [];
}

function applyStops(text: string, stops: string[]): string {
  let out = text;
  for (const s of stops) {
    const i = out.indexOf(s);
    if (i >= 0) out = out.slice(0, i);
  }
  return out;
}

/** Streaming stop-sequence handling: how much of this delta may still be sent. */
function clipAtStop(sofar: string, delta: string, stops: string[]): { out: string; done: boolean } {
  if (!stops.length) return { out: delta, done: false };
  const combined = sofar + delta;
  let cut = -1;
  for (const s of stops) {
    const i = combined.indexOf(s, Math.max(0, sofar.length - s.length));
    if (i >= 0 && (cut === -1 || i < cut)) cut = i;
  }
  if (cut === -1) return { out: delta, done: false };
  return { out: combined.slice(sofar.length, cut), done: true };
}

function numberOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || Number.isNaN(n) ? undefined : n;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });
}

/** OpenAI's error envelope — clients parse `error.message`, so it must fit. */
export function errorResponse(
  status: number,
  message: string,
  type: string,
  param: string | null = null,
  code: string | null = null,
): Response {
  return json({ error: { message, type, param, code } }, status);
}
