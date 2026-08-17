import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { GLOBAL_DIR, ensureDirs, localDir, localSystemPrompt } from "../config/paths";
import { loadSettings, type Settings } from "../config/settings";
import { LlmClient } from "../llm/client";
import { ToolRegistry } from "../tools";
import { readTool, writeTool, editTool } from "../tools/files";
import { grepTool, globTool } from "../tools/search";
import { httpTool } from "../tools/http";
import { makeTodoTool } from "../tools/todo";
import { MemoryManager, loadGlobalMemory } from "../memory/memory";
import { loadAgents } from "../agents/registry";
import { McpManager } from "../mcp/manager";
import { GrayskullAgent, type UiBridge } from "../agent/loop";
import { DiscordGateway } from "./gateway";
import { DiscordRest, type DiscordMessage, type FileUpload } from "./rest";
import { SandboxPermissionEngine } from "./sandbox";
import { DEFAULT_DISCORD_PROMPT, discordBotDir } from "./prompt";
import { ReminderStore, makeReminderTools, type Reminder } from "./reminders";

/** GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT (privileged —
 *  must be enabled in the developer portal or the gateway closes with 4014). */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/** Discord hard message cap is 2000 — leave headroom for code-block closers. */
const CHUNK_SIZE = 1900;
const MAX_QUEUE = 8;
const TYPING_INTERVAL_MS = 8000;
/** Hard wall-clock cap per model turn. A turn that outlives it is aborted —
 *  the reply queue is strictly serial, so ONE wedged turn (stalled stream,
 *  hung MCP call, model grinding through tool iterations) would otherwise
 *  silence the bot forever: the exact "answers once, then nothing" symptom. */
const TURN_TIMEOUT_MS = 3 * 60_000;

/** Discord's default upload cap is 10 files / ~10 MB per message — stay under. */
const MAX_UPLOADS = 10;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** `[attach: relative/path]` on its own line → uploaded as a Discord file */
const ATTACH_RE = /^[ \t]*\[attach:[ \t]*([^\]\n]+?)[ \t]*\][ \t]*$/gim;

/** How long a cached per-guild nickname is trusted before it is re-read. The
 *  bot can be renamed at any time and GUILD_MEMBER_UPDATE needs the privileged
 *  GUILD_MEMBERS intent, so a plain TTL refresh is the reliable path. */
const NICK_TTL_MS = 10 * 60_000;

/** Incoming image attachments passed to the model (vision input). */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Code fences bigger than this leave the reply and become file uploads —
 *  deterministic enforcement of "large code as attachment", independent of
 *  whether the model remembered its write-tool + [attach:] discipline. */
const INLINE_CODE_MAX_CHARS = 900;
const INLINE_CODE_MAX_LINES = 30;

const CODE_EXT: Record<string, string> = {
  js: ".js", javascript: ".js", ts: ".ts", typescript: ".ts", tsx: ".tsx", jsx: ".jsx",
  py: ".py", python: ".py", rs: ".rs", rust: ".rs", go: ".go", sh: ".sh", bash: ".sh",
  zsh: ".sh", json: ".json", yaml: ".yaml", yml: ".yaml", html: ".html", css: ".css",
  c: ".c", h: ".h", cpp: ".cpp", java: ".java", kt: ".kt", sql: ".sql", md: ".md",
  toml: ".toml", xml: ".xml", php: ".php", rb: ".rb", ruby: ".rb", lua: ".lua",
  hs: ".hs", haskell: ".hs", swift: ".swift", cs: ".cs", csharp: ".cs", ps1: ".ps1",
  powershell: ".ps1", pl: ".pl", perl: ".pl", r: ".r", dart: ".dart", zig: ".zig",
  ex: ".ex", exs: ".exs", elixir: ".ex", scala: ".scala", clj: ".clj", nim: ".nim",
};

