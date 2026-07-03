import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_DIR } from "../config/paths";

/**
 * Workers are user-created "plugins": a markdown playbook describing how to
 * perform one kind of action against the outside world (post to LinkedIn,
 * message a Discord channel, …) plus a config sidecar holding the credentials
 * and identifiers the playbook needs. The scheduler (or a chat turn) runs a
 * worker with a concrete task; the playbook + config are injected as the
 * system prompt of a headless agent run.
 */
export const WORKERS_DIR = join(GLOBAL_DIR, "workers");

export interface WorkerConfigField {
  key: string;
  /** what to ask the user for, e.g. "Discord webhook URL for the target channel" */
  description: string;
  /** secrets get chmod-600 storage and are masked in listings */
  secret?: boolean;
}

export interface WorkerDef {
  name: string;
  description: string;
  fields: WorkerConfigField[];
  /** the playbook: exact steps/commands/API calls to perform the action */
  instructions: string;
  filePath: string;
}

const configPath = (name: string) => join(WORKERS_DIR, `${name}.config.json`);

export function ensureWorkersDir(): void {
  if (!existsSync(WORKERS_DIR)) mkdirSync(WORKERS_DIR, { recursive: true });
}

/** `--- meta ---\nplaybook` — same shape as agent defs; fields are encoded as
 *  `field.<key>: [secret] <description>` lines so the frontmatter stays flat. */
function parseWorkerFile(path: string): WorkerDef | null {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  const fields: WorkerConfigField[] = [];
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    if (key.startsWith("field.")) {
      const secret = /^\[secret\]\s*/i.test(val);
      fields.push({ key: key.slice(6), description: val.replace(/^\[secret\]\s*/i, ""), ...(secret ? { secret: true } : {}) });
    } else {
      meta[key] = val;
    }
  }
  if (!meta["name"]) return null;
  return {
    name: meta["name"],
    description: meta["description"] ?? "",
    fields,
    instructions: m[2]!.trim(),
    filePath: path,
  };
}

export function loadWorkers(): WorkerDef[] {
  ensureWorkersDir();
  const defs: WorkerDef[] = [];
  for (const f of readdirSync(WORKERS_DIR)) {
    if (!f.endsWith(".md")) continue;
    try {
      const def = parseWorkerFile(join(WORKERS_DIR, f));
      if (def) defs.push(def);
    } catch {
      // unreadable definition — skip
    }
  }
  return defs;
}

export function loadWorker(name: string): WorkerDef | null {
  return loadWorkers().find((w) => w.name === name) ?? null;
}

export function writeWorkerDef(opts: {
  name: string;
  description: string;
  fields: WorkerConfigField[];
  instructions: string;
}): string {
  ensureWorkersDir();
  const fieldLines = opts.fields
    .map((f) => `field.${f.key}: ${f.secret ? "[secret] " : ""}${f.description}`)
    .join("\n");
  const content = `---\nname: ${opts.name}\ndescription: ${opts.description}\n${fieldLines ? fieldLines + "\n" : ""}---\n\n${opts.instructions}\n`;
  const path = join(WORKERS_DIR, `${opts.name}.md`);
  writeFileSync(path, content);
  return path;
}

export function deleteWorker(name: string): boolean {
  const def = loadWorker(name);
  if (!def) return false;
  unlinkSync(def.filePath);
  try {
    unlinkSync(configPath(name));
  } catch {
    // no config existed
  }
  return true;
}

