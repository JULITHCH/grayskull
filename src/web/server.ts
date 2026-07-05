// `with { type: "text" }` makes Bun embed the file as a string (also inside
// compiled binaries); the HTMLBundle type from @types/bun doesn't know that.
import indexHtmlRaw from "./ui.html" with { type: "text" };
// `type: "file"` embeds the asset in compiled binaries and resolves to a path
import zenMp3Path from "./zen.mp3" with { type: "file" };
// xterm.js frontend assets, embedded so the UI stays CDN-free
import xtermJsRaw from "../../node_modules/@xterm/xterm/lib/xterm.js" with { type: "text" };
import xtermCssRaw from "../../node_modules/@xterm/xterm/css/xterm.css" with { type: "text" };
import xtermFitRaw from "../../node_modules/@xterm/addon-fit/lib/addon-fit.js" with { type: "text" };
// PWA assets: installable app + notification icon
import icon192Path from "./icon-192.png" with { type: "file" };
import icon512Path from "./icon-512.png" with { type: "file" };
import { SessionManager } from "./session";
import { TermManager } from "./term";
import { ensureGlobalSystemPrompt, loadSettings } from "../config/settings";
import { ensureDirs } from "../config/paths";
import { ensureStarterChains } from "../chains/registry";
import { ensureStarterWorkers, workerSummaries, saveWorkerConfig, deleteWorker, loadWorker } from "../workers/registry";
import { Scheduler, setActiveScheduler, loadJobs, upsertJob, removeJob, setJobEnabled, parseEvery, JOB_LOG_DIR } from "../scheduler/scheduler";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runWorker } from "../workers/runtime";
import { CHATS_CWD } from "./persist";
import {
  loadOrCreateSecret, makeToken, checkToken, cookieValue, authCookie, clearCookie,
  isHttps, isLoopback, loginPage, LoginLimiter, COOKIE_NAME, AuthConfig,
} from "./auth";
import { LlmClient } from "../llm/client";
import type { TranscriptItem } from "../types";

const indexHtml = indexHtmlRaw as unknown as string;

/** Build fingerprint of the embedded UI — sent in the WS hello. A browser tab
 *  that reconnects (server restarted) and sees a different hash is running a
 *  stale build and reloads itself; no cache to bust since nothing is cached. */
const UI_BUILD = Bun.hash(indexHtml).toString(36);

/** PWA manifest — installable standalone app (requires a secure context:
 *  localhost, an ssh port-forward, or https). */
