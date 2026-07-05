import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { localDir } from "../config/paths";

/**
 * Checkpoint/rewind: before every edit-kind tool touches a file, the loop
 * snapshots the file's current content under .grayskull/checkpoints/<turn>/.
 * /rewind restores a whole turn's snapshot — the undo for a weak model's bad
 * edits (KAMIKAZEEE insurance). One checkpoint = one turn; only files touched
 * by write/edit tools are covered (bash mutations and MCP file tools are not).
 */

interface ManifestEntry {
  /** absolute path of the touched file */
  path: string;
  /** snapshot file name inside the checkpoint dir, or null = file did not
   *  exist before the turn (rewind deletes it) */
  saved: string | null;
}

interface Manifest {
  label: string;
  startedAt: string;
  files: ManifestEntry[];
}

export interface CheckpointInfo {
  /** directory name — the /rewind handle */
  id: string;
  label: string;
  startedAt: string;
  files: string[];
}

export class CheckpointStore {
  private root: string;
  private seq = 0;
  /** current turn's checkpoint dir (created lazily on first snapshot) */
  private currentDir: string | null = null;
  private manifest: Manifest | null = null;
  private enabled: boolean;
  private keep: number;

  constructor(cwd: string, opts: { enabled: boolean; keep: number }) {
    this.root = join(localDir(cwd), "checkpoints");
    this.enabled = opts.enabled;
    this.keep = opts.keep;
    // continue numbering after existing checkpoints (session restarts)
    if (existsSync(this.root)) {
      for (const d of readdirSync(this.root)) {
        const n = Number.parseInt(d, 10);
        if (Number.isInteger(n) && n >= this.seq) this.seq = n + 1;
      }
    }
  }

  /** Called at the start of every turn — the next snapshot opens a fresh dir. */
  beginTurn(label: string): void {
    this.currentDir = null;
    this.manifest = null;
    this.pendingLabel = label.slice(0, 120);
  }

  private pendingLabel = "";

  /** Snapshot one file before an edit tool touches it (idempotent per turn). */
  snapshot(path: string, cwd: string): void {
    if (!this.enabled || !path) return;
    try {
      const full = resolve(cwd, path);
      if (!this.currentDir) {
        this.currentDir = join(this.root, `${String(this.seq++).padStart(4, "0")}`);
        mkdirSync(this.currentDir, { recursive: true });
        this.manifest = { label: this.pendingLabel, startedAt: new Date().toISOString(), files: [] };
        this.writeManifest();
        this.prune();
      }
      const m = this.manifest!;
      if (m.files.some((f) => f.path === full)) return; // first touch wins
      if (existsSync(full)) {
        const saved = `${m.files.length}.snap`;
        copyFileSync(full, join(this.currentDir, saved));
        m.files.push({ path: full, saved });
      } else {
        m.files.push({ path: full, saved: null });
      }
      this.writeManifest();
    } catch {
      // snapshots are insurance — never break the actual edit
    }
  }

  private writeManifest(): void {
    if (this.currentDir && this.manifest) {
      writeFileSync(join(this.currentDir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
    }
  }

  /** Newest first. */
  list(): CheckpointInfo[] {
    if (!existsSync(this.root)) return [];
    const out: CheckpointInfo[] = [];
    for (const d of readdirSync(this.root).sort().reverse()) {
      try {
        const m = JSON.parse(readFileSync(join(this.root, d, "manifest.json"), "utf8")) as Manifest;
        out.push({ id: d, label: m.label, startedAt: m.startedAt, files: m.files.map((f) => f.path) });
      } catch {
        // half-written checkpoint — skip
      }
    }
    return out;
  }

  /** Restore a checkpoint: touched files get their pre-turn content back,
   *  files created by the turn are deleted. Returns a report line per file. */
  restore(id: string): string[] {
    const dir = join(this.root, id);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const report: string[] = [];
    for (const f of m.files) {
      try {
        if (f.saved) {
          mkdirSync(dirname(f.path), { recursive: true });
          copyFileSync(join(dir, f.saved), f.path);
          report.push(`restored ${f.path}`);
        } else if (existsSync(f.path)) {
          unlinkSync(f.path);
          report.push(`deleted ${f.path} (created by that turn)`);
        }
      } catch (err) {
        report.push(`FAILED ${f.path}: ${(err as Error).message}`);
      }
    }
    return report;
  }

  private prune(): void {
    try {
      const dirs = readdirSync(this.root).sort();
      for (const d of dirs.slice(0, Math.max(0, dirs.length - this.keep))) {
        rmSync(join(this.root, d), { recursive: true, force: true });
      }
    } catch {
      // pruning is best-effort
    }
  }
}