/** High-precision Swiss German markers — one hit is enough to flag a message.
 *  Local models otherwise mirror the dialect from the channel context; the
 *  system-prompt rule alone is too weak, so the harness detects and injects
 *  an explicit per-turn language directive (bot rule: Mundart → Hochdeutsch). */
const SWISS_RE =
  /\b(isch|nöd|nid|gsi|gseh|gha|hoi|sali|grüezi|merci vilmal|öppis|öpper|chli|bitzli|weisch|chasch|chunnt|chume|gäll|nüt|hät|händ|lueg|luegsch|würkli|villicht|eifach so|hüt|geschter|morn|dänk|uf em)\b/i;

export interface DiscordBotOpts {
  /** override settings.discord.dir / the default bot directory */
  dir?: string;
  /** unrecoverable gateway failure (bad token, disallowed intents). Default:
   *  exit the process (standalone grayskull-discord); embedded hosts
   *  (grayskull-web) pass a handler so the bot can't kill the server. */
  onFatal?: (reason: string) => void;
  /** called once the gateway logs in, with the bot's @tag */
  onReady?: (tag: string) => void;
}

export class DiscordBot {
  readonly botDir: string;
  private readonly settings: Settings;
  private readonly agent: GrayskullAgent;
  private readonly mcp: McpManager;
  private readonly rest: DiscordRest;
  private readonly gateway: DiscordGateway;
  private readonly log: (text: string) => void;
  private readonly opts: DiscordBotOpts;
  private readonly reminders: ReminderStore;
  private botUserId = "";
  /** the bot's account names (+ "grayskull" + configured extras), set on READY */
  private baseNames: string[] = [];
  /** guild id → the bot's nickname there ("" = none) */
  private guildNicks = new Map<string, string>();
  private nickFetchedAt = new Map<string, number>();
  private nickInflight = new Set<string>();
  /** name-call regexes, keyed by guild id ("" = base names only) */
  private nameRes = new Map<string, RegExp>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private warnedNoContent = false;

