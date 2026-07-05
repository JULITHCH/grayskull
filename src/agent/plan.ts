/** Plan-first gate: blocks code-before-blueprint on substantial work. When the
 *  turn asks for something substantial (new app/feature, refactor, integration
 *  — creation/restructure vocabulary, en/de) the model must research and write
 *  a blueprint to .grayskull/plans/<slug>.md BEFORE its first code edit. The
 *  first edit attempted without one is refused once, with the full
 *  research → blueprint → review procedure injected as the tool result.
 *
 *  Same philosophy as VisualVerifyGate: the system prompt teaches the
 *  workflow proactively (systemHint), the gate enforces it when ignored.
 *  Blocks once per turn — a follow-up tweak to already-planned work can be
 *  declared trivial and proceed. Pure code, no LLM. */

export interface PlanFirstConfig {
  enabled: boolean;
}

/** Creation / restructure vocabulary (en + de) that marks a turn substantial.
 *  Deliberately narrow: bug fixes, tweaks, and questions must NOT arm the
 *  gate. A false-positive arm on a question is harmless — the gate only
 *  fires on an edit attempt. */
const SUBSTANTIAL_RE =
  /\b(build|create|implement|develop|make|write|code up)\b.{0,60}\b(app|application|game|tool|cli|server|service|site|website|page|ui|gui|feature|system|library|package|module|component|api|bot|dashboard|editor|clone|prototype|mvp)\b|\b(refactor|rewrite|redesign|restructure|overhaul|migrate|migration|integrate|integration)\b|\bfrom scratch\b|\b(baue?|erstelle?|entwickle?|implementiere?|programmiere?)\b|\bvon grund auf\b|\bneu (schreiben|bauen)\b|\bschreibe? .{0,40}\b(spiel|app|anwendung|tool|seite|feature)\b/i;

/** Edits under this path are the blueprint itself — always allowed. */
const PLAN_DIR = ".grayskull/plans/";

/** Tool names that count as research. */
const RESEARCH_RE = /^mcp__(searxng|context7)__/;

export class PlanGate {
  private active = false;
  private planned = false;
  private researched = false;
  private nudged = false;

  constructor(private cfg: PlanFirstConfig) {}

  /** Call at turn start. Chain steps pass "" to disarm — chains carry their
   *  own explicit plan steps and must not be double-gated. */
  notePrompt(text: string): void {
    this.active = this.cfg.enabled && SUBSTANTIAL_RE.test(text);
    this.planned = false;
    this.researched = false;
    this.nudged = false;
  }

  disarm(): void {
    this.active = false;
  }

  /** Call after each completed tool execution (detail = describeCall). */
  noteTool(name: string, kind: string, detail: string): void {
    if (!this.active) return;
    if (kind === "edit" && detail.includes(PLAN_DIR)) this.planned = true;
    else if (RESEARCH_RE.test(name)) this.researched = true;
  }

  /** Proactive workflow contract for the system message on substantial turns —
   *  teach the blueprint up front so the gate never has to fire. */
  systemHint(): string {
    if (!this.active) return "";
    return (
      "# Plan-first contract (this turn)\n" +
      "This request is SUBSTANTIAL (new feature/app or a restructure). Do NOT start coding directly. " +
      "First RESEARCH (read the relevant existing code; fetch current facts for anything external via " +
      "mcp__searxng__searxng_web_search + web_url_read, context7 for library APIs). Then write a BLUEPRINT " +
      "to .grayskull/plans/<task-slug>.md — a build document that pins every decision, not a sketch (see the " +
      "blueprint workflow in your core rules for the required sections). REVIEW it in place, then execute " +
      "exactly as written. Your first code edit before a blueprint exists will be refused."
    );
  }

  /** Called before an edit-kind tool executes. Returns the refusal message
   *  once per turn when a substantial turn has no blueprint yet, else null. */
  beforeEdit(detail: string): string | null {
    if (!this.active || this.planned || this.nudged) return null;
    if (detail.includes(PLAN_DIR)) return null; // writing the blueprint itself
    this.nudged = true;
    const research = this.researched
      ? ""
      : "You have also done NO research yet — before the blueprint, read the relevant existing code and fetch " +
        "current facts for anything external (mcp__searxng__searxng_web_search then web_url_read the best 1-2 " +
        "hits; mcp__context7__resolve-library-id + get-library-docs for library APIs). Facts first, then plan.\n";
    return (
      "[Automatic plan-first gate: this task is SUBSTANTIAL and you tried to edit code with no blueprint. " +
      "Edit refused (this once).\n" +
      research +
      "Write the blueprint to .grayskull/plans/<task-slug>.md now, with these sections — every one filled, " +
      "every decision stated as final (no \"or\"/\"maybe\"):\n" +
      "## Goal — what done looks like, in observable behavior\n" +
      "## Research — findings with source URLs; which existing files matter and why\n" +
      "## Decisions — architecture choices, each pinned (data flow, state layout, naming)\n" +
      "## Shapes — exact data structures / interfaces / schemas to be created\n" +
      "## Changes — file-by-file list: path → what changes there\n" +
      "## Edge cases — and how each is handled\n" +
      "## Verification — concrete commands/asserts that prove the goal, runnable at the end\n" +
      "## Review — re-read the blueprint against the request; list every gap or unpinned decision found, fix " +
      "each in the sections above, then write 'review clean'\n" +
      "Then implement exactly as written, todo tool tracking the Changes list. " +
      "EXCEPTION: if this request is genuinely a small tweak to existing work and a blueprint would be " +
      "overhead, say so in one sentence and continue without one.]"
    );
  }
}