const MANIFEST = JSON.stringify({
  name: "GRAYSKULL // WEB",
  short_name: "GRAYSKULL",
  description: "Control room for the GRAYSKULL local-model coding agent",
  start_url: "/",
  display: "standalone",
  background_color: "#010701",
  theme_color: "#010701",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

/** Minimal service worker: no offline caching (the UI is one live-WS page —
 *  a stale cached shell is worse than none), just installability plus
 *  notification click-to-focus. */
const SW_JS = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((w) => "focus" in w);
    return c ? c.focus() : self.clients.openWindow("/");
  }));
});
`;

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

  // per-session PTY shells (web/term.ts) — output fans out to every browser
  const terms = new TermManager({
    onData: (sid, d) => broadcast({ t: "term_out", sid, d }),
    onExit: (sid, code) => broadcast({ t: "term_exit", sid, code }),
  });

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
      terms.kill(String(msg["sid"] ?? ""));
      manager.delete(String(msg["sid"] ?? ""));
      return;
    }
    // terminals are server-side for every session origin — handle BEFORE the
    // CLI forward below, or a CLI session's term_* would go to the TUI instead
    switch (msg["t"]) {
      case "term_open": {
        const cwd = manager.sessions.get(sid)?.cwd ?? cliSessions.get(sid)?.cwd ?? opts.defaultCwd;
        const replay = terms.open(sid, cwd);
        ws.send(JSON.stringify({ t: "term_ready", sid, replay }));
        return;
      }
      case "term_in":
        terms.input(sid, String(msg["d"] ?? ""));
        return;
      case "term_size":
        terms.resize(sid, Number(msg["cols"]), Number(msg["rows"]));
        return;
      case "term_kill":
        terms.kill(sid);
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
      case "setup_family_add":
        session?.setupFamilyAdd(String(msg["name"] ?? ""));
        break;
      case "modelsdev_search":
        void session?.modelsdevSearch(String(msg["query"] ?? ""));
        break;
      case "modelsdev_import":
        void session?.modelsdevImport(String(msg["ref"] ?? ""));
        break;
      case "setup_save":
        session?.setupSave(msg["ids"]);
        break;
      case "setup_recheck":
        void session?.setupRecheck();
        break;
      case "close_session":
        terms.kill(sid);
        manager.close(sid);
        broadcastSessions();
        break;
    }
  };

  // ── login (web/auth.ts): everything except /login, the PWA manifest/icons
  // and the loopback-only /cli endpoint requires the auth cookie. AuthConfig
  // re-reads settings.json on change, so a password set in the ⚙ settings GUI
  // arms the gate without a restart ──
  const auth = new AuthConfig();
  const secret = loadOrCreateSecret();
  const limiter = new LoginLimiter();
  if (!auth.get().hash && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost") {
    console.warn(
      "⚠ grayskull-web has NO login password and binds " + opts.hostname +
      " — anyone who reaches this port controls a shell-wielding agent." +
      " Set one in ⚙ settings (SERVICES tab) or: grayskull-web --set-password",
    );
  }
  const authed = (req: Request): boolean =>
    !auth.get().hash || checkToken(secret, cookieValue(req, COOKIE_NAME));

  const server = Bun.serve<WsData, never>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/cli") {
        // TUI bridge: local process, no browser, no cookie — loopback only.
        if (!isLoopback(srv.requestIP(req)?.address)) return new Response("forbidden", { status: 403 });
        if (srv.upgrade(req, { data: { id: ++wsCounter, kind: "cli" } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/login" && req.method === "POST") {
        const cfg = auth.get();
        if (!cfg.hash) return Response.redirect("/", 302);
        const ip = srv.requestIP(req)?.address ?? "?";
        if (!limiter.allowed(ip)) {
          return new Response(loginPage("too many attempts — wait a few minutes"), {
            status: 429, headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        const body = await req.text().catch(() => "");
        const password = new URLSearchParams(body).get("password") ?? "";
        const ok = password && (await Bun.password.verify(password, cfg.hash).catch(() => false));
        if (!ok) {
          return new Response(loginPage("wrong password"), {
            status: 401, headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": authCookie(makeToken(secret, cfg.days), cfg.days, isHttps(req)),
          },
        });
      }
      if (url.pathname === "/logout") {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": clearCookie() } });
      }
      // PWA metadata stays public (name + icons only) so the installed app
      // can boot to the login page
      if (url.pathname === "/manifest.json")
        return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json" } });
      if (url.pathname === "/icon-192.png")
        return new Response(Bun.file(icon192Path), { headers: { "content-type": "image/png" } });
      if (url.pathname === "/icon-512.png")
        return new Response(Bun.file(icon512Path), { headers: { "content-type": "image/png" } });
      if (!authed(req)) {
        if (url.pathname === "/" || url.pathname === "/login") {
          return new Response(loginPage(), {
            status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return new Response("unauthorized", { status: 401 });
      }
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { id: ++wsCounter, kind: "browser" } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/zen.mp3") {
        return new Response(Bun.file(zenMp3Path), { headers: { "content-type": "audio/mpeg" } });
      }
      if (url.pathname === "/xterm.js")
        return new Response(xtermJsRaw as unknown as string, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/xterm-fit.js")
        return new Response(xtermFitRaw as unknown as string, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/xterm.css")
        return new Response(xtermCssRaw as unknown as string, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/sw.js")
        return new Response(SW_JS, { headers: { "content-type": "text/javascript" } });
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
        ws.send(JSON.stringify({ t: "hello", defaultCwd: opts.defaultCwd, build: UI_BUILD }));
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
            terms.kill(ws.data.sid);
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