  constructor(token: string, opts: DiscordBotOpts = {}, log: (text: string) => void = console.error) {
    this.log = log;
    this.opts = opts;

    // the bot's whole world: a dedicated grayskull project directory
    const bootstrap = loadSettings(GLOBAL_DIR); // just to read discord.dir
    this.botDir = opts.dir ? resolve(opts.dir) : discordBotDir(bootstrap);
    ensureDirs(this.botDir);

    // seed the bot persona as the FULL system prompt (editable in place)
    const promptPath = localSystemPrompt(this.botDir);
    if (!existsSync(promptPath)) writeFileSync(promptPath, DEFAULT_DISCORD_PROMPT + "\n");

    const settings = loadSettings(this.botDir);
    settings.replaceSystemPrompt = true;
    settings.defaultMode = "normal";
    // coding-session gates make no sense for a chat bot
    settings.planFirst.enabled = false;
    settings.visualVerify.enabled = false;
    settings.promptExpand.enabled = false;
    settings.diagnostics.enabled = false;
    settings.stuckResearch.enabled = false;
    settings.addDirs = [];
    // a chat reply never needs the coding default of 120 tool iterations — a
    // confused model grinding through them looks exactly like a dead bot
    settings.maxLoopTurns = Math.min(settings.maxLoopTurns, 12);
    // web-only MCP: no playwright/LSP children for a chat bot
    settings.mcpServers = Object.fromEntries(
      Object.entries(settings.mcpServers).filter(([name]) => name === "searxng" || name === "context7"),
    );
    this.settings = settings;

    const client = new LlmClient(settings);
    const registry = new ToolRegistry();
    // deliberately NO bash, NO sub-agents, NO ask_user (nobody to answer it)
    for (const t of [readTool, writeTool, editTool, grepTool, globTool, httpTool, makeTodoTool().tool]) {
      registry.register(t);
    }
    // reminders fire back into the conversation they were created in: the
    // store owns the clock, the model only picks the time and the text
    this.reminders = new ReminderStore(
      join(localDir(this.botDir), "reminders.json"),
      (r) => this.sendReminder(r),
      (text) => this.log(text),
      settings.discord.maxRemindersPerUser,
    );
    if (settings.discord.reminders) for (const t of makeReminderTools(this.reminders)) registry.register(t);
    // hide every persona from auto-match: spawn_agent isn't registered here,
    // so "delegate to X" directives would only send the model into a wall
    settings.disabledAgents = loadAgents(this.botDir).map((a) => a.name);

    const perms = new SandboxPermissionEngine(settings, this.botDir);
    const memory = new MemoryManager(this.botDir, settings, client);
    // Discord users must never reach the operator's global vault — neither via
    // "always remember …" (rememberGlobal) nor via the post-turn extractor's
    // auto-promotion (promoteGlobal → mergeGlobal). Stub the single choke
    // point: a mergeGlobal that returns the unchanged vault writes nothing.
    memory.rememberGlobal = async () => "";
    (memory as unknown as { mergeGlobal: () => Promise<string> }).mergeGlobal =
      async () => loadGlobalMemory();
    memory.onNote = (text) => this.log(`  ${text}`);
    this.mcp = new McpManager(registry, this.botDir);

    const bridge: UiBridge = {
      pushItem: (item) => {
        if (item.type === "note") this.log(`  · ${item.text}`);
        else if (item.type === "tool" && item.state === "running") this.log(`  ⚙ ${item.detail}`);
        else if (item.type === "tool" && (item.state === "error" || item.state === "denied")) {
          this.log(`  ✗ ${item.detail} (${item.state})`);
        }
      },
      assistantDelta: () => {},
      reasoningDelta: () => {},
      assistantDone: () => {},
      // the sandbox engine never returns "ask", this is a pure backstop
      requestPermission: async () => "no",
      askUser: async () =>
        "No human is available (Discord bot). Decide yourself using best judgment and answer the message.",
      setBusy: () => {},
    };

    this.agent = new GrayskullAgent({
      cwd: this.botDir,
      settings,
      client,
      registry,
      perms,
      memory,
      ui: bridge,
    });

    this.rest = new DiscordRest(token);
    this.gateway = new DiscordGateway({
      token,
      intents: INTENTS,
      presence: { status: "online", activities: [{ name: settings.discord.statusText, type: 3 }] },
      onDispatch: (event, data) => this.onDispatch(event, data),
      onFatal: (reason) => {
        this.log(`✗ ${reason}`);
        if (this.opts.onFatal) this.opts.onFatal(reason);
        else process.exit(1);
      },
      log: (text) => this.log(text),
    });
  }

  async start(): Promise<void> {
    this.log(`bot directory (sandbox root): ${this.botDir}`);
    // web search must be up before the first question arrives — but never hang
    await Promise.race([this.mcp.connectAll(this.settings), new Promise((r) => setTimeout(r, 20_000))]);
    if (this.settings.discord.reminders) this.reminders.start();
    this.gateway.start();
  }

  async stop(): Promise<void> {
    this.reminders.stop();
    this.gateway.stop();
    await Promise.race([this.mcp.closeAll(), new Promise((r) => setTimeout(r, 1500))]);
  }

