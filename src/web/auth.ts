import { existsSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { join } from "node:path";
import { GLOBAL_DIR, GLOBAL_SETTINGS } from "../config/paths";

/**
 * Login for grayskull-web — the interface drives a shell-wielding agent, so an
 * exposed port must be gated. Single shared password:
 *
 *   - hash: argon2id via Bun.password, stored in settings.json `web.passwordHash`
 *     (set with `grayskull-web --set-password`); no hash = auth disabled
 *     (trusted network), with a loud startup warning when binding non-loopback
 *   - session: stateless signed token `exp.hmac(exp, secret)` in an HttpOnly
 *     cookie; the secret is random, persisted at ~/.config/grayskull/web-secret
 *     (chmod 600) so logins survive server restarts
 *   - /cli (the TUI bridge) is loopback-only, never cookie-gated — the TUI has
 *     no browser. NOTE: a reverse proxy on the same host makes proxied clients
 *     look loopback; keep /cli unproxied in that setup.
 *   - login attempts are rate-limited per IP (argon2 is slow by design, this
 *     just stops hammering)
 */

export const COOKIE_NAME = "gs_auth";
const SECRET_FILE = join(GLOBAL_DIR, "web-secret");

/** Live view of the web-login config: re-reads the raw global settings.json
 *  when its mtime changes, so a password set in the ⚙ settings GUI (or via
 *  --set-password) takes effect on the next request — no server restart. */
export class AuthConfig {
  private mtime = -1;
  private cached: { hash?: string; days: number } = { days: 30 };

  get(): { hash?: string; days: number } {
    try {
      const st = statSync(GLOBAL_SETTINGS);
      if (st.mtimeMs !== this.mtime) {
        const raw = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf8")) as Record<string, unknown>;
        const web = (raw["web"] ?? {}) as Record<string, unknown>;
        const days = Number(web["sessionDays"]);
        const next: { hash?: string; days: number } = { days: days > 0 ? days : 30 };
        if (typeof web["passwordHash"] === "string" && web["passwordHash"]) {
          next.hash = web["passwordHash"];
        }
        this.cached = next;
        this.mtime = st.mtimeMs; // only after a successful parse
      }
    } catch {
      // missing file on first run = auth off; on a transient read/parse error
      // keep the last known config rather than silently dropping the gate
      if (this.mtime === -1 && !existsSync(GLOBAL_SETTINGS)) this.cached = { days: 30 };
    }
    return this.cached;
  }
}

export function loadOrCreateSecret(): Buffer {
  if (existsSync(SECRET_FILE)) {
    const hex = readFileSync(SECRET_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  }
  const secret = randomBytes(32);
  writeFileSync(SECRET_FILE, secret.toString("hex") + "\n");
  chmodSync(SECRET_FILE, 0o600);
  return secret;
}

function sign(exp: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(exp).digest("hex");
}

export function makeToken(secret: Buffer, days: number): string {
  const exp = String(Date.now() + days * 86_400_000);
  return `${exp}.${sign(exp, secret)}`;
}

export function checkToken(secret: Buffer, token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp, secret), "hex");
  const got = Buffer.from(mac.padEnd(64, "0").slice(0, 64), "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

export function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function authCookie(token: string, days: number, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(days * 86_400)}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Secure cookies only make sense when the client actually speaks https
 *  (directly or via a proxy that says so). */
export function isHttps(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
}

export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Sliding-window login limiter: N tries per IP per window. */
export class LoginLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private max = 10, private windowMs = 5 * 60_000) {}

  allowed(ip: string): boolean {
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || now > h.resetAt) {
      this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    h.count++;
    if (this.hits.size > 10_000) this.hits.clear(); // bounded memory, worst case resets windows
    return h.count <= this.max;
  }
}

/** Self-contained login page: a 3D cube flies in from deep space, GRAYSKULL
 *  on its front face, then flips around — the login form is on its back.
 *  On a failed attempt the cube skips the intro (already flipped) and shakes.
 *  prefers-reduced-motion gets the form directly. */
