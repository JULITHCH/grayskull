/**
 * Connects a running CLI (Ink) session to a grayskull-web hub, if one is up.
 * The TUI mirrors its events here; the hub forwards browser commands back
 * (prompt / mode / interrupt / permission answers). Fully optional: when no
 * hub is listening we retry quietly in the background.
 */

const RETRY_MS = 10_000;

export class CliLink {
  private url: string;
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  connected = false;

  /** Browser→CLI commands land here (set by the App). */
  onCommand: (msg: Record<string, unknown>) => void = () => {};
  /** Snapshot sent on every (re)connect (set by the App). */
  getRegistration: () => { cwd: string; mode: string; items: unknown[] } = () => ({
    cwd: process.cwd(),
    mode: "normal",
    items: [],
  });
  onStateChange: (connected: boolean) => void = () => {};

  constructor(url?: string) {
    this.url = url ?? process.env["GRAYSKULL_HUB"] ?? "ws://127.0.0.1:4242/cli";
  }

  start(): void {
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.dial();
    }, RETRY_MS);
  }

  private dial(): void {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        // register FIRST — the hub drops messages from unregistered sockets,
        // and onStateChange handlers publish status/memory immediately
        const reg = this.getRegistration();
        ws.send(JSON.stringify({ t: "register", ...reg }));
        this.onStateChange(true);
      };
      ws.onmessage = (e) => {
        try {
          this.onCommand(JSON.parse(String(e.data)) as Record<string, unknown>);
        } catch {
          // malformed hub message — ignore
        }
      };
      ws.onclose = () => {
        if (this.connected) {
          this.connected = false;
          this.onStateChange(false);
        }
        this.ws = null;
        this.scheduleRetry();
      };
      ws.onerror = () => {
        // onclose follows; retry handled there
      };
    } catch {
      this.scheduleRetry();
    }
  }

  publish(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        // hub gone mid-send — retry loop will recover
      }
    }
  }
}