  private onDispatch(event: string, data: Record<string, unknown>): void {
    if (event === "READY") {
      const user = data["user"] as { id: string; username: string; global_name?: string | null } | undefined;
      this.botUserId = user?.id ?? "";
      // name-call detection matches the bot's ACTUAL Discord names, not just
      // "grayskull" — the account may be named anything (here: e.g. Fancypants).
      // Per-server nicknames come on top, from GUILD_CREATE / REST (see below).
      this.baseNames = ["grayskull", user?.username, user?.global_name, ...this.settings.discord.extraNames].filter(
        (n): n is string => !!n && n.trim().length > 1,
      );
      this.nameRes.clear();
      this.log(`✓ logged in as @${user?.username ?? "?"} (${this.botUserId}) — waiting for mentions (name-call: ${this.baseNames.join(", ")})`);
      this.opts.onReady?.(`@${user?.username ?? "?"}`);
      return;
    }
    // the bot's own member object rides along in GUILD_CREATE even without the
    // privileged GUILD_MEMBERS intent; if it doesn't, ask REST once
    if (event === "GUILD_CREATE") {
      const guildId = String(data["id"] ?? "");
      if (!guildId) return;
      const members = data["members"] as { user?: { id?: string }; nick?: string | null }[] | undefined;
      const me = members?.find((m) => m.user?.id === this.botUserId);
      if (me) this.setNick(guildId, (me.nick ?? "").trim());
      else void this.refreshNick(guildId);
      return;
    }
    // only delivered when GUILD_MEMBERS is enabled — free accuracy if it is
    if (event === "GUILD_MEMBER_UPDATE") {
      const user = data["user"] as { id?: string } | undefined;
      if (user?.id === this.botUserId) {
        this.setNick(String(data["guild_id"] ?? ""), String(data["nick"] ?? "").trim());
      }
      return;
    }
    if (event === "MESSAGE_CREATE") this.onMessage(data as unknown as DiscordMessage);
  }

  /** Cache the bot's nickname in a guild and rebuild that guild's name regex. */
  private setNick(guildId: string, nick: string): void {
    if (!guildId) return;
    this.nickFetchedAt.set(guildId, Date.now());
    if ((this.guildNicks.get(guildId) ?? "") === nick) return;
    this.guildNicks.set(guildId, nick);
    this.nameRes.delete(guildId);
    this.log(`· nickname in guild ${guildId}: ${nick || "(none — using account name)"}`);
  }

  private async refreshNick(guildId: string): Promise<void> {
    if (!guildId || !this.botUserId || this.nickInflight.has(guildId)) return;
    this.nickInflight.add(guildId);
    try {
      const member = await this.rest.guildMember(guildId, this.botUserId);
      this.setNick(guildId, (member.nick ?? "").trim());
    } catch (err) {
      // missing permission / rate limit: back off for a full TTL instead of
      // re-asking on every message
      this.nickFetchedAt.set(guildId, Date.now());
      this.log(`  ⚠ could not read my nickname in guild ${guildId}: ${(err as Error).message.slice(0, 120)}`);
    } finally {
      this.nickInflight.delete(guildId);
    }
  }

  private nickStale(guildId: string): boolean {
    return Date.now() - (this.nickFetchedAt.get(guildId) ?? 0) > NICK_TTL_MS;
  }

  /** How the bot appears in this conversation (nickname wins). */
  private selfName(guildId?: string): string {
    const nick = guildId ? this.guildNicks.get(guildId) : "";
    return nick || this.baseNames[1] || "grayskull";
  }

