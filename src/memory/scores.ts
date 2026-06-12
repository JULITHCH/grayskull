import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { localDir } from "../config/paths";

/**
 * Brain-like memory scoring (ACT-R-light):
 *  - every project-memory bullet has an activation score
 *  - scores decay exponentially over time (forgetting curve)
 *  - bullets "fired" by a turn are reinforced
 *  - spreading activation: lexical neighbors of fired bullets get a small boost
 *  - faded bullets are archived, and revived when a turn matches them strongly
 */

export interface MemoryBullet {
  section: string;
  text: string;
  hash: string;
}

export interface ScoreEntry {
  score: number;
  lastTouch: string; // ISO
  created: string;
  uses: number;
}

export interface ScoringConfig {
  halfLifeDays: number;
  spreadFactor: number;
  pruneThreshold: number;
  reviveThreshold: number;
}

const SCORE_CAP = 3;
const REINFORCE_BOOST = 1;
const REVIVE_SCORE = 0.6;
const FIRE_THRESHOLD = 0.45;
const NEIGHBOR_MIN_SIM = 0.3;
const NEIGHBOR_TOP_K = 3;
const SAME_SECTION_BONUS = 0.1;
/** never prune something newer than this — it has not had a chance to be used */
const PRUNE_MIN_AGE_DAYS = 1;

const STOPWORDS = new Set(
  "a an the and or but if then else for while of to in on at by with from as is are was were be been being it its this that these those i you he she we they not no do does did done can could should would will just also very really use used using user".split(
    " ",
  ),
);

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const t = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (t.length >= 2 && !STOPWORDS.has(t)) tokens.add(t);
  }
  return tokens;
}

/** How much of the bullet is contained in the (much larger) turn text. */
export function containment(bullet: Set<string>, turn: Set<string>): number {
  if (bullet.size === 0) return 0;
  let hit = 0;
  for (const t of bullet) if (turn.has(t)) hit++;
  return hit / bullet.size;
}

/** Symmetric similarity between two bullets (token-set cosine + section bonus). */
export function pairwiseSim(a: MemoryBullet, aTok: Set<string>, b: MemoryBullet, bTok: Set<string>): number {
  if (aTok.size === 0 || bTok.size === 0) return 0;
  let hit = 0;
  for (const t of aTok) if (bTok.has(t)) hit++;
  let sim = hit / Math.sqrt(aTok.size * bTok.size);
  if (a.section === b.section) sim += SAME_SECTION_BONUS;
  return sim;
}

export function bulletHash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 12);
}

/** Parse the sectioned memory markdown the extractor emits. */
export function parseMemoryBullets(md: string): MemoryBullet[] {
  const bullets: MemoryBullet[] = [];
  let section = "";
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      section = h[1]!.trim();
      continue;
    }
    const b = line.match(/^\s*-\s+(.+)$/);
    if (b) bullets.push({ section, text: b[1]!.trim(), hash: bulletHash(b[1]!) });
  }
  return bullets;
}

export function renderMemoryMd(bullets: MemoryBullet[], sections: string[]): string {
  const order = [...new Set([...sections, ...bullets.map((b) => b.section)])];
  return order
    .map((s) => {
      const items = bullets.filter((b) => b.section === s).map((b) => `- ${b.text}`);
      return `## ${s}\n${items.join("\n")}`;
    })
    .join("\n\n");
}

function daysSince(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 86_400_000);
}

export function scoresPath(cwd: string): string {
  return join(localDir(cwd), "memory-scores.json");
}
export function archivePath(cwd: string): string {
  return join(localDir(cwd), "memory-archive.md");
}

export class ScoreStore {
  entries: Record<string, ScoreEntry> = {};
  private cwd: string;
  private cfg: ScoringConfig;
  private now: Date;

