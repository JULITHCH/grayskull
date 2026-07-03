/** Stuck detection → auto web-research nudge. Two triggers:
 *  - the agent keeps editing without resolving the problem (editThreshold
 *    edit-tool calls in the current problem episode), or
 *  - the user reports the same problem again (lexical similarity between
 *    problem-looking prompts, repeatThreshold reports total).
 *  Either arms a one-shot nudge that the tool loop injects as a user message
 *  before the next model call, telling the model to research the problem
 *  online (searxng) instead of guessing further. Pure code, no LLM. */

export interface StuckConfig {
  enabled: boolean;
  editThreshold: number;
  repeatThreshold: number;
}

/** Prompts that look like a problem report (vs a fresh task). */
const PROBLEM_CUES =
  /\b(error|fail(s|ed|ing)?|broken|breaks|bug|crash(es|ed)?|wrong|doesn'?t|does not|not work(ing)?|won'?t|can'?t|stuck|still|again|same (problem|issue|error|bug)|no change|didn'?t (fix|help|work))\b/i;

const SIMILARITY_THRESHOLD = 0.45;
const MAX_REPORTS = 6;

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export class StuckTracker {
  private edits = 0;
  /** recent problem reports: token set + how often this problem was reported */
  private reports: { tokens: Set<string>; count: number }[] = [];
  private pending: { text: string; reason: string } | null = null;

  constructor(private cfg: StuckConfig) {}

  /** Call after each completed edit-kind tool execution. */
  noteEdit(): void {
    if (!this.cfg.enabled) return;
    this.edits++;
    if (this.edits >= this.cfg.editThreshold) {
      this.arm(`${this.edits} edits without resolving the problem`);
      this.edits = 0;
    }
  }

  /** Call at turn start with the user's prompt. A prompt that doesn't look
   *  like a problem report starts a new episode (resets the edit counter);
   *  one that matches an earlier report closely enough counts as "the same
   *  problem again" and arms the nudge at repeatThreshold reports. */
  notePrompt(text: string): void {
    if (!this.cfg.enabled) return;
    if (!PROBLEM_CUES.test(text)) {
      this.edits = 0;
      return;
    }
    const tokens = tokenize(text);
    const match = this.reports.find((r) => jaccard(r.tokens, tokens) >= SIMILARITY_THRESHOLD);
    if (match) {
      match.count++;
      match.tokens = tokens; // track the latest phrasing
      if (match.count >= this.cfg.repeatThreshold) {
        this.arm(`the user reported the same problem ${match.count} times`);
        this.reports = this.reports.filter((r) => r !== match);
        this.edits = 0;
      }
    } else {
      this.reports.push({ tokens, count: 1 });
      if (this.reports.length > MAX_REPORTS) this.reports.shift();
    }
  }

  /** One-shot drain: the armed nudge (injected as a user message), or null. */
  drainNudge(): { text: string; reason: string } | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  private arm(reason: string): void {
    if (this.pending) return; // one nudge at a time
    this.pending = {
      reason,
      text:
        `[Automatic stuck-detection notice: ${reason}. The current approach is not working — stop guessing and research the problem online before making further edits:\n` +
        `1. Call mcp__searxng__searxng_web_search with 2-3 focused queries built from the exact error message / symptom plus the language, library and version involved.\n` +
        `2. Open the most promising results with mcp__searxng__web_url_read (docs, issues, Stack Overflow).\n` +
        `3. Summarize for the user what you learned and which new approach you will try, then apply it.\n` +
        `If the web search tools are unavailable, tell the user you are stuck and list what you already tried.]`,
    };
  }
}
