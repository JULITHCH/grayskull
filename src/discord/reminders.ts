import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { ToolDef } from "../types";

/**
 * One-off reminders for the Discord bot: "erinnere mich in 2h an X".
 *
 * The store is the whole feature — the model only decides WHEN and WHAT, the
 * harness owns the clock and the delivery. Reminders are persisted next to the
 * bot's memory so a restart (the web supervisor respawns the child on crash)
 * never loses one, and they fire back into the conversation they were created
 * in: DM → the same DM, channel → the same channel (with an @mention).
 */

export interface Reminder {
  id: string;
  channelId: string;
  /** absent = direct message */
  guildId?: string;
  /** message that asked for the reminder — replied to on delivery */
  messageId?: string;
  userId: string;
  userName: string;
  text: string;
  dueAt: number;
  createdAt: number;
  /** failed delivery attempts; dropped after MAX_ATTEMPTS */
  attempts?: number;
}

/** Where a reminder created during the current turn has to fire. Set by the
 *  bot before each turn (the reply queue is serial, so one slot suffices). */
export interface ReminderContext {
  channelId: string;
  guildId?: string;
  messageId?: string;
  userId: string;
  userName: string;
}

const TICK_MS = 15_000;
const MAX_ATTEMPTS = 3;
/** below this a reminder is pointless — the reply itself arrives later */
const MIN_LEAD_MS = 5_000;
const MAX_LEAD_MS = 365 * 86_400_000;

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  sek: 1000, sekunde: 1000, sekunden: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, minuten: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  std: 3_600_000, stunde: 3_600_000, stunden: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000, tag: 86_400_000, tage: 86_400_000, tagen: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000, woche: 604_800_000, wochen: 604_800_000,
};

/** Local models write "in zwei Stunden" as readily as "in 2h". */
const WORD_NUM: Record<string, number> = {
  ein: 1, eine: 1, einer: 1, einem: 1, eins: 1, one: 1, a: 1, an: 1,
  zwei: 2, two: 2, drei: 3, three: 3, vier: 4, four: 4, fünf: 5, funf: 5, five: 5,
  sechs: 6, six: 6, sieben: 7, seven: 7, acht: 8, eight: 8, neun: 9, nine: 9,
  zehn: 10, ten: 10, zwölf: 12, zwolf: 12, twelve: 12, halbe: 0.5, halben: 0.5, half: 0.5,
};

/** Note the trailing "not a letter": a plain \b would break "1h30m", where the
 *  unit is followed by a digit. */
const DURATION_RE = new RegExp(
  `(\\d+(?:[.,]\\d+)?|${Object.keys(WORD_NUM).join("|")})\\s*(${Object.keys(UNIT_MS).join("|")})(?!\\p{L})`,
  "giu",
);

/** Times of day the model may write instead of a clock time. */
const DAYPART_HOUR: Record<string, number> = {
  früh: 8, frueh: 8, morgens: 8, morning: 8, vormittag: 10,
  mittag: 12, mittags: 12, noon: 12, nachmittag: 15, nachmittags: 15, afternoon: 15,
  abend: 20, abends: 20, evening: 20, nacht: 22, nachts: 22, night: 22,
};

function numberOf(token: string): number {
  const word = WORD_NUM[token.toLowerCase()];
  if (word !== undefined) return word;
  return Number(token.replace(",", "."));
}