export function loginPage(error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GRAYSKULL // LOGIN</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  :root { --g: #00ff66; --s: min(320px, 82vmin); --h: calc(var(--s) / 2); }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #010701; color: var(--g); font-family: "JetBrains Mono","Fira Code",monospace;
    overflow: hidden; }
  /* faint star field so the fly-in reads as depth */
  body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
    background:
      radial-gradient(1px 1px at 12% 22%, rgba(0,255,102,.5), transparent 40%),
      radial-gradient(1px 1px at 78% 14%, rgba(0,255,102,.35), transparent 40%),
      radial-gradient(2px 2px at 62% 74%, rgba(0,221,255,.3), transparent 40%),
      radial-gradient(1px 1px at 30% 82%, rgba(0,255,102,.4), transparent 40%),
      radial-gradient(1px 1px at 90% 55%, rgba(0,255,102,.3), transparent 40%); }
  .scene { perspective: 1200px; width: var(--s); height: var(--s); }
  .cube { position: relative; width: 100%; height: 100%; transform-style: preserve-3d;
    animation: fly 1.7s cubic-bezier(.15,.75,.25,1) forwards,
               flip 1s cubic-bezier(.65,0,.2,1) 2.2s forwards; }
  @keyframes fly { from { transform: translateZ(-3600px) rotateX(38deg) rotateY(-200deg); }
                   to   { transform: translateZ(0) rotateX(0) rotateY(0); } }
  @keyframes flip { to { transform: rotateY(180deg); } }
  .face { position: absolute; inset: 0; border: 1px solid var(--g);
    background: rgba(1,12,3,.9); backface-visibility: hidden;
    box-shadow: inset 0 0 60px rgba(0,255,102,.1);
    display: flex; align-items: center; justify-content: center; flex-direction: column; }
  .face.front  { transform: rotateY(0deg)   translateZ(var(--h)); }
  .face.back   { transform: rotateY(180deg) translateZ(var(--h)); }
  .face.right  { transform: rotateY(90deg)  translateZ(var(--h)); }
  .face.left   { transform: rotateY(-90deg) translateZ(var(--h)); }
  .face.top    { transform: rotateX(90deg)  translateZ(var(--h)); }
  .face.bottom { transform: rotateX(-90deg) translateZ(var(--h)); }
  .face.side { background: rgba(1,9,2,.85); border-color: rgba(0,255,102,.45);
    background-image: repeating-linear-gradient(0deg, transparent 0 6px, rgba(0,255,102,.05) 6px 7px); }
  .face.side span { font-size: calc(var(--s) * .07); color: rgba(0,255,102,.25); letter-spacing: 6px; }
  .logo { font-weight: 700; font-size: calc(var(--s) * .11); letter-spacing: calc(var(--s) * .012);
    text-shadow: 0 0 14px var(--g), 0 0 40px rgba(0,255,102,.6); animation: flicker 5s infinite; }
  .logo small { display: block; text-align: center; font-size: calc(var(--s) * .038);
    color: #2f7f4f; letter-spacing: 5px; margin-top: 12px; text-shadow: none; }
  @keyframes flicker { 0%,92%,100% {opacity:1} 93% {opacity:.5} 94% {opacity:1} 97% {opacity:.7} 98% {opacity:1} }
  form { width: 78%; }
  h1 { font-size: calc(var(--s) * .05); letter-spacing: 4px; margin-bottom: 4px; text-shadow: 0 0 10px var(--g); }
  p { font-size: calc(var(--s) * .034); color: #2f7f4f; margin-bottom: 18px; letter-spacing: 1px; }
  input { width: 100%; background: #02120a; color: #baffd4; border: 1px solid #1c5c38;
    padding: 10px 12px; font: inherit; font-size: 14px; outline: none; }
  input:focus { border-color: var(--g); box-shadow: 0 0 10px rgba(0,255,102,.35); }
  button { width: 100%; margin-top: 12px; padding: 10px; background: none; border: 1px solid var(--g);
    color: var(--g); font: inherit; font-size: 13px; letter-spacing: 3px; cursor: pointer; }
  button:hover { background: rgba(0,255,102,.12); text-shadow: 0 0 8px var(--g); }
  .err { color: #ff2244; font-size: 12px; margin-bottom: 10px; }
  /* failed attempt: no intro — cube is already turned, shakes once */
  body.failed .cube { animation: shake .5s ease-out forwards; transform: rotateY(180deg); }
  @keyframes shake { 0%,100% { transform: rotateY(180deg); }
    20% { transform: rotateY(184deg); } 40% { transform: rotateY(176deg); }
    60% { transform: rotateY(182.5deg); } 80% { transform: rotateY(177.5deg); } }
  @media (prefers-reduced-motion: reduce) {
    .cube, body.failed .cube { animation: none; transform: rotateY(180deg); }
    .logo { animation: none; }
  }
</style></head><body${error ? ' class="failed"' : ""}>
<div class="scene"><div class="cube">
  <div class="face front"><div class="logo">GRAYSKULL<small>// WEB</small></div></div>
  <div class="face back">
    <form method="post" action="/login">
      <h1>▮ AUTHENTICATE</h1>
      <p>RESTRICTED SYSTEM</p>
      ${error ? `<div class="err">✗ ${error}</div>` : ""}
      <input type="password" name="password" placeholder="password" autocomplete="current-password">
      <button type="submit">ENTER</button>
    </form>
  </div>
  <div class="face right side"><span>▮▮▮</span></div>
  <div class="face left side"><span>▮▮▮</span></div>
  <div class="face top side"></div>
  <div class="face bottom side"></div>
</div></div>
<script>
  // focus once the back face is toward the camera (intro ~3.2s, failed ~0.5s)
  setTimeout(() => document.querySelector("input").focus(),
    document.body.classList.contains("failed") ? 550 : 3300);
</script>
</body></html>`;
}
