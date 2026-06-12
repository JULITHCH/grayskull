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
- Output ONLY the markdown file, nothing else.`;

const GLOBAL_MERGE_SYSTEM = `You maintain the GLOBAL memory vault of a coding agent — preferences and facts that apply to ALL projects, forever. You receive the CURRENT VAULT and a USER STATEMENT the user explicitly asked to remember permanently. Return the COMPLETE UPDATED VAULT as a flat markdown bullet list.
Rules:
- Rewrite the statement as one terse, general bullet.
- Merge with existing bullets; deduplicate; if the new fact contradicts an old one, the new one wins.
- Output ONLY the markdown, nothing else.`;

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
        if (estimateTokens(updated) > this.settings.memory.maxTokens * 1.5) {
          updated = updated.slice(0, this.settings.memory.maxTokens * 6);
        }
        saveLocalMemory(this.cwd, updated);
        this.onUpdate?.("local");
        this.runScoring(updated, turnSummary);
      }
    } catch {
      // memory extraction must never break the session
    } finally {
      this.extracting = false;
    }
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

  /** Explicit-trigger path: merge a fact into the global vault. */
  async rememberGlobal(statement: string): Promise<string> {
    const current = loadGlobalMemory() || "(empty)";
    let updated = await this.client.oneShot(
      GLOBAL_MERGE_SYSTEM,
      `CURRENT VAULT:\n${current}\n\nUSER STATEMENT:\n${statement}`,
      2048,
    );
    updated = stripFence(updated);
    if (updated.trim()) {
      saveGlobalMemory(updated);
      this.onUpdate?.("global");
    }
    return updated;
  }
}

function stripFence(text: string): string {
  const m = text.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1]! : text.trim();
}
