/** Visual-verification gate: blocks blind "it's fixed" claims on rendering
 *  work. When the turn is about something visual (the prompt carries an image
 *  or rendering vocabulary) and the model edited code but never OBSERVED the
 *  rendered result (no playwright call after the last edit), the tool loop
 *  refuses to end the turn once and injects a procedure: run the app, load it
 *  in headless Chrome, assert the invariant programmatically, screenshot for
 *  the human — then report what was actually observed.
 *
 *  Born from the pacman5 session: the model re-read its own edit as
 *  "verification" and reported visual bugs fixed, twice, without ever
 *  rendering a frame. Pure code, no LLM. */

export interface VisualVerifyConfig {
  enabled: boolean;
}

/** Rendering vocabulary (en + de) that marks a turn as visual. */
const VISUAL_RE =
  /\b(render(ing|ed)?|draw(n|ing|s)?|redraw|clip(ping|ped)?|overlap(s|ping|ped)?|layout|screenshot|canvas|webgl|sprite|maze|z-?index|flicker(s|ing)?|glitch(y|es)?|off-?screen|viewport|resolution|pixel(s|ated)?|blurry|invisible|not (visible|shown|displayed)|looks? (wrong|off|broken|weird)|on top of|hinter|verdeckt|überlapp\w*|abgeschnitten|gezeichnet|sichtbar|unsichtbar|verschoben|grafik|darstellung|anzeige)\b/i;

/** A tool call that counts as looking at the rendered output. */
const OBSERVE_RE = /^mcp__playwright__/;

export class VisualVerifyGate {
  private active = false;
  private edited = false;
  private observed = false;
  private nudged = false;

  constructor(private cfg: VisualVerifyConfig) {}

  /** Call at turn start. Images attached to the prompt always mark the turn
   *  visual (the user is showing what it looks like). */
  notePrompt(text: string, hasImages: boolean): void {
    this.active = this.cfg.enabled && (hasImages || VISUAL_RE.test(text));
    this.edited = false;
    this.observed = false;
    this.nudged = false;
  }

  /** Call after each completed tool execution. An edit invalidates any earlier
   *  observation — only looking AFTER the last change counts as verification. */
  noteTool(name: string, kind: string): void {
    if (!this.active) return;
    if (kind === "edit") {
      this.edited = true;
      this.observed = false;
    } else if (OBSERVE_RE.test(name)) {
      this.observed = true;
    }
  }

  /** Called when the model wants to end the turn. Returns the block-message
   *  once per turn when a visual claim would be unverified, else null. */
  beforeFinal(): string | null {
    if (!this.active || !this.edited || this.observed || this.nudged) return null;
    this.nudged = true;
    return (
      "[Automatic visual-verification gate: this task is about something VISUAL and you changed code, " +
      "but you never looked at the rendered result. Re-reading your own edit is NOT verification. " +
      "Do not tell the user it is fixed yet. Verify first:\n" +
      "1. Make sure the app is running (start its dev server / run script via bash with & if needed) and note the URL.\n" +
      "2. Load the page with mcp__playwright__browser_navigate. For canvas/WebGL apps, click the canvas once " +
      "(mcp__playwright__browser_click) — headless rendering can stay black until an interaction.\n" +
      "3. Verify the actual complaint programmatically with mcp__playwright__browser_evaluate. If the app state " +
      "is not reachable from the console, first add a small debug hook in the code (e.g. " +
      "window.__game = { player, ghosts, map, tileSize }) — then assert the real invariant, e.g. every entity's " +
      "tile is walkable (not a wall) and each sprite's bounding box fits inside its tile.\n" +
      "4. For a GAME or interactive app, verifying one movement is NOT enough — exercise the core loop end to end, " +
      "using mcp__playwright__browser_press_key (REAL key events; a synthetic dispatchEvent can pass while real " +
      "keyboard input is broken). Sample the debug hook before/after and assert the deltas that define 'playable': " +
      "the score INCREASES after moving through collectibles; every enemy/NPC leaves its spawn pen within ~10s of " +
      "game start (poll twice, 5s apart — identical positions = stuck AI, a bug); the player never stops dead " +
      "against open corridor; the lose path works (force a collision via the hook if needed → life lost) and the " +
      "win path is reachable (e.g. temporarily set all-but-one collectibles eaten via the hook, eat the last one, " +
      "assert the win state fires). Fix and re-verify anything that fails.\n" +
      "5. Take a screenshot with mcp__playwright__browser_take_screenshot (filename under .grayskull/screenshots/) " +
      "and give the user the path — for games, one screenshot mid-gameplay (after input), not just the start screen.\n" +
      "6. Report what the assertions and the screenshot SHOWED. If the problem is still there, keep fixing — " +
      "do not report success. If a canvastest or webtest skill is available, the skill tool has the full playbook.]"
    );
  }
}