/** Absolute timestamp for a clock time today, or tomorrow if already past. */
function nextClock(now: number, hour: number, minute: number, dayOffset = 0): number {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  if (dayOffset === 0 && d.getTime() <= now + MIN_LEAD_MS) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Parse the model's `when` string into an absolute timestamp. Accepts durations
 * ("10m", "in 90 minuten", "1h30m"), clock times ("18:00", "9 uhr"), day words
 * ("morgen 09:00", "übermorgen"), and explicit dates ("2026-07-26 09:00",
 * "26.07.2026 09:00"). Returns null when nothing usable was found — the tool
 * then hands the accepted formats back to the model instead of guessing.
 */
export function parseWhen(input: string, now = Date.now()): number | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // leading filler the model likes to include ("in 10 minuten", "am 26.07.")
  s = s.replace(/^(?:in|nach|after|at|um|am|gegen|around|about|ca\.?|etwa|by|bis)\s+/i, "").replace(/^\+/, "").trim();

  // ISO-ish date, optionally with a time (bare date → 09:00 local)
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]\s*(\d{1,2})[:.](\d{2}))?/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 9), Number(iso[5] ?? 0), 0, 0);
    return inRange(d.getTime(), now);
  }
  // German date: 26.07.2026 09:00 / 26.07. 9 uhr
  const de = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?\s*(?:um\s*)?(?:(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?)?/);
  if (de && de[1] && de[2]) {
    const year = de[3] ? Number(de[3]) : new Date(now).getFullYear();
    const d = new Date(year, Number(de[2]) - 1, Number(de[1]), Number(de[4] ?? 9), Number(de[5] ?? 0), 0, 0);
    // "26.07." without a year that already passed means next year
    if (!de[3] && d.getTime() < now) d.setFullYear(year + 1);
    return inRange(d.getTime(), now);
  }

  // day words, with an optional clock time or daypart behind them
  // ("morgen 07:15", "morgen früh", "heute abend", "übermorgen")
  const dayWord = s.match(/^(übermorgen|ubermorgen|morgen|tomorrow|heute|today|tonight)\b/);
  if (dayWord) {
    const word = dayWord[1]!;
    const rest = s.slice(dayWord[0].length).replace(/^(?:um|at|gegen|around)\s+/, "").trim();
    const offset = word.startsWith("übermorgen") || word.startsWith("ubermorgen") ? 2 : word === "morgen" || word === "tomorrow" ? 1 : 0;
    const clock = matchClock(rest);
    const daypart = DAYPART_HOUR[rest.split(/\s+/)[0] ?? ""];
    const hour = clock?.hour ?? daypart ?? (word === "tonight" ? 20 : 9);
    return inRange(nextClock(now, hour, clock?.minute ?? 0, offset), now);
  }

  // bare clock time → today, or tomorrow if it already passed
  const clock = matchClock(s);
  if (clock) return inRange(nextClock(now, clock.hour, clock.minute), now);

  // durations, possibly chained ("1h 30m", "2 stunden und 15 minuten")
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(DURATION_RE)) {
    const n = numberOf(m[1]!);
    const unit = UNIT_MS[m[2]!.toLowerCase()];
    if (!Number.isFinite(n) || unit === undefined) continue;
    total += n * unit;
    matched = true;
  }
  if (matched && total > 0) return inRange(now + total, now);
  return null;
}

