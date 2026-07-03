import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_DIR } from "../config/paths";
import type { ChatMessage, TranscriptItem } from "../types";

/** Web sessions persist here so the sidebar survives server restarts and any
 *  session can be picked back up later. One JSON file per session. */
export const WEB_SESSIONS_DIR = join(GLOBAL_DIR, "web-sessions");

/** Folder-less "chat" sessions all live in this synthetic cwd — their shared
 *  .grayskull/ there acts as a cross-chat memory. */
export const CHATS_CWD = join(GLOBAL_DIR, "chats");

export type SessionKind = "project" | "chat";

export interface SavedSession {
  sid: string;
  kind: SessionKind;
  cwd: string;
  /** chats: first prompt excerpt; projects: empty (cwd is the label) */
  title: string;
  mode: string;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  history: ChatMessage[];
}

/** Sidebar metadata — everything but the heavy transcript/history. */
export type SavedSessionMeta = Omit<SavedSession, "items" | "history">;

const file = (sid: string) => join(WEB_SESSIONS_DIR, `${sid}.json`);

export function ensureWebDirs(): void {
  for (const d of [WEB_SESSIONS_DIR, CHATS_CWD]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function saveSession(s: SavedSession): void {
  try {
    ensureWebDirs();
    writeFileSync(file(s.sid), JSON.stringify({ ...s, items: s.items.slice(-600) }));
  } catch {
    // persistence must never break the session
  }
}

export function loadSessionMetas(): SavedSessionMeta[] {
  ensureWebDirs();
  const metas: SavedSessionMeta[] = [];
  for (const f of readdirSync(WEB_SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(WEB_SESSIONS_DIR, f), "utf8")) as SavedSession;
      const { items: _i, history: _h, ...meta } = s;
      metas.push(meta);
    } catch {
      // skip unreadable files rather than break startup
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(sid: string): SavedSession | null {
  try {
    return JSON.parse(readFileSync(file(sid), "utf8")) as SavedSession;
  } catch {
    return null;
  }
}

export function deleteSession(sid: string): void {
  try {
    unlinkSync(file(sid));
  } catch {
    // already gone is fine
  }
}
