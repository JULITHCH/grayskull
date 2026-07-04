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
 *  rendering a frame. Pure code, no LLM.
 *
 *  Hardened after pacman refinement turns 02/03: a single token playwright
 *  call ("canvas has non-black pixels") used to satisfy the gate, so the deep
 *  procedure text never reached the model and end states went unverified.
 *  Now (a) the checklist is injected proactively into the system message on
 *  visual turns, and (b) the gate demands DEPTH after the last edit —
 *  browser_evaluate + screenshot, plus a real key press for interactive
 *  work — before the turn may end. */

export interface VisualVerifyConfig {
  enabled: boolean;
}

/** Rendering vocabulary (en + de) that marks a turn as visual. */
const VISUAL_RE =
  /\b(render(ing|ed)?|draw(n|ing|s)?|redraw|clip(ping|ped)?|overlap(s|ping|ped)?|layout|screenshot|canvas|webgl|sprite|maze|z-?index|flicker(s|ing)?|glitch(y|es)?|off-?screen|viewport|resolution|pixel(s|ated)?|blurry|invisible|not (visible|shown|displayed)|looks? (wrong|off|broken|weird)|on top of|hinter|verdeckt|überlapp\w*|abgeschnitten|gezeichnet|sichtbar|unsichtbar|verschoben|grafik|darstellung|anzeige)\b/i;

/** Interactive/game vocabulary — raises the bar to include real input events. */
const INTERACTIVE_RE =
  /\b(game|play(able|er)?|arcade|pac-?man|tetris|snake|breakout|pong|platformer|shooter|ghost(s)?|enemy|enemies|level(s)?|score|lives|keyboard|arrow[- ]?keys?|controls?|input|click(s|able)?|drag|joystick|spiel(bar)?|steuerung|tast\w+|gegner|punkte(stand)?)\b/i;

/** A tool call that counts as looking at the rendered output. */
const OBSERVE_RE = /^mcp__playwright__/;

export class VisualVerifyGate {
  private active = false;
  private interactive = false;
  private edited = false;
  private nudged = false;
  // depth of observation since the last edit
  private evaluated = false;
  private screenshotted = false;
  private pressedKey = false;
  private observedAny = false;

  constructor(private cfg: VisualVerifyConfig) {}

  /** Call at turn start. Images attached to the prompt always mark the turn
   *  visual (the user is showing what it looks like). */
  notePrompt(text: string, hasImages: boolean): void {
    this.active = this.cfg.enabled && (hasImages || VISUAL_RE.test(text));
    this.interactive = this.active && INTERACTIVE_RE.test(text);
    this.edited = false;
    this.nudged = false;
    this.resetObservations();
  }

  private resetObservations(): void {
    this.evaluated = false;
    this.screenshotted = false;
    this.pressedKey = false;
    this.observedAny = false;
  }

  /** Call after each completed tool execution. An edit invalidates any earlier
   *  observation — only looking AFTER the last change counts as verification. */
  noteTool(name: string, kind: string): void {
    if (!this.active) return;
    if (kind === "edit") {
      this.edited = true;
      this.resetObservations();
    } else if (OBSERVE_RE.test(name)) {
      this.observedAny = true;
      if (name.includes("browser_evaluate")) this.evaluated = true;
      else if (name.includes("browser_take_screenshot")) this.screenshotted = true;
      else if (name.includes("browser_press_key")) this.pressedKey = true;
    }
  }

  /** Deep enough to end the turn: state asserted + frame captured after the
   *  last edit; interactive work additionally needs a real key event. */
  private verifiedDeeply(): boolean {
    return this.evaluated && this.screenshotted && (!this.interactive || this.pressedKey);
  }

