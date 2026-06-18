// `with { type: "text" }` makes Bun embed the file as a string (also inside
// compiled binaries); the HTMLBundle type from @types/bun doesn't know that.
import indexHtmlRaw from "./ui.html" with { type: "text" };
import { SessionManager } from "./session";
import { ensureGlobalSystemPrompt } from "../config/settings";
import { ensureDirs } from "../config/paths";
import { ensureStarterChains } from "../chains/registry";
import type { TranscriptItem } from "../types";

const indexHtml = indexHtmlRaw as unknown as string;

interface WsData {
  id: number;
  kind: "browser" | "cli";
  /** for kind=cli: the sid assigned at registration */
  sid?: string;
}

/** A TUI session attached over the /cli endpoint. */
interface CliSession {
  ws: Bun.ServerWebSocket<WsData>;
  sid: string;
  cwd: string;
  mode: string;
  busy: boolean;
  items: TranscriptItem[];
  /** last status/memory payloads, replayed to newly connected browsers */
  lastStatus: Record<string, unknown> | null;
  lastMemory: Record<string, unknown> | null;
}

export function startWebServer(opts: { port: number; hostname: string; defaultCwd: string }) {
  ensureDirs(opts.defaultCwd);
  ensureGlobalSystemPrompt();
  ensureStarterChains();

  const browsers = new Set<Bun.ServerWebSocket<WsData>>();
  const cliSessions = new Map<string, CliSession>();
  let wsCounter = 0;
  let cliCounter = 0;

  const broadcast = (msg: Record<string, unknown>) => {
    const payload = JSON.stringify(msg);
    for (const ws of browsers) ws.send(payload);
  };
  const manager = new SessionManager(broadcast);

  const sessionList = () => [
    ...[...manager.sessions.values()].map((s) => ({ ...s.summary(), origin: "web" })),
    ...[...cliSessions.values()].map((c) => ({ sid: c.sid, cwd: c.cwd, mode: c.mode, busy: c.busy, origin: "cli" })),
  ];
  const broadcastSessions = () => broadcast({ t: "sessions", list: sessionList() });

  const handleCliMessage = (ws: Bun.ServerWebSocket<WsData>, msg: Record<string, unknown>) => {
    if (msg["t"] === "register") {
      const sid = ws.data.sid ?? `cli${++cliCounter}`;
      ws.data.sid = sid;
      cliSessions.set(sid, {
        ws,
        sid,
        cwd: String(msg["cwd"] ?? "?"),
        mode: String(msg["mode"] ?? "normal"),
        busy: false,
        items: (msg["items"] as TranscriptItem[] | undefined) ?? [],
        lastStatus: null,
        lastMemory: null,
      });
      broadcastSessions();
      broadcast({ t: "replay", sid, items: cliSessions.get(sid)!.items.slice(-300) });
      return;
    }
    const sid = ws.data.sid;
    if (!sid) return;
    const session = cliSessions.get(sid);
    if (!session) return;
    // mirror state for replay, then forward to browsers verbatim
    if (msg["t"] === "item") {
      session.items.push(msg["item"] as TranscriptItem);
      if (session.items.length > 2000) session.items.shift();
    }
    if (msg["t"] === "status") {
      session.mode = String(msg["mode"] ?? session.mode);
      session.busy = Boolean(msg["busy"]);
      session.lastStatus = msg;
      broadcastSessions();
    }
    if (msg["t"] === "busy") {
      session.busy = Boolean(msg["busy"]);
      broadcastSessions();
    }
    if (msg["t"] === "memory") session.lastMemory = msg;
    broadcast({ sid, ...msg });
  };

  const handleBrowserMessage = (ws: Bun.ServerWebSocket<WsData>, msg: Record<string, unknown>) => {
    const sid = String(msg["sid"] ?? "");
    if (msg["t"] === "new_session") {
      const cwd = String(msg["cwd"] || opts.defaultCwd);
      const result = manager.create(cwd, Boolean(msg["create"]));
      if ("needsCreate" in result) ws.send(JSON.stringify({ t: "confirm_create", cwd: result.needsCreate }));
      else if ("error" in result) broadcast({ t: "error", text: result.error });
      else broadcastSessions();
      return;
    }
    // commands for an attached CLI session are forwarded to its socket
    const cli = cliSessions.get(sid);
    if (cli) {
      cli.ws.send(JSON.stringify(msg));
      return;
    }
    const session = manager.sessions.get(sid);
    switch (msg["t"]) {
      case "prompt":
        session?.prompt(
          String(msg["text"] ?? ""),
          Array.isArray(msg["images"]) ? (msg["images"] as string[]) : [],
        );
        break;
      case "answer":
        session?.answer(String(msg["reqId"] ?? ""), String(msg["value"] ?? ""));
        break;
      case "mode":
        session?.setMode(String(msg["mode"] ?? ""));
        break;
      case "interrupt":
        session?.interrupt();
        break;
    }
  };

  const server = Bun.serve<WsData, never>({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" || url.pathname === "/cli") {
        const kind = url.pathname === "/cli" ? "cli" : "browser";
        if (srv.upgrade(req, { data: { id: ++wsCounter, kind } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      // pasted screenshots ride the socket as base64 data URLs
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        if (ws.data.kind === "cli") return; // waits for its register message
        browsers.add(ws);
        ws.send(JSON.stringify({ t: "hello", defaultCwd: opts.defaultCwd }));
        ws.send(JSON.stringify({ t: "sessions", list: sessionList() }));
        for (const s of manager.sessions.values()) {
          ws.send(JSON.stringify({ t: "replay", sid: s.sid, items: s.items.slice(-300) }));
          s.sendStatus();
          s.sendMemory();
        }
        for (const c of cliSessions.values()) {
          ws.send(JSON.stringify({ t: "replay", sid: c.sid, items: c.items.slice(-300) }));
          if (c.lastStatus) ws.send(JSON.stringify({ sid: c.sid, ...c.lastStatus }));
          if (c.lastMemory) ws.send(JSON.stringify({ sid: c.sid, ...c.lastMemory }));
        }
      },
      close(ws) {
        if (ws.data.kind === "cli") {
          if (ws.data.sid) {
            cliSessions.delete(ws.data.sid);
            broadcastSessions();
          }
          return;
        }
        browsers.delete(ws);
      },
      message(ws, raw) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (ws.data.kind === "cli") handleCliMessage(ws, msg);
        else handleBrowserMessage(ws, msg);
      },
    },
  });

  return server;
}