function matchClock(s: string): { hour: number; minute: number } | null {
  // deliberately no "h" marker: "2h" is a duration, not 02:00
  const m = s.match(/^(?:um\s*|at\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(uhr|am|pm)?\s*$/);
  if (!m) return null;
  // a bare number without a clock marker is a duration ("10 min"), not a time
  if (!m[2] && !m[3]) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function inRange(ts: number, now: number): number | null {
  if (!Number.isFinite(ts)) return null;
  if (ts < now + MIN_LEAD_MS || ts > now + MAX_LEAD_MS) return null;
  return ts;
}

/** "in 3h 28m" — how far away a reminder is, for confirmations and listings. */
export function formatDelta(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

export function formatWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const stamp = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}. ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${stamp} (in ${formatDelta(ts - now)})`;
}

export class ReminderStore {
  private items: Reminder[] = [];
  private ctx: ReminderContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing = new Set<string>();
  private seq = 0;

  constructor(
    private readonly file: string,
    private readonly deliver: (r: Reminder) => Promise<void>,
    private readonly log: (text: string) => void,
    private readonly maxPerUser = 20,
  ) {
    this.load();
  }

  start(): void {
    if (this.timer) return;
    const pending = this.items.length;
    if (pending) this.log(`⏰ ${pending} reminder${pending > 1 ? "s" : ""} pending`);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // overdue ones (restart while a reminder was due) fire right away
    setTimeout(() => void this.tick(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The conversation a reminder created right now belongs to. */
  setContext(ctx: ReminderContext | null): void {
    this.ctx = ctx;
  }

  context(): ReminderContext | null {
    return this.ctx;
  }

  create(text: string, dueAt: number): Reminder {
    const ctx = this.ctx;
    if (!ctx) throw new Error("no conversation context — reminders can only be set while answering a message");
    const mine = this.items.filter((r) => r.userId === ctx.userId);
    if (mine.length >= this.maxPerUser) {
      throw new Error(`you already have ${mine.length} pending reminders (the limit) — cancel one first`);
    }
    const reminder: Reminder = {
      id: this.nextId(),
      channelId: ctx.channelId,
      ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
      ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
      userId: ctx.userId,
      userName: ctx.userName,
      text: text.trim().slice(0, 1000),
      dueAt,
      createdAt: Date.now(),
    };
    this.items.push(reminder);
    this.save();
    this.log(`⏰ reminder ${reminder.id} for ${ctx.userName} at ${formatWhen(dueAt)}: ${reminder.text.slice(0, 80)}`);
    return reminder;
  }

  /** A user's own pending reminders, soonest first. */
  listFor(userId: string): Reminder[] {
    return this.items.filter((r) => r.userId === userId).sort((a, b) => a.dueAt - b.dueAt);
  }

  cancel(id: string, userId: string): "ok" | "not-found" | "not-yours" {
    const item = this.items.find((r) => r.id.toLowerCase() === id.trim().toLowerCase().replace(/^#/, ""));
    if (!item) return "not-found";
    if (item.userId !== userId) return "not-yours";
    this.items = this.items.filter((r) => r !== item);
    this.save();
    this.log(`⏰ reminder ${item.id} cancelled`);
    return "ok";
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const item of [...this.items]) {
      if (item.dueAt > now || this.firing.has(item.id)) continue;
      this.firing.add(item.id);
      try {
        await this.deliver(item);
        this.items = this.items.filter((r) => r !== item);
        this.save();
        this.log(`⏰ reminder ${item.id} delivered to ${item.userName}`);
      } catch (err) {
        item.attempts = (item.attempts ?? 0) + 1;
        this.log(`⚠ reminder ${item.id} delivery failed (${item.attempts}/${MAX_ATTEMPTS}): ${(err as Error).message.slice(0, 140)}`);
        if (item.attempts >= MAX_ATTEMPTS) this.items = this.items.filter((r) => r !== item);
        this.save();
      } finally {
        this.firing.delete(item.id);
      }
    }
  }

  private nextId(): string {
    for (let i = 0; i < 1000; i++) {
      const id = `r${(++this.seq).toString(36)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, "0")}`;
      if (!this.items.some((r) => r.id === id)) return id;
    }
    return `r${Date.now().toString(36)}`;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Reminder[];
      this.items = Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === "string" && typeof r.dueAt === "number") : [];
    } catch (err) {
      this.log(`⚠ could not read reminders (${(err as Error).message}) — starting empty`);
      this.items = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch (err) {
      this.log(`⚠ could not persist reminders: ${(err as Error).message}`);
    }
  }
}

const createSchema = z.object({
  when: z
    .string()
    .describe(
      'When it fires. Duration: "10m", "90 minuten", "2h", "1h30m", "3 tage". Clock time (24h, local): "18:00", "9 uhr". Day: "morgen 09:00", "übermorgen", "26.07. 14:00", "2026-07-26 09:00". Never vague ("später", "soon").',
    ),
  message: z
    .string()
    .describe(
      "The reminder text posted when the time comes, in the user's language and self-contained (they will have forgotten the conversation), e.g. \"Erinnerung: Müll rausbringen\".",
    ),
});

const cancelSchema = z.object({
  id: z.string().describe("Reminder id from create_reminder or list_reminders, e.g. \"r1x9k\"."),
});

const FORMAT_HELP =
  'could not read that time. Use one of: a duration ("15m", "2h", "1h30m", "3 tage"), a clock time ("18:00", "9 uhr"), or a date ("morgen 09:00", "26.07. 14:00", "2026-07-26 09:00"). Reminders must be at least 5 seconds and at most a year out.';

/** The three reminder tools, bound to one store (registered only for the
 *  Discord bot — a CLI session has no channel to fire into). */
export function makeReminderTools(store: ReminderStore): ToolDef[] {
  return [
    {
      name: "create_reminder",
      description:
        "Set a one-off reminder for the person you are talking to. When the time comes the harness posts `message` back into THIS conversation — the same channel (mentioning them) or the same DM. Use it whenever someone asks to be reminded of something later. Never claim you set a reminder without calling this tool, and never try to wait or sleep yourself.",
      kind: "edit",
      schema: createSchema,
      describeCall: (args) => `create_reminder(${String(args["when"] ?? "?")})`,
      execute: async (args) => {
        const { when, message } = createSchema.parse(args);
        const dueAt = parseWhen(when);
        if (dueAt === null) return `error: ${FORMAT_HELP}`;
        try {
          const r = store.create(message, dueAt);
          return `reminder ${r.id} set for ${formatWhen(dueAt)}: "${r.text}". Tell the user briefly WHEN it will fire.`;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    },
    {
      name: "list_reminders",
      description: "List the pending reminders of the person you are talking to (id, time, text).",
      kind: "read",
      schema: z.object({}),
      describeCall: () => "list_reminders()",
      execute: async () => {
        const ctx = store.context();
        if (!ctx) return "error: no conversation context";
        const items = store.listFor(ctx.userId);
        if (!items.length) return "no pending reminders for this user";
        return items.map((r) => `${r.id} — ${formatWhen(r.dueAt)}: ${r.text}`).join("\n");
      },
    },
    {
      name: "cancel_reminder",
      description: "Cancel one of the pending reminders of the person you are talking to (use list_reminders to find its id).",
      kind: "edit",
      schema: cancelSchema,
      describeCall: (args) => `cancel_reminder(${String(args["id"] ?? "?")})`,
      execute: async (args) => {
        const { id } = cancelSchema.parse(args);
        const ctx = store.context();
        if (!ctx) return "error: no conversation context";
        const result = store.cancel(id, ctx.userId);
        if (result === "ok") return `reminder ${id} cancelled`;
        if (result === "not-yours") return `error: reminder ${id} belongs to someone else — you can only cancel your own`;
        return `error: no reminder with id ${id} (use list_reminders)`;
      },
    },
  ];
}
