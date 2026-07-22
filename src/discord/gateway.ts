/**
 * Minimal Discord Gateway v10 client on Bun's native WebSocket — no library.
 * Handles identify (with presence), heartbeat + ack tracking, resume on
 * reconnect, and dispatches events to the bot. Fatal close codes (bad token,
 * missing privileged intents) surface via onFatal instead of retrying forever.
 */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** Gateway close codes that retrying can never fix. */
const FATAL_CLOSES: Record<number, string> = {
  4004: "authentication failed — check your bot token",
  4010: "invalid shard",
  4011: "sharding required — this bot is in too many guilds for a single connection",
  4012: "invalid API version",
  4013: "invalid intents",
  4014: "disallowed intents — enable MESSAGE CONTENT INTENT for the bot in the Discord developer portal (Bot → Privileged Gateway Intents)",
};

export interface GatewayPresence {
  status: "online" | "idle" | "dnd";
  /** type 3 = "Watching <name>" */
  activities: { name: string; type: number }[];
}

export interface GatewayOpts {
  token: string;
  intents: number;
  presence?: GatewayPresence;
  onDispatch: (event: string, data: Record<string, unknown>) => void;
  /** unrecoverable (bad token / disallowed intents) — caller should exit */
  onFatal: (reason: string) => void;
  log: (text: string) => void;
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export class DiscordGateway {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private hbAcked = true;
  private reconnectMs = 1000;
  private stopped = false;

  constructor(private opts: GatewayOpts) {}

  start(): void {
    this.stopped = false;
    this.connect(GATEWAY_URL);
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close(1000);
    this.ws = null;
  }

  private connect(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.opts.log(`gateway: connect failed (${(err as Error).message}) — retrying`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      try {
        this.handle(JSON.parse(String(ev.data)) as GatewayPayload);
      } catch {
        // malformed frame — ignore
      }
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return; // superseded connection
      this.clearHeartbeat();
      if (this.stopped) return;
      const fatal = FATAL_CLOSES[ev.code];
      if (fatal) {
        this.opts.onFatal(`gateway closed (${ev.code}): ${fatal}`);
        return;
      }
      // 4007/4009 invalidate the session; everything else may resume
      if (ev.code === 4007 || ev.code === 4009) this.sessionId = null;
      this.opts.log(`gateway: connection closed (${ev.code || "no code"}) — reconnecting`);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose fires afterwards and drives the retry
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 60_000);
    setTimeout(() => {
      if (this.stopped) return;
      const url = this.sessionId && this.resumeUrl ? this.resumeUrl : GATEWAY_URL;
      this.connect(url);
    }, delay);
  }

  private send(payload: GatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private handle(p: GatewayPayload): void {
    if (typeof p.s === "number") this.seq = p.s;
    switch (p.op) {
      case 10: {
        // hello → heartbeat loop + identify (or resume a previous session)
        const interval = Number((p.d as Record<string, unknown>)["heartbeat_interval"] ?? 41_250);
        this.startHeartbeat(interval);
        if (this.sessionId && this.seq !== null) this.resume();
        else this.identify();
        break;
      }
      case 11:
        this.hbAcked = true;
        this.reconnectMs = 1000; // acked = healthy connection
        break;
      case 1:
        this.send({ op: 1, d: this.seq });
        break;
      case 7:
        // server asks for a reconnect (resume-able)
        this.ws?.close(4900);
        break;
      case 9:
        // invalid session — resume only if the server says it's resumable
        if (p.d !== true) this.sessionId = null;
        this.ws?.close(4901);
        break;
      case 0: {
        const t = p.t ?? "";
        const d = (p.d ?? {}) as Record<string, unknown>;
        if (t === "READY") {
          this.sessionId = String(d["session_id"] ?? "");
          this.resumeUrl = d["resume_gateway_url"]
            ? `${String(d["resume_gateway_url"])}/?v=10&encoding=json`
            : null;
        }
        if (t === "RESUMED") this.opts.log("gateway: session resumed");
        this.opts.onDispatch(t, d);
        break;
      }
    }
  }

  private identify(): void {
    this.seq = null;
    this.send({
      op: 2,
      d: {
        token: this.opts.token,
        intents: this.opts.intents,
        properties: { os: process.platform, browser: "grayskull", device: "grayskull" },
        ...(this.opts.presence
          ? { presence: { ...this.opts.presence, since: null, afk: false } }
          : {}),
      },
    });
  }

  private resume(): void {
    this.opts.log("gateway: resuming session");
    this.send({
      op: 6,
      d: { token: this.opts.token, session_id: this.sessionId, seq: this.seq },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.hbAcked = true;
    // first beat jittered per the gateway docs, then steady interval
    setTimeout(() => this.send({ op: 1, d: this.seq }), intervalMs * Math.random());
    this.hbTimer = setInterval(() => {
      if (!this.hbAcked) {
        // zombie connection: no ack since our last beat — close and resume
        this.opts.log("gateway: heartbeat not acked — reconnecting");
        this.ws?.close(4902);
        return;
      }
      this.hbAcked = false;
      this.send({ op: 1, d: this.seq });
    }, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }
}
