import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SESSIONS_DIR } from "../config/paths";
import type { ChatMessage } from "../types";

function projectDir(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const slug = cwd.split("/").filter(Boolean).slice(-2).join("-").replace(/[^\w-]/g, "_");
  return join(SESSIONS_DIR, `${slug}-${hash}`);
}

export class SessionStore {
  readonly path: string;
  private dir: string;

  constructor(cwd: string) {
    this.dir = projectDir(cwd);
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(this.dir, `${stamp}.jsonl`);
  }

  /** Whole-file rewrite: history mutates on compaction, so append-only won't do. */
  save(history: ChatMessage[]): void {
    try {
      writeFileSync(this.path, history.map((m) => JSON.stringify(m)).join("\n") + "\n");
    } catch {
      // session logging must never break the session
    }
  }

  /** Most recent past sessions for this project (newest first). */
  listPast(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl") && join(this.dir, f) !== this.path)
      .sort()
      .reverse()
      .map((f) => join(this.dir, f));
  }

  static load(path: string): ChatMessage[] {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatMessage);
  }
}
