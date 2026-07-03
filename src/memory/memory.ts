import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { GLOBAL_MEMORY, localMemory } from "../config/paths";
import type { Settings } from "../config/settings";
import type { LlmClient } from "../llm/client";
import { estimateTokens } from "../llm/client";
import { scoreTurn, renderScored, type ScoringConfig } from "./scores";

/** Built-in trigger phrases that route a fact to the GLOBAL vault. */
const GLOBAL_TRIGGERS = [
  /always remember/i,
  /remember (that )?(this|it) (should )?always/i,
  /from now on,? always/i,
  /it should always be/i,
  /global(ly)? remember/i,
];

export function detectGlobalTrigger(text: string, extra: string[]): boolean {
  if (GLOBAL_TRIGGERS.some((re) => re.test(text))) return true;
  return extra.some((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));
}

export function loadGlobalMemory(): string {
  return existsSync(GLOBAL_MEMORY) ? readFileSync(GLOBAL_MEMORY, "utf8").trim() : "";
}

export function saveGlobalMemory(content: string): void {
  writeFileSync(GLOBAL_MEMORY, content.trim() + "\n");
}

export function loadLocalMemory(cwd: string): string {
  const path = localMemory(cwd);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

export function saveLocalMemory(cwd: string, content: string): void {
  writeFileSync(localMemory(cwd), content.trim() + "\n");
}

export const MEMORY_SECTIONS = [
  "Project facts",
  "Domain knowledge",
  "Decisions",
  "User answers",
  "Gotchas",
];

const EMPTY_LOCAL = MEMORY_SECTIONS.map((s) => `## ${s}\n`).join("\n");

const EXTRACT_SYSTEM = `You maintain the persistent project memory of a coding agent. You receive the CURRENT MEMORY and the latest conversation TURN. Return the COMPLETE UPDATED MEMORY file, markdown, with exactly these sections:

## Project facts
## Domain knowledge
## Decisions
## User answers
## Gotchas

Rules:
- Keep every still-true fact from the current memory. Remove facts the turn proved wrong or obsolete.
- Add new DURABLE facts from the turn: project structure, build/run commands, user preferences for this project, decisions made and why, answers the user gave to questions, pitfalls hit.
- If the turn used web search or fetched documentation, distill the useful external knowledge (API signatures, version numbers, config syntax) into "Domain knowledge" so future turns do not need to search again.
- One fact per bullet, terse. No narration of what happened, only facts that help future work.
- Do NOT store secrets, API keys, or passwords.
- Hard limit: TOKEN_BUDGET tokens. If over, drop the least useful bullets first.

After the five sections, add one more:

## Global candidates
Bullets from this turn that are project-INDEPENDENT and would matter in a brand-new repo: durable user preferences ("prefers bun over npm"), environment truths ("vLLM endpoint at host X serves model Y"), workflow habits. This section is almost always EMPTY — a fact qualifies only if it is clearly durable AND clearly not specific to this project. When in doubt, leave it out; the fact is still kept in the project sections above.

- Output ONLY the markdown file, nothing else.`;

/** Vault limits — enforced by the merge prompt and re-checked code-side. */
const GLOBAL_MAX_BULLETS = 40;
const GLOBAL_MAX_TOKENS = 1200;

export const GLOBAL_SECTIONS = ["Preferences", "Environment", "Workflow", "Facts"];

const GLOBAL_MERGE_SYSTEM = `You maintain the GLOBAL memory vault of a coding agent — durable knowledge injected into EVERY future session of EVERY project. You receive the CURRENT VAULT and CANDIDATE FACTS. Return the COMPLETE UPDATED VAULT, markdown, with exactly these sections:

## Preferences   — how the user likes things done (tools, style, communication)
## Environment   — durable machine/infrastructure truths: hosts, ports, endpoints, models served, hardware, installed tools
## Workflow      — habits and processes the user follows across projects
## Facts         — other durable cross-project truths

Admission gate — a candidate enters the vault ONLY if ALL of these hold:
- true independent of any single project (would still matter in a brand-new empty repo; the user's infrastructure, endpoints and tools DO qualify — only facts about one codebase's internals do not)
- durable (not session or task state, not work in progress, not a one-off)
- a fact or genuine user preference — never task narration or transient status
Silently drop candidates that fail the gate.

Curation — apply to the WHOLE vault on every write:
- one terse, general bullet per fact; rewrite vague or verbose bullets
- deduplicate aggressively; merge overlapping bullets into the stronger one
- contradictions: the newer fact wins, delete the old
- delete stale bullets (things that no longer hold or reference retired tools)
- a section with no facts stays EMPTY: just the header, no bullets. NEVER write placeholder bullets like "none recorded" or "N/A"
- do NOT store secrets, API keys, or passwords
- hard cap: at most ${GLOBAL_MAX_BULLETS} bullets / ~${GLOBAL_MAX_TOKENS} tokens — drop the least valuable first

Output ONLY the markdown file, nothing else.`;

export class MemoryManager {
  private cwd: string;
  private settings: Settings;
  private client: LlmClient;
  private extracting = false;
  /** UI hook — fired when a memory file changes, so the statusline can flash. */
  onUpdate?: (scope: "global" | "local") => void;
  /** UI hook — transcript notes (revived/archived memories). */
  onNote?: (text: string) => void;

  private scoringCfg(): ScoringConfig {
    const m = this.settings.memory;
    return {
      halfLifeDays: m.halfLifeDays,
      spreadFactor: m.spreadFactor,
      pruneThreshold: m.pruneThreshold,
      reviveThreshold: m.reviveThreshold,
    };
  }

  constructor(cwd: string, settings: Settings, client: LlmClient) {
    this.cwd = cwd;
    this.settings = settings;
    this.client = client;
  }

  /** Both memories rendered for system-prompt injection. Project memory is
   *  score-ordered (strongest first) and budget-capped by dropping the
   *  weakest bullets; the file on disk is untouched. */
  render(): string {
    const g = loadGlobalMemory();
    let l = loadLocalMemory(this.cwd);
    if (l && this.settings.memory.scoring) {
      try {
        l = renderScored({
          cwd: this.cwd,
          memoryMd: l,
          cfg: this.scoringCfg(),
          sections: MEMORY_SECTIONS,
          maxTokens: this.settings.memory.maxTokens,
          estimateTokens,
        });
      } catch {
        // scoring must never break injection — fall back to the raw file
      }
    }
    let out = "";
    if (g) out += `# MEMORY (global — applies to all projects)\n${g}\n\n`;
    if (l) out += `# MEMORY (this project)\n${l}\n`;
    return out.trim();
  }

  /**
   * Post-turn extractor: fire-and-forget; merges the turn's durable facts
   * into local memory. Skipped if a previous extraction is still running.
   */
  async extractFromTurn(turnSummary: string): Promise<void> {
    if (!this.settings.memory.enabled || this.extracting) return;
    this.extracting = true;
    try {
      const current = loadLocalMemory(this.cwd) || EMPTY_LOCAL;
      const system = EXTRACT_SYSTEM.replace(
        "TOKEN_BUDGET",
        String(this.settings.memory.maxTokens),
      );
      const user = `CURRENT MEMORY:\n${current}\n\nTURN:\n${turnSummary}`;
      let updated = await this.client.oneShot(system, user, 4096);
      updated = stripFence(updated);
      // sanity: the model must return the sectioned file, otherwise keep the old one
      if (updated.includes("## Project facts")) {
        // cross-project facts ride along in a trailer section — split them off
        // so the local file stays clean, then promote them to the vault
        const { local, candidates } = splitGlobalCandidates(updated);
        updated = local;
        if (estimateTokens(updated) > this.settings.memory.maxTokens * 1.5) {
          updated = updated.slice(0, this.settings.memory.maxTokens * 6);
        }
        saveLocalMemory(this.cwd, updated);
        this.onUpdate?.("local");
        this.runScoring(updated, turnSummary);
        if (candidates.length) await this.promoteGlobal(candidates);
      }
    } catch {
      // memory extraction must never break the session
    } finally {
      this.extracting = false;
    }
  }

  /** Auto-promotion: merge extractor-nominated cross-project facts into the
   *  vault. Candidates already in the vault (lexically) are skipped so quiet
   *  turns don't burn a model call re-proposing known facts. */
  private async promoteGlobal(candidates: string[]): Promise<void> {
    const vaultNorm = normalize(loadGlobalMemory());
    const fresh = candidates.filter((c) => {
      const n = normalize(c);
      return n.length > 8 && !vaultNorm.includes(n);
    });
    if (fresh.length === 0) return;
    const before = loadGlobalMemory();
    const merged = await this.mergeGlobal(fresh.map((c) => `- ${c}`).join("\n"));
    // the gate may reject every candidate — only announce real vault changes
    if (merged && merged !== before) this.onNote?.("⚡ global memory updated");
  }

  /** Post-turn brain pass: reinforce fired memories, spread activation to
   *  neighbors, archive faded ones, revive archived ones the turn matched. */
  private runScoring(memoryMd: string, turnSummary: string): void {
    if (!this.settings.memory.scoring) return;
    try {
      const { notes } = scoreTurn({
        cwd: this.cwd,
        memoryMd,
        turnText: turnSummary,
        cfg: this.scoringCfg(),
        sections: MEMORY_SECTIONS,
        saveMemory: (md) => saveLocalMemory(this.cwd, md),
      });
      for (const note of notes) this.onNote?.(note);
    } catch {
      // scoring must never break the session
    }
  }

  /** Explicit-trigger path ("always remember…" / /remember): the statement
   *  goes through the same gate + curation as auto-promoted facts. */
  async rememberGlobal(statement: string): Promise<string> {
    return this.mergeGlobal(`- ${statement.replace(/\s+/g, " ").trim()}`);
  }

  /** One curating vault write: gate the candidates, dedupe/refresh the whole
   *  vault, enforce the cap. Returns the new vault ("" if the write was
   *  rejected as malformed). */
  private async mergeGlobal(candidateBullets: string): Promise<string> {
    const current = loadGlobalMemory() || "(empty)";
    let updated = await this.client.oneShot(
      GLOBAL_MERGE_SYSTEM,
      `CURRENT VAULT:\n${current}\n\nCANDIDATE FACTS:\n${candidateBullets}`,
      2048,
    );
    updated = stripFence(updated);
    // sanity: sectioned markdown or bust — never clobber the vault with junk
    if (!updated.trim() || !updated.includes("## ")) return "";
    if (estimateTokens(updated) > GLOBAL_MAX_TOKENS * 2) {
      updated = updated.slice(0, GLOBAL_MAX_TOKENS * 8);
    }
    saveGlobalMemory(updated);
    this.onUpdate?.("global");
    return updated;
  }
}

/** Lexical fingerprint for cheap containment checks. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Split the extractor's "## Global candidates" trailer off the local file. */
export function splitGlobalCandidates(md: string): { local: string; candidates: string[] } {
  const m = md.match(/^## Global candidates\s*$/im);
  if (!m || m.index === undefined) return { local: md, candidates: [] };
  const head = md.slice(0, m.index);
  const tail = md.slice(m.index + m[0].length);
  // trailer runs to the next section header (defensively) or EOF
  const next = tail.search(/^## /m);
  const body = next === -1 ? tail : tail.slice(0, next);
  const rest = next === -1 ? "" : tail.slice(next);
  const candidates = body
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#") && !/^\(?(none|empty|n\/a)\)?\.?$/i.test(l));
  return { local: (head + rest).trim(), candidates };
}

function stripFence(text: string): string {
  const m = text.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1]! : text.trim();
}
