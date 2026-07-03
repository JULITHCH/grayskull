// `with { type: "text" }` makes Bun embed the file as a string (also inside
// compiled binaries); the HTMLBundle type from @types/bun doesn't know that.
import indexHtmlRaw from "./ui.html" with { type: "text" };
// `type: "file"` embeds the asset in compiled binaries and resolves to a path
import zenMp3Path from "./zen.mp3" with { type: "file" };
import { SessionManager } from "./session";
import { ensureGlobalSystemPrompt, loadSettings } from "../config/settings";
import { ensureDirs } from "../config/paths";
import { ensureStarterChains } from "../chains/registry";
import { ensureStarterWorkers, workerSummaries, saveWorkerConfig, deleteWorker, loadWorker } from "../workers/registry";
import { Scheduler, setActiveScheduler, loadJobs, upsertJob, removeJob, setJobEnabled, parseEvery, JOB_LOG_DIR } from "../scheduler/scheduler";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runWorker } from "../workers/runtime";
import { CHATS_CWD } from "./persist";
import { LlmClient } from "../llm/client";
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
  ensureStarterWorkers();

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
    ...manager.dormantList().map((m) => ({ ...m, busy: false, origin: "web", dormant: true })),
  ];
  const broadcastSessions = () => broadcast({ t: "sessions", list: sessionList() });
  manager.onListChange = broadcastSessions;

  // interval scheduler: this process is the always-on daemon, so worker jobs
  // live here; the TUI edits the same jobs.json but never runs them
  const schedSettings = loadSettings(opts.defaultCwd);
  const schedClient = new LlmClient(schedSettings);
  const scheduler = new Scheduler(schedClient, schedSettings);
  // automation state for the GUI panel — config values never leave the server
  const broadcastAuto = () =>
    broadcast({
      t: "auto",
      workers: workerSummaries(),
      jobs: loadJobs().sort((a, b) => a.nextRun - b.nextRun).map(({ name, worker, task, every, at, weekday, enabled, nextRun, lastRun, lastStatus, lastSummary }) => ({
        name, worker, task, every, at, weekday, enabled, nextRun, lastRun, lastStatus, lastSummary,
      })),
    });
  scheduler.onEvent = (ev) => {
    broadcast({ t: "job", ...ev });
    if (ev.state !== "start") broadcastAuto();
  };
  scheduler.onNote = (job, text) => broadcast({ t: "job_note", job, text });
  scheduler.start();
  setActiveScheduler(scheduler);

  /** GUI automation commands — server-global, independent of any session. */
  const handleAutoMessage = (ws: Bun.ServerWebSocket<WsData>, msg: Record<string, unknown>): boolean => {
    switch (msg["t"]) {
      case "auto_state":
        ws.send(JSON.stringify({ t: "hello_auto" }));
        broadcastAuto();
        return true;
      case "worker_cfg_save": {
        const name = String(msg["name"] ?? "");
        if (!loadWorker(name)) return broadcast({ t: "error", text: `no worker ${name}` }), true;
        const values = (msg["values"] ?? {}) as Record<string, string>;
        const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "string" && v !== ""));
        saveWorkerConfig(name, clean as Record<string, string>);
        broadcastAuto();
        return true;
      }
      case "worker_delete":
        deleteWorker(String(msg["name"] ?? ""));
        broadcastAuto();
        return true;
      case "job_save": {
        const j = (msg["job"] ?? {}) as Record<string, unknown>;
        const name = String(j["name"] ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        const worker = String(j["worker"] ?? "");
        const task = String(j["task"] ?? "").trim();
        const every = String(j["every"] ?? "");
        if (!name || !task) return broadcast({ t: "error", text: "job needs a name and a task" }), true;
        if (!loadWorker(worker)) return broadcast({ t: "error", text: `no worker ${worker}` }), true;
        if (!parseEvery(every)) return broadcast({ t: "error", text: `invalid interval ${every}` }), true;
        upsertJob({
          name, worker, task, every,
          ...(j["at"] ? { at: String(j["at"]) } : {}),
          ...(j["weekday"] ? { weekday: String(j["weekday"]) } : {}),
          enabled: j["enabled"] !== false,
        });
        broadcastAuto();
        return true;
      }
      case "job_delete":
        removeJob(String(msg["name"] ?? ""));
        broadcastAuto();
        return true;
      case "job_toggle":
        setJobEnabled(String(msg["name"] ?? ""), Boolean(msg["enabled"]));
        broadcastAuto();
        return true;
      case "job_run":
        void scheduler.runJob(String(msg["name"] ?? "")).then(() => broadcastAuto());
        return true;
      case "worker_run": {
        // one-off GUI run, headless like a job but without scheduling
        const name = String(msg["name"] ?? "");
        const task = String(msg["task"] ?? "").trim();
        if (!loadWorker(name) || !task) return broadcast({ t: "error", text: "worker_run needs a worker and a task" }), true;
        const tag = `worker:${name}`;
        broadcast({ t: "job", job: tag, state: "start" });
        void runWorker({
          worker: name, task, client: schedClient, settings: schedSettings, cwd: CHATS_CWD,
          onNote: (text) => broadcast({ t: "job_note", job: tag, text }),
        })
          .then((r) => broadcast({ t: "job", job: tag, state: "ok", summary: r.slice(0, 300) }))
          .catch((e) => broadcast({ t: "job", job: tag, state: "error", summary: (e as Error).message }));
        return true;
      }
      case "job_log_req": {
        const name = String(msg["name"] ?? "").replace(/[^\w-]/g, "");
        const path = join(JOB_LOG_DIR, `${name}.log`);
        const text = existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-80).join("\n") : "(no log yet)";
        ws.send(JSON.stringify({ t: "job_log", name, text }));
        return true;
      }
    }
    return false;
  };

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
    if (handleAutoMessage(ws, msg)) return;
    const sid = String(msg["sid"] ?? "");
    if (msg["t"] === "new_session") {
      const cwd = String(msg["cwd"] || opts.defaultCwd);
      const kind = msg["kind"] === "chat" ? "chat" : "project";
      const result = manager.create(cwd, Boolean(msg["create"]), kind);
      if ("needsCreate" in result) ws.send(JSON.stringify({ t: "confirm_create", cwd: result.needsCreate }));
      else if ("error" in result) broadcast({ t: "error", text: result.error });
      else {
        broadcastSessions();
        // focus the fresh session in the creating browser
        ws.send(JSON.stringify({ t: "sess_select", sid: result.sid }));
      }
      return;
    }
    if (msg["t"] === "resume_session") {
      const result = manager.resume(String(msg["sid"] ?? ""));
      if ("error" in result) broadcast({ t: "error", text: result.error });
      return;
    }
    if (msg["t"] === "delete_session") {
      manager.delete(String(msg["sid"] ?? ""));
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
      case "temp":
        session?.setTemperature(Number(msg["value"]));
        break;
      case "chain_save":
        session?.chainSave((msg["def"] as Record<string, unknown>) ?? {});
        break;
      case "setup_open":
        void session?.setupOpen();
        break;
      case "setup_apply":
        session?.setupApply(String(msg["id"] ?? ""), String(msg["value"] ?? ""));
        break;
      case "setup_preset_add":
        session?.setupPresetAdd(String(msg["name"] ?? ""));
        break;
      case "setup_preset_remove":
        session?.setupPresetRemove(String(msg["name"] ?? ""));
        break;
      case "setup_save":
        session?.setupSave(msg["ids"]);
        break;
      case "setup_recheck":
        void session?.setupRecheck();
        break;
      case "close_session":
        manager.close(sid);
        broadcastSessions();
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
      if (url.pathname === "/zen.mp3") {
        return new Response(Bun.file(zenMp3Path), { headers: { "content-type": "audio/mpeg" } });
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
        broadcastAuto();
        for (const s of manager.sessions.values()) {
          ws.send(JSON.stringify({ t: "replay", sid: s.sid, items: s.items.slice(-300) }));
          s.sendStatus();
          s.sendMemory();
          s.replayPending();
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