  /** Proactive checklist for the system message on visual turns — the model
   *  should build for verification up front, not retrofit it when blocked. */
  systemHint(): string {
    if (!this.active) return "";
    const base =
      "# Visual verification contract (this turn)\n" +
      "This task produces something RENDERED. Re-reading your own code is not verification; before you finish " +
      "you must load the page with the playwright tools, assert state with browser_evaluate, and take a " +
      "screenshot AFTER your last edit. Build the code verification-ready from the start: expose " +
      "window.__game = { ...live state objects (not a snapshot function) } plus test seams like " +
      "__game.forceWin() and __game.forceDeath() so end states are drivable from browser_evaluate.";
    const game = this.interactive
      ? "\nThis is INTERACTIVE: also drive it with mcp__playwright__browser_press_key (real key events — a " +
        "synthetic dispatchEvent can pass while real keyboard input is broken) and assert the deltas that make it " +
        "playable: score increases through collectibles, every enemy leaves its spawn area within ~10s (poll twice), " +
        "the lose path (collision → life lost → game over) and the win path (last collectible → win state) both " +
        "fire — use the seams to reach them. Screenshot mid-gameplay, not just the start screen.\n" +
        "If this reimplements a WELL-KNOWN game, research its authentic mechanics online FIRST " +
        "(mcp__searxng__searxng_web_search + web_url_read an authoritative reference) — your recalled version of " +
        "input buffering, enemy AI, and turning rules is incomplete and partly wrong; implement from the fetched " +
        "rules, not from memory."
      : "";
    return base + game;
  }

  /** Called when the model wants to end the turn. Returns the block-message
   *  once per turn when a visual claim would be unverified, else null. */
  beforeFinal(): string | null {
    if (!this.active || !this.edited || this.nudged || this.verifiedDeeply()) return null;
    this.nudged = true;
    const missing = [
      !this.evaluated && "no browser_evaluate state assertion",
      !this.screenshotted && "no screenshot",
      this.interactive && !this.pressedKey && "no real key press (browser_press_key)",
    ]
      .filter(Boolean)
      .join(", ");
    const shallow = this.observedAny
      ? `You did look at the page, but not deeply enough after your last edit: ${missing}. `
      : "You never looked at the rendered result after your last edit. ";
    return (
      "[Automatic visual-verification gate: this task is about something VISUAL and you changed code. " +
      shallow +
      "Re-reading your own edit is NOT verification. Do not tell the user it is done yet. Verify first:\n" +
      "1. Make sure the app is running (start its dev server / run script via bash with & if needed) and note the URL.\n" +
      "2. Load the page with mcp__playwright__browser_navigate. For canvas/WebGL apps, click the canvas once " +
      "(mcp__playwright__browser_click) — headless rendering can stay black until an interaction.\n" +
      "3. Verify the actual behavior programmatically with mcp__playwright__browser_evaluate. If the app state " +
      "is not reachable from the console, first add a debug hook in the code exposing the LIVE objects (not a " +
      "snapshot-returning function), e.g. window.__game = { player, ghosts, map, tileSize }, plus tiny test seams " +
      "callable from browser_evaluate — e.g. __game.forceWin() eats all but one collectible, __game.forceDeath() " +
      "teleports an enemy onto the player — then assert the real invariant, e.g. every entity's tile is walkable " +
      "and each sprite's bounding box fits inside its tile.\n" +
      "4. For a GAME or interactive app, verifying one movement is NOT enough — exercise the core loop end to end, " +
      "using mcp__playwright__browser_press_key (REAL key events; a synthetic dispatchEvent can pass while real " +
      "keyboard input is broken). Sample the debug hook before/after and assert the deltas that define 'playable': " +
      "the score INCREASES after moving through collectibles; every enemy/NPC leaves its spawn pen within ~10s of " +
      "game start (poll twice, 5s apart — identical positions = stuck AI, a bug); the player never stops dead " +
      "against open corridor; the lose path works (force a collision via the seam → life lost → game over at zero) " +
      "and the win path is reachable (forceWin(), eat the last collectible, assert the win state fires). Fix and " +
      "re-verify anything that fails.\n" +
      "5. Take a screenshot with mcp__playwright__browser_take_screenshot (filename under .grayskull/screenshots/) " +
      "and give the user the path — for games, one screenshot mid-gameplay (after input), not just the start screen.\n" +
      "6. Report what the assertions and the screenshot SHOWED. If the problem is still there, keep fixing — " +
      "do not report success. If a canvastest or webtest skill is available, the skill tool has the full playbook.]"
    );
  }
}
