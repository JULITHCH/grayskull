// `with { type: "text" }` makes Bun embed the file as a string (also inside
// compiled binaries); the HTMLBundle type from @types/bun doesn't know that.
import indexHtmlRaw from "./ui.html" with { type: "text" };
const indexHtml = indexHtmlRaw as unknown as string;
import { SessionManager } from "./session";
import { ensureGlobalSystemPrompt } from "../config/settings";
import { ensureDirs } from "../config/paths";
import { ensureStarterChains } from "../chains/registry";

interface WsData {
  id: number;
}

export function startWebServer(opts: { port: number; hostname: string; defaultCwd: string }) {
  ensureDirs(opts.defaultCwd);
  ensureGlobalSystemPrompt();
  ensureStarterChains();

  const clients = new Set<Bun.ServerWebSocket<WsData>>();
  const broadcast = (msg: Record<string, unknown>) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) ws.send(payload);
  };
  const manager = new SessionManager(broadcast);
  let wsCounter = 0;

  const server = Bun.serve<WsData, never>({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { id: ++wsCounter } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        // replay current state to the newcomer
        ws.send(JSON.stringify({ t: "hello", defaultCwd: opts.defaultCwd }));
        ws.send(JSON.stringify({ t: "sessions", list: [...manager.sessions.values()].map((s) => s.summary()) }));
        for (const s of manager.sessions.values()) {
          ws.send(JSON.stringify({ t: "replay", sid: s.sid, items: s.items.slice(-300) }));
          s.sendStatus();
          s.sendMemory();
        }
      },
      close(ws) {
        clients.delete(ws);
      },
      message(_ws, raw) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        const sid = String(msg["sid"] ?? "");
        const session = manager.sessions.get(sid);
        switch (msg["t"]) {
          case "new_session": {
            const result = manager.create(String(msg["cwd"] || opts.defaultCwd));
            if ("error" in result) broadcast({ t: "error", text: result.error });
            break;
          }
          case "prompt":
            session?.prompt(String(msg["text"] ?? ""));
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
      },
    },
  });

  return server;
}