  constructor(cwd: string, cfg: ScoringConfig, now = new Date()) {
    this.cwd = cwd;
    this.cfg = cfg;
    this.now = now;
    const path = scoresPath(cwd);
    if (existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, "utf8")) as Record<string, ScoreEntry>;
      } catch {
        this.entries = {};
      }
    }
  }

  save(): void {
    writeFileSync(scoresPath(this.cwd), JSON.stringify(this.entries, null, 1) + "\n");
  }

  /** New bullets start at 1.0; entries whose bullet vanished are dropped. */
  sync(bullets: MemoryBullet[]): void {
    const live = new Set(bullets.map((b) => b.hash));
    for (const hash of live) {
      if (!this.entries[hash]) {
        this.entries[hash] = {
          score: 1,
          lastTouch: this.now.toISOString(),
          created: this.now.toISOString(),
          uses: 0,
        };
      }
    }
    for (const hash of Object.keys(this.entries)) {
      if (!live.has(hash)) delete this.entries[hash];
    }
  }

  effective(hash: string): number {
    const e = this.entries[hash];
    if (!e) return 1;
    return e.score * Math.pow(2, -daysSince(e.lastTouch, this.now) / this.cfg.halfLifeDays);
  }

  /** Fold the decay into the stored score, then apply a boost. */
  private touch(hash: string, boost: number, countUse: boolean): void {
    const e = this.entries[hash];
    if (!e) return;
    e.score = Math.min(SCORE_CAP, this.effective(hash) + boost);
    e.lastTouch = this.now.toISOString();
    if (countUse) e.uses++;
  }

  reinforce(hash: string): void {
    this.touch(hash, REINFORCE_BOOST, true);
  }

  spreadBoost(hash: string, similarity: number): void {
    this.touch(hash, this.cfg.spreadFactor * similarity, false);
  }

  revive(hash: string): void {
    this.entries[hash] = {
      score: REVIVE_SCORE,
      lastTouch: this.now.toISOString(),
      created: this.now.toISOString(),
      uses: 1,
    };
  }

  isPrunable(hash: string): boolean {
    const e = this.entries[hash];
    if (!e) return false;
    return (
      this.effective(hash) < this.cfg.pruneThreshold &&
      daysSince(e.created, this.now) >= PRUNE_MIN_AGE_DAYS
    );
  }
}

/**
 * The post-turn scoring pass. Pure code, no LLM. Returns UI notes.
 * Mutates memory.md (prune/revive) and the score sidecar.
 */
export function scoreTurn(opts: {
  cwd: string;
  memoryMd: string;
  turnText: string;
  cfg: ScoringConfig;
  sections: string[];
  now?: Date;
  saveMemory: (md: string) => void;
}): { notes: string[] } {
  const { cwd, cfg } = opts;
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  let bullets = parseMemoryBullets(opts.memoryMd);
  const store = new ScoreStore(cwd, cfg, now);
  store.sync(bullets);

  const turnTokens = tokenize(opts.turnText);
  const tokens = new Map(bullets.map((b) => [b.hash, tokenize(b.text)]));

  // 1. reinforcement: bullets the turn actually touched
  const fired = bullets.filter((b) => containment(tokens.get(b.hash)!, turnTokens) >= FIRE_THRESHOLD);
  for (const b of fired) store.reinforce(b.hash);

  // 2. spreading activation: neighbors of fired bullets
  const firedHashes = new Set(fired.map((b) => b.hash));
  for (const f of fired) {
    const neighbors = bullets
      .filter((b) => b.hash !== f.hash && !firedHashes.has(b.hash))
      .map((b) => ({ b, sim: pairwiseSim(f, tokens.get(f.hash)!, b, tokens.get(b.hash)!) }))
      .filter((n) => n.sim >= NEIGHBOR_MIN_SIM)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, NEIGHBOR_TOP_K);
    for (const n of neighbors) store.spreadBoost(n.b.hash, n.sim);
  }

  // 3. revival: archived memories the turn strongly matches
  const archive = existsSync(archivePath(cwd)) ? readFileSync(archivePath(cwd), "utf8") : "";
  const archived = parseMemoryBullets(archive).map((a) => {
    // strip the archival stamp so the revived bullet matches its original hash
    const text = a.text.replace(/\s*<!--\s*archived[^>]*-->\s*$/, "");
    return { ...a, text, hash: bulletHash(text) };
  });
  const revived: MemoryBullet[] = [];
  for (const a of archived) {
    if (bullets.some((b) => b.hash === a.hash)) continue;
    if (containment(tokenize(a.text), turnTokens) >= cfg.reviveThreshold) {
      revived.push(a);
      store.revive(a.hash);
      notes.push(`✦ revived memory: ${a.text.slice(0, 80)}`);
    }
  }
  if (revived.length > 0) {
    bullets = [...bullets, ...revived];
    const keep = archived.filter((a) => !revived.some((r) => r.hash === a.hash));
    writeFileSync(archivePath(cwd), keep.length ? renderMemoryMd(keep, opts.sections) + "\n" : "");
  }

  // 4. prune: faded memories move to the archive (forgotten, not destroyed)
  const pruned = bullets.filter((b) => store.isPrunable(b.hash));
  if (pruned.length > 0) {
    const stamp = now.toISOString().slice(0, 10);
    for (const p of pruned) {
      appendFileSync(archivePath(cwd), `## ${p.section}\n- ${p.text} <!-- archived ${stamp} -->\n`);
      delete store.entries[p.hash];
    }
    bullets = bullets.filter((b) => !pruned.some((p) => p.hash === b.hash));
    notes.push(`memory: ${pruned.length} faded fact(s) archived`);
  }

  if (revived.length > 0 || pruned.length > 0) {
    opts.saveMemory(renderMemoryMd(bullets, opts.sections));
  }
  store.save();
  return { notes };
}