/** Config values (credentials etc.). Stored 0600 — they contain secrets. */
export function loadWorkerConfig(name: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(configPath(name), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveWorkerConfig(name: string, values: Record<string, string>): void {
  ensureWorkersDir();
  const merged = { ...loadWorkerConfig(name), ...values };
  const path = configPath(name);
  writeFileSync(path, JSON.stringify(merged, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on exotic filesystems
  }
}

/** Config keys still unset — creation flow asks the user for exactly these. */
export function missingConfig(def: WorkerDef): WorkerConfigField[] {
  const have = loadWorkerConfig(def.name);
  return def.fields.filter((f) => !(f.key in have) || !have[f.key]);
}

/** Sidebar/system-prompt listing; secret values are never shown. */
export function workerListing(): string {
  const workers = loadWorkers();
  if (workers.length === 0) return "";
  return workers
    .map((w) => {
      const missing = missingConfig(w);
      const state = missing.length ? ` [NEEDS CONFIG: ${missing.map((f) => f.key).join(", ")}]` : "";
      return `- ${w.name}: ${w.description}${state}`;
    })
    .join("\n");
}

/** Structured listing for the web GUI. Config VALUES never leave the server —
 *  only whether each field is set. */
export function workerSummaries(): Array<{
  name: string;
  description: string;
  fields: Array<{ key: string; description: string; secret: boolean; set: boolean }>;
  configured: boolean;
}> {
  return loadWorkers().map((w) => {
    const have = loadWorkerConfig(w.name);
    const fields = w.fields.map((f) => ({
      key: f.key,
      description: f.description,
      secret: !!f.secret,
      set: !!have[f.key],
    }));
    return { name: w.name, description: w.description, fields, configured: fields.every((f) => f.set) };
  });
}

/** Ship ready-made Discord workers so the pattern is demonstrated and Discord
 *  works out of the box: discord-post (webhook, post-only, zero setup) and
 *  discord-bot (bot token, full REST: any channel, read, react, DM).
 *
 *  Starter defs are (re)written when absent OR when the on-disk playbook is a
 *  KNOWN prior shipped version (detected by a stale marker) — that migrates
 *  existing installs to fixes like the curl→http_request switch, while never
 *  clobbering a playbook the user has hand-edited. */
export function ensureStarterWorkers(): void {
  ensureWorkersDir();

  // markers present only in prior shipped versions; if the current file still
  // contains one, it's unedited and safe to replace with the newer playbook
  const staleMarkers = ["curl -sf -X POST", "curl -d @payload.json", "curl -sf -X POST \"$WEBHOOK_URL\""];
  const isStale = (name: string): boolean => {
    const w = loadWorker(name);
    if (!w) return true; // absent → write it
    return staleMarkers.some((m) => w.instructions.includes(m));
  };

  if (isStale("discord-bot")) {
    writeWorkerDef({
      name: "discord-bot",
      description: "Full Discord bot via REST: post/read messages in any channel, embeds, reactions, DMs",
      fields: [
        { key: "botToken", description: "Bot token (discord.com/developers → Applications → New Application → Bot → Reset Token). Invite the bot to your server via OAuth2 URL Generator with scope 'bot' and permissions Send Messages + Read Message History.", secret: true },
        { key: "defaultChannelId", description: "Default channel ID to act in (Discord: Settings → Advanced → Developer Mode on, then right-click channel → Copy Channel ID)" },
        { key: "guildId", description: "Server (guild) ID, for listing channels (right-click server name → Copy Server ID). Optional but recommended." },
      ],
      instructions: `You operate a Discord bot through the REST API (no gateway — you act, you don't listen). Base URL: https://discord.com/api/v10.

ALWAYS use the http_request tool — never curl. Pass the payload as json_body (a real JSON object): this serializes safely, so quotes/apostrophes/newlines/unicode in the text can never break the request. Every call needs headers { "Authorization": "Bot <botToken>" } (use the botToken from your CONFIG).

Use defaultChannelId unless the task names another channel.

POST a message:
  http_request(method="POST", url="https://discord.com/api/v10/channels/<channelId>/messages",
    headers={"Authorization":"Bot <botToken>"},
    json_body={"content": "text up to 2000 chars"})
  Split content over 2000 chars into several POSTs.
  Rich post: json_body={"embeds": [{"title": "...", "description": "up to 4096 chars", "color": 65280, "url": "..."}]}

READ recent messages: http_request(method="GET", url=".../channels/<channelId>/messages?limit=25", headers={...}) → array with id, author.username, content, timestamp (newest first).

REACT: http_request(method="PUT", url=".../channels/<channelId>/messages/<messageId>/reactions/<url-encoded-emoji>/@me", headers={...}) — 👍 is %F0%9F%91%8D. Empty 204 = ok.

REPLY: add "message_reference": {"message_id": "<id>"} to the POST json_body.

DM a user: http_request(method="POST", url=".../users/@me/channels", headers={...}, json_body={"recipient_id": "<userId>"}) → returns a channel id → POST to it like any channel.

LIST channels (find one by name): http_request(method="GET", url=".../guilds/<guildId>/channels", headers={...}) → pick id where type==0 (text).

Errors: 401/403 = bad token or missing permission/intent — report exactly which call failed. 429 = rate limited: read retry_after from the body, wait that long, retry once. Never print the token.`,
    });
  }
  if (!isStale("discord-post")) return;
  writeWorkerDef({
    name: "discord-post",
    description: "Post a message to a Discord channel via webhook",
    fields: [
      { key: "webhookUrl", description: "Discord webhook URL of the target channel (Server Settings → Integrations → Webhooks → New Webhook → Copy URL)", secret: true },
      { key: "username", description: "Display name for the bot poster (default: GRAYSKULL)" },
    ],
    instructions: `You post messages to a Discord channel through its webhook.

Compose the message content from the task you were given (write it yourself if the task describes what to post rather than giving literal text). Then deliver it with the http_request tool — NEVER curl:

http_request(
  method="POST",
  url="<webhookUrl from CONFIG>",
  json_body={"username": "<username from CONFIG, or GRAYSKULL>", "content": "<the message>"}
)

Passing json_body (a real JSON object) serializes the payload safely, so quotes, apostrophes, newlines and unicode in the message can never break escaping. Messages over 2000 characters must be split into several http_request calls. A 204 (empty body) means success; report what was posted. If you get 401 with code 50027 the webhook token is invalid — report that, don't retry.`,
  });
}
