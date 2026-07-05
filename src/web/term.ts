/** Per-session PTY terminals for grayskull-web: one real shell per session,
 *  spawned lazily in the session's project folder, streamed over the existing
 *  browser WebSocket as term_* messages. The shell survives panel toggles and
 *  browser reconnects (buffer replay); it dies with its session.
 *  Uses Bun's native PTY (Bun.spawn `terminal` option) — no native deps. */

/** replay buffer cap per terminal — enough scrollback to rehydrate a browser */
const BUF_MAX = 200_000;

interface Term {
  proc: Bun.Subprocess;
  buf: string;
}

export class TermManager {
  private terms = new Map<string, Term>();

  constructor(
    private ev: {
      onData: (sid: string, d: string) => void;
      onExit: (sid: string, code: number) => void;
    },
  ) {}

  /** Ensure a shell exists for the session; returns the replay buffer. */
  open(sid: string, cwd: string): string {
    const existing = this.terms.get(sid);
    if (existing) return existing.buf;
    const shell = process.env["SHELL"] || "bash";
    const dec = new TextDecoder();
    const t: Term = { proc: null as unknown as Bun.Subprocess, buf: "" };
    t.proc = Bun.spawn([shell], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: 100,
        rows: 28,
        data: (_term, data) => {
          const d = dec.decode(data);
          t.buf = (t.buf + d).slice(-BUF_MAX);
          this.ev.onData(sid, d);
        },
      },
    });
    this.terms.set(sid, t);
    void t.proc.exited.then((code) => {
      // only report if still tracked (kill() already removed deliberate deaths)
      if (this.terms.delete(sid)) this.ev.onExit(sid, code);
      try {
        t.proc.terminal?.close();
      } catch {
        /* already closed */
      }
    });
    return t.buf;
  }

  input(sid: string, d: string): void {
    try {
      this.terms.get(sid)?.proc.terminal?.write(d);
    } catch {
      /* shell died mid-write */
    }
  }

  resize(sid: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 2 || cols > 500 || rows < 2 || rows > 200) return;
    try {
      this.terms.get(sid)?.proc.terminal?.resize(cols, rows);
    } catch {
      /* pty already dead */
    }
  }

  kill(sid: string): void {
    const t = this.terms.get(sid);
    if (!t) return;
    this.terms.delete(sid);
    try {
      t.proc.kill();
      t.proc.terminal?.close();
    } catch {
      /* already gone */
    }
  }
}