  /** Name-call regex for a guild: the account names plus the nickname the bot
   *  currently carries there. Unicode boundaries, so nicknames with emoji or
   *  punctuation around them still match. */
  private nameRegex(guildId?: string): RegExp | null {
    if (!this.baseNames.length) return null;
    const key = guildId ?? "";
    const cached = this.nameRes.get(key);
    if (cached) return cached;
    const nick = guildId ? this.guildNicks.get(guildId) : "";
    const names = [...new Set([...this.baseNames, ...(nick ? [nick] : [])].map((n) => n.trim()).filter((n) => n.length > 1))];
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "iu");
    this.nameRes.set(key, re);
    return re;
  }

  private onMessage(msg: DiscordMessage): void {
    if (!this.botUserId || !msg.author) return;
    if (msg.author.id === this.botUserId) return;
    // one line per received message: separates "event never arrived" (gateway
    // problem) from "arrived but was filtered" when diagnosing a silent bot
    if (this.settings.discord.logAllMessages) {
      this.log(
        `· seen ${displayName(msg.author)}${msg.author.bot ? " [bot]" : ""} in ${msg.guild_id ? `#${msg.channel_id}` : "DM"}: ${msg.content.slice(0, 80) || "(no text)"}`,
      );
    }
    if (msg.author.bot && this.settings.discord.ignoreBots) return;
    // guild/channel allow-lists (DMs have no guild_id and always pass)
    const { allowedGuilds, allowedChannels } = this.settings.discord;
    if (msg.guild_id && allowedGuilds.length > 0 && !allowedGuilds.includes(msg.guild_id)) {
      return this.logDrop("guild not in allowedGuilds");
    }
    if (msg.guild_id && allowedChannels.length > 0 && !allowedChannels.includes(msg.channel_id)) {
      return this.logDrop("channel not in allowedChannels");
    }
    if (!this.isAddressed(msg)) {
      // a rename we haven't seen yet must not cost the user a message: re-read
      // the nickname (at most once per TTL) and re-check this very message
      if (msg.guild_id && this.settings.discord.respondToName && this.nickStale(msg.guild_id)) {
        const guildId = msg.guild_id;
        void this.refreshNick(guildId).then(() => {
          if (this.isAddressed(msg)) this.enqueue(msg);
          else this.logDrop("not addressed (no @mention, reply-to-bot, DM, name or nickname)");
        });
        return;
      }
      return this.logDrop("not addressed (no @mention, reply-to-bot, DM, name or nickname)");
    }
    this.enqueue(msg);
  }

  private enqueue(msg: DiscordMessage): void {
    if (!msg.content && !this.warnedNoContent) {
      this.warnedNoContent = true;
      this.log("⚠ mention arrived with empty content — is MESSAGE CONTENT INTENT enabled in the developer portal?");
    }
    if (this.queued >= MAX_QUEUE) {
      this.log(`⚠ queue full (${MAX_QUEUE}) — dropping a mention in #${msg.channel_id}`);
      return;
    }
    this.queued++;
    // one agent, one turn at a time — mentions queue up in arrival order
    this.queue = this.queue
      .then(() => this.respond(msg))
      .catch((err) => this.log(`✗ responding failed: ${(err as Error).message}`))
      .finally(() => {
        this.queued--;
      });
  }

  private logDrop(reason: string): void {
    if (this.settings.discord.logAllMessages) this.log(`  ↳ dropped: ${reason}`);
  }

  /** Addressed = DM, @mention, reply to one of the bot's messages, or (opt-in)
   *  its name OR current per-server nickname written in plain text. */
  private isAddressed(msg: DiscordMessage): boolean {
    if (!msg.guild_id) return true; // DM
    if (msg.mentions?.some((u) => u.id === this.botUserId)) return true;
    if (msg.content.includes(`<@${this.botUserId}>`) || msg.content.includes(`<@!${this.botUserId}>`)) return true;
    if (msg.referenced_message?.author?.id === this.botUserId) return true;
    if (this.settings.discord.respondToName && this.nameRegex(msg.guild_id)?.test(msg.content)) return true;
    return false;
  }

  /** Deliver a due reminder into the conversation it was created in: same
   *  channel (mentioning the user) or same DM, as a reply to the request. */
  private async sendReminder(r: Reminder): Promise<void> {
    const body = r.guildId ? `<@${r.userId}> ${r.text}` : r.text;
    const chunks = chunkMessage(truncateReply(body, this.settings.discord.maxReplyChars));
    for (let i = 0; i < chunks.length; i++) {
      await this.rest.createMessage(r.channelId, chunks[i]!, i === 0 ? r.messageId : undefined);
    }
  }

  private async respond(msg: DiscordMessage): Promise<void> {
    const where = msg.guild_id ? `#${msg.channel_id}` : "DM";
    const author = displayName(msg.author);
    this.log(`▶ ${author} in ${where}: ${msg.content.slice(0, 120)}`);

    // reminders created during this turn belong to THIS conversation (the
    // reply queue is serial, so a single context slot is enough)
    this.reminders.setContext({
      channelId: msg.channel_id,
      ...(msg.guild_id ? { guildId: msg.guild_id } : {}),
      messageId: msg.id,
      userId: msg.author.id,
      userName: author,
    });
    // typing indicator while the model works (lasts ~10s per trigger)
    void this.rest.triggerTyping(msg.channel_id).catch(() => {});
    const typing = setInterval(() => void this.rest.triggerTyping(msg.channel_id).catch(() => {}), TYPING_INTERVAL_MS);

    try {
      const maxChars = this.settings.discord.maxReplyChars;
      const context = await this.channelContext(msg);
      // dialect handling is enforced HERE, per turn: local models mirror the
      // channel's dialect no matter what the system prompt says, so the last
      // instruction they read must pin the output language explicitly
      const langLine = SWISS_RE.test(msg.content)
        ? "LANGUAGE: the message is Swiss German dialect — you MUST write your reply in STANDARD GERMAN (Hochdeutsch). Writing Swiss German dialect is forbidden, even though the channel uses it."
        : "LANGUAGE: reply in the language of the message (if it is Swiss German dialect, use Standard German instead).";
      // image attachments on the triggering message → vision input
      const { images, imageNames } = await this.fetchImages(msg);
      const prompt = [
        `[Discord] You were addressed ${msg.guild_id ? "in a server channel" : "in a direct message"} by ${author}. ` +
          `In this conversation you are displayed as "${this.selfName(msg.guild_id)}" — people may call you by that name instead of @mentioning you.` +
          `\nCurrent local time: ${formatNow()}.` +
          (this.settings.discord.reminders
            ? `\nReminders: if ${author} wants to be reminded of something later, call create_reminder(when, message) — it fires ${msg.guild_id ? "in this channel and @mentions them" : "here in this DM"} when the time comes. list_reminders / cancel_reminder manage the pending ones. Never promise a reminder without the tool call, and never try to wait for the time yourself.`
            : ""),
        context ? `Recent channel history (oldest first):\n${context}` : "(no channel history available)",
        `The message addressed to you:\n${author}: ${msg.content || "(no text — attachment only)"}` +
          (imageNames.length ? `\n(attached image${imageNames.length > 1 ? "s" : ""}, shown to you: ${imageNames.join(", ")})` : ""),
        `Reply to this message now, following your rules: as SHORT and precise as possible, NO emojis (hard limit ${maxChars} characters — anything longer is cut off), web-verify factual claims, larger code as a file + [attach: path] marker.\n${langLine}`,
      ].join("\n\n");

      // stateless per mention: the channel history IS the conversation memory
      this.agent.history = [];
      let raw = (await this.runTurnGuarded(prompt, images)).trim();
      // a text-only model 400s on image parts — retry once without them
      if (!raw && images.length && this.agent.lastError) {
        this.log(`  ⚠ turn failed with images (${this.agent.lastError.slice(0, 100)}) — retrying text-only`);
        this.agent.history = [];
        raw = (await this.runTurnGuarded(
          `${prompt}\n\n(Note: the attached image could not be delivered to you — if it matters for the answer, say you could not view it.)`,
        )).trim();
      }
      let extraction = this.extractAttachments(raw);
      // marker for a file the model never wrote (the observed failure mode):
      // ONE recovery turn — same conversation, so it sees its own mistake
      if (extraction.missing.length) {
        this.log(`  ⚠ marker without file (${extraction.missing.join(", ")}) — one recovery turn`);
        const recovery = (await this.runTurnGuarded(
          `[Harness] Your reply contained ${extraction.missing.map((m) => `[attach: ${m}]`).join(" and ")} but no such file exists in your bot directory — nothing was uploaded and the user saw a broken reply. Fix it NOW, one of two ways: (a) put the code directly in your reply as a fenced \`\`\`lang block, or (b) FIRST create the file with the write tool, THEN reply with the [attach: ...] marker again. Send the complete corrected reply.`,
        )).trim();
        if (recovery) extraction = this.extractAttachments(recovery);
      }
      const { text: unmarked, files } = extraction;
      // fenced code → file uploads: all blocks (discord.attachAllCode, default)
      // or only oversized ones — independent of the model's tool discipline
      const { text, extracted } = externalizeLargeCode(unmarked, this.settings.discord.attachAllCode);
      for (const x of extracted) {
        if (files.length >= MAX_UPLOADS) break;
        files.push({ name: x.name, data: new TextEncoder().encode(x.content) });
      }
      const answer = truncateReply(text, maxChars);
      const chunks = chunkMessage(answer || (files.length ? "" : "(no answer produced — try asking again)"));
      for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0;
        if (!chunks[i] && !(isFirst && files.length)) continue; // never send an empty message
        await this.rest.createMessage(
          msg.channel_id,
          chunks[i]!,
          isFirst ? msg.id : undefined,
          isFirst ? files : undefined,
        );
      }
      this.log(`✓ replied in ${where} (${answer.length} chars${files.length ? `, ${files.length} file${files.length > 1 ? "s" : ""}` : ""})`);
    } catch (err) {
      const reason = (err as Error).message.slice(0, 180);
      this.log(`✗ turn failed: ${reason}`);
      await this.rest
        .createMessage(msg.channel_id, "something broke on my end — try again in a moment.", msg.id)
        .catch(() => {});
    } finally {
      clearInterval(typing);
      this.reminders.setContext(null);
    }
  }

  /** agent.runTurn with a hard wall-clock cap: on timeout the turn is aborted
   *  (agent.stop) and "" returned, so the serial reply queue always drains. */
  private async runTurnGuarded(prompt: string, images: string[] = []): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TURN_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([this.agent.runTurn(prompt, images), timeout]);
      if (result !== null) return result;
      this.log(`  ⚠ turn exceeded ${TURN_TIMEOUT_MS / 1000}s — aborting it`);
      this.agent.stop();
      // let the abort unwind so the next turn starts on a clean agent
      await new Promise((r) => setTimeout(r, 1500));
      return "";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Download the trigger message's image attachments as data URIs so the
   *  model can look at them (vision input). Non-images and oversized files
   *  are skipped silently. */
  private async fetchImages(msg: DiscordMessage): Promise<{ images: string[]; imageNames: string[] }> {
    const images: string[] = [];
    const imageNames: string[] = [];
    for (const a of msg.attachments ?? []) {
      if (images.length >= MAX_IMAGES) break;
      if (!a.content_type?.startsWith("image/")) continue;
      if ((a.size ?? 0) > MAX_IMAGE_BYTES) continue;
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_IMAGE_BYTES) continue;
        images.push(`data:${a.content_type};base64,${Buffer.from(buf).toString("base64")}`);
        imageNames.push(a.filename);
      } catch (err) {
        this.log(`  ⚠ could not download attachment ${a.filename}: ${(err as Error).message}`);
      }
    }
    if (imageNames.length) this.log(`  🖼 ${imageNames.length} image${imageNames.length > 1 ? "s" : ""} attached: ${imageNames.join(", ")}`);
    return { images, imageNames };
  }

  /** Pull `[attach: path]` markers out of the answer and load the referenced
   *  files (bot-dir only, size/count capped) as Discord uploads. Invalid
   *  markers are replaced with a short note instead of leaking the marker. */
  private extractAttachments(answer: string): { text: string; files: FileUpload[]; missing: string[] } {
    const files: FileUpload[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    const text = answer
      .replace(ATTACH_RE, (_line, rel: string) => {
        const full = resolve(this.botDir, rel);
        const inside = full === this.botDir || full.startsWith(this.botDir + sep);
        if (inside && !existsSync(full)) missing.push(rel); // retryable — see respond()
        if (!inside || !existsSync(full)) {
          this.log(`  ⚠ attach marker ignored (${!inside ? "outside bot dir" : "missing file"}): ${rel}`);
          return `*(attachment ${basename(rel)} unavailable)*`;
        }
        if (seen.has(full)) return "";
        if (files.length >= MAX_UPLOADS || statSync(full).size > MAX_UPLOAD_BYTES) {
          this.log(`  ⚠ attach marker ignored (too many files or > 8MB): ${rel}`);
          return `*(attachment ${basename(rel)} too large)*`;
        }
        seen.add(full);
        files.push({ name: basename(full), data: new Uint8Array(readFileSync(full)) });
        return "";
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, files, missing };
  }

  /** Last N channel messages as a compact transcript, oldest first, without
   *  the triggering message itself. */
  private async channelContext(trigger: DiscordMessage): Promise<string> {
    try {
      const raw = await this.rest.recentMessages(trigger.channel_id, this.settings.discord.contextMessages);
      const lines: string[] = [];
      for (const m of raw.reverse()) {
        if (m.id === trigger.id) continue;
        const parts: string[] = [];
        if (m.content) parts.push(m.content.length > 600 ? m.content.slice(0, 600) + "…" : m.content);
        for (const a of m.attachments ?? []) parts.push(`[attachment: ${a.filename}]`);
        if (!parts.length) continue;
        const who = m.author.id === this.botUserId ? `${this.selfName(trigger.guild_id)} (you)` : displayName(m.author);
        lines.push(`${who}${m.author.bot && m.author.id !== this.botUserId ? " [bot]" : ""}: ${parts.join(" ")}`);
      }
      // cap the transcript so a busy channel can't eat the window
      let text = lines.join("\n");
      if (text.length > 8000) text = "…\n" + text.slice(-8000);
      return text;
    } catch (err) {
      this.log(`  ⚠ could not fetch channel history: ${(err as Error).message}`);
      return "";
    }
  }
}

function displayName(user: { username: string; global_name?: string | null }): string {
  return user.global_name || user.username;
}

/** Unambiguous wall-clock stamp for the model: "Saturday, 2026-07-25 14:32
 *  (Europe/Zurich)" — without it a model cannot resolve "morgen um 9". */
function formatNow(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${now.toLocaleDateString("en-US", { weekday: "long" })}, ${stamp}${tz ? ` (${tz})` : ""}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Move fenced code blocks out of the reply text into named virtual files
 *  (uploaded as attachments): every block when `all` (discord.attachAllCode),
 *  otherwise only oversized ones. */
export function externalizeLargeCode(text: string, all = false): { text: string; extracted: { name: string; content: string }[] } {
  const extracted: { name: string; content: string }[] = [];
  const out = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (block, lang: string, code: string) => {
    const lines = code.split("\n").length;
    if (!all && block.length <= INLINE_CODE_MAX_CHARS && lines <= INLINE_CODE_MAX_LINES) return block;
    if (!code.trim()) return block; // empty fence — nothing to attach
    const ext = CODE_EXT[lang.trim().toLowerCase()] ?? ".txt";
    const name = `code-${extracted.length + 1}${ext}`;
    extracted.push({ name, content: code });
    return `*(code attached: ${name})*`;
  });
  return { text: out, extracted };
}

/** Hard cap on reply length: cut at a line boundary where possible, close an
 *  open code fence so Discord doesn't render the rest of the message as code. */
export function truncateReply(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 8));
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > max * 0.6) cut = cut.slice(0, lastNewline);
  cut = cut.trimEnd();
  const fenceCount = (cut.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) cut += "\n```";
  return cut + "\n…";
}

/** Split on line boundaries into Discord-sized chunks. */
export function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // a single overlong line gets hard-split
    let rest = line;
    while (rest.length > CHUNK_SIZE) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(rest.slice(0, CHUNK_SIZE));
      rest = rest.slice(CHUNK_SIZE);
    }
    if (current && current.length + rest.length + 1 > CHUNK_SIZE) {
      chunks.push(current);
      current = rest;
    } else {
      current = current ? `${current}\n${rest}` : rest;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