export interface MemoryGraph {
  nodes: Array<{ id: string; text: string; section: string; score: number; uses: number }>;
  links: Array<{ a: string; b: string; sim: number }>;
}

/** Node/edge view of project memory for the web UI: activation scores as
 *  node weight, the same lexical similarity that drives spreading activation
 *  as edges. */
export function memoryGraphData(cwd: string, memoryMd: string, cfg: ScoringConfig): MemoryGraph {
  const bullets = parseMemoryBullets(memoryMd);
  const store = new ScoreStore(cwd, cfg);
  const tokens = new Map(bullets.map((b) => [b.hash, tokenize(b.text)]));
  const nodes = bullets.map((b) => ({
    id: b.hash,
    text: b.text,
    section: b.section,
    score: Number(store.effective(b.hash).toFixed(3)),
    uses: store.entries[b.hash]?.uses ?? 0,
  }));
  const links: MemoryGraph["links"] = [];
  for (let i = 0; i < bullets.length; i++) {
    for (let j = i + 1; j < bullets.length; j++) {
      const a = bullets[i]!, b = bullets[j]!;
      const sim = pairwiseSim(a, tokens.get(a.hash)!, b, tokens.get(b.hash)!);
      if (sim >= NEIGHBOR_MIN_SIM) links.push({ a: a.hash, b: b.hash, sim: Number(sim.toFixed(2)) });
    }
  }
  return { nodes, links };
}

/**
 * Render memory for prompt injection: strongest first within each section,
 * lowest-scored bullets dropped if over the token budget (file untouched).
 */
export function renderScored(opts: {
  cwd: string;
  memoryMd: string;
  cfg: ScoringConfig;
  sections: string[];
  maxTokens: number;
  estimateTokens: (t: string) => number;
}): string {
  const bullets = parseMemoryBullets(opts.memoryMd);
  if (bullets.length === 0) return opts.memoryMd;
  const store = new ScoreStore(opts.cwd, opts.cfg);
  const ranked = [...bullets].sort((a, b) => store.effective(b.hash) - store.effective(a.hash));

  const kept: MemoryBullet[] = [];
  let budget = opts.maxTokens;
  for (const b of ranked) {
    const cost = opts.estimateTokens(b.text) + 2;
    if (budget - cost < 0) continue;
    budget -= cost;
    kept.push(b);
  }
  // strongest memories first within each section
  const keptSet = new Set(kept.map((b) => b.hash));
  return renderMemoryMd(ranked.filter((b) => keptSet.has(b.hash)), opts.sections);
}
