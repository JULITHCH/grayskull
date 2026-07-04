---
name: canvastest
description: >
  Verify canvas/WebGL games and graphics (PixiJS, three.js, raw canvas) in headless
  Chrome — rendering bugs like sprites drawn on walls, clipping, overlap, wrong
  size/offset, entities off screen. Works without vision: instrument the game state
  on window, assert invariants numerically via browser_evaluate, screenshot for the
  human. Use for any game/canvas rendering complaint or after changing draw code.
---

You are verifying a canvas/WebGL app (game, visualization) in headless Chrome via the
mcp__playwright__ tools. The DOM is a single <canvas> — accessibility snapshots and DOM
layout checks see NOTHING. Your eyes are (a) the app's own state, (b) numeric assertions,
(c) screenshots for the human. Never claim a visual fix without steps 3–6.

1. **Run it**: start the dev server via bash, backgrounded (`./run.sh &` or
   `npx vite --host 0.0.0.0 &`); parse the port from its output. `browser_navigate` to it.

2. **Wake the renderer**: headless WebGL/WebGPU often stays BLACK until an interaction
   (known PixiJS v8 issue). `browser_click` on the canvas once, wait ~500ms. Check
   `browser_console_messages` — JS errors first, they explain most blank screens.

3. **Instrument — expose the state.** If `browser_evaluate` `() => window.__game` is
   undefined, EDIT the app's entry point to publish a debug hook where the objects are
   created, e.g.:
   ```ts
   // debug hook for automated tests
   (window as any).__game = { player, ghosts, map: gameMap, tileSize: TILE_SIZE };
   ```
   Closure-local state is unverifiable; this hook is the difference between guessing
   and knowing. Keep it — it is not dirt, it is testability.
   If a state variable ever gets REASSIGNED (arrays rebuilt on reset/respawn, e.g.
   `ghosts = makeGhosts()`), a plain property snapshot goes stale and you will chase
   phantom nulls. Expose getters instead — always safe, costs nothing:
   ```js
   window.__game = {
     get ghosts() { return ghosts; },
     get player() { return player; },
     get state()  { return gameState; },
     forceWin()   { /* eat all but one pellet */ },
     forceDeath() { /* teleport a ghost onto the player */ },
   };
   ```

4. **Assert the actual complaint numerically** with `browser_evaluate`. Patterns for
   grid/tile games — adapt to the app's structures:
   ```js
   () => {
     const g = window.__game, T = g.tileSize, issues = [];
     const wallAt = (x, y) => g.map.isWall ? g.map.isWall(x, y)
       : g.map.tiles[Math.floor(y / T)]?.[Math.floor(x / T)] === 1;
     for (const [name, e] of Object.entries({ player: g.player, ...g.ghosts })) {
       const s = e.getGraphics?.() ?? e.sprite ?? e;          // display object with x/y
       if (wallAt(s.x, s.y)) issues.push(`${name} CENTER inside a wall tile at ${s.x},${s.y}`);
       const b = s.getBounds?.();                              // sprite bbox vs cell
       if (b && (b.width > T || b.height > T))
         issues.push(`${name} bbox ${Math.round(b.width)}x${Math.round(b.height)} > tile ${T} — will overlap walls even when centered`);
       for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {   // bbox pokes into neighbor walls?
         if (b && wallAt(s.x + dx * (b.width / 2 - 1), s.y + dy * (b.height / 2 - 1)))
           issues.push(`${name} bbox reaches into a wall tile (${dx},${dy})`);
       }
     }
     return issues.length ? issues : "entity/tile invariants OK";
   }
   ```
   Also useful: canvas size vs world size (centering offsets), `renderer.width/height`,
   camera/container `.x/.y`, count of visible children.

5. **Pixel truth (when state lies)**: `browser_take_screenshot` then, if you must check
   colors programmatically, re-init the renderer with `preserveDrawingBuffer: true` and
   `browser_evaluate` `canvas.toDataURL()` cropped samples — or assert via state instead;
   pixels are the fallback, state is primary.

6. **Screenshot for the human**: `browser_take_screenshot` with `filename` set to an
   absolute path under `<cwd>/.grayskull/screenshots/` (before AND after when fixing).
   The user can see; give them the paths.

7. **Exercise**: send real keys (`browser_press_key` ArrowLeft/Space), re-run the step-4
   assertions after movement — position bugs often only appear after input.
   Then test every input affordance the UI ADVERTISES, exactly as advertised: if any
   screen says "PRESS START" / "PRESS SPACE" / "ENTER TO RESTART", press those literal
   keys with browser_press_key and assert the state transition happened; if there is a
   button, click it too. Each promise needs its own working handler — a start screen
   that blinks PRESS START but only reacts to a mouse click is a bug, and so is the
   reverse. Walk the full screen flow this way: start → playing → game over → restart,
   and start → playing → win → next level/restart.

8. **Report**: console errors, each assertion's numbers, screenshot paths, verdict.
   If assertions fail, the bug is NOT fixed — keep working, do not report success.

9. **Generated maps/mazes — assert STRUCTURE, not looks.** You cannot see the screenshot;
   a maze can render error-free and still be wrong (open fields instead of corridors,
   unreachable pellets, leaky borders). MAP-FIRST WORKFLOW: author the tile data and
   validate it with a THROWAWAY BASH SCRIPT (node/bun on the array literal — seconds per
   iteration, no browser) until every check below passes, and only THEN write gameplay
   code against the validated data. Debugging map defects through the running game
   (browser_evaluate archaeology on ghost coordinates) burns tens of minutes per bug —
   the same defect is one line of validator output. Checks, runnable in either world:
   ```js
   () => {
     const g = window.__game, m = g.map.tiles ?? g.map, issues = [];
     const rows = m.length, cols = m[0].length;
     const walk = (r, c) => m[r]?.[c] !== undefined && m[r][c] !== 1;   // adapt wall id
     // a) border closed except intended tunnels (count the gaps, don't assume)
     let gaps = 0;
     for (let r = 0; r < rows; r++) { if (walk(r, 0)) gaps++; if (walk(r, cols - 1)) gaps++; }
     for (let c = 0; c < cols; c++) { if (walk(0, c)) gaps++; if (walk(rows - 1, c)) gaps++; }
     if (gaps > 2) issues.push(`border has ${gaps} openings — expected only the tunnel pair`);
     // b) corridors, not rooms: classic arcade mazes are 1 tile wide — a 2x2 fully
     //    walkable block (outside the ghost-house area) means open fields, wrong shape
     let blocks = 0;
     for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++)
       if (walk(r, c) && walk(r, c + 1) && walk(r + 1, c) && walk(r + 1, c + 1)) blocks++;
     if (blocks > 4) issues.push(`${blocks} 2x2 open blocks — corridors are not 1 tile wide`);
     // c) left-right symmetry (classic pacman mazes mirror horizontally)
     let asym = 0;
     for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
       if (walk(r, c) !== walk(r, cols - 1 - c)) asym++;
     if (asym > 0) issues.push(`${asym} tiles break left-right symmetry`);
     // d) every collectible reachable from spawn (BFS)
     const seen = new Set(); const q = [[g.spawnRow ?? 17, g.spawnCol ?? 14]];
     while (q.length) { const [r, c] = q.pop(), k = r + "," + c;
       if (seen.has(k) || !walk(r, c)) continue; seen.add(k);
       q.push([r+1,c],[r-1,c],[r,c+1],[r,c-1]); }
     let stranded = 0;
     for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
       if (m[r][c] === 2 /* pellet id — adapt */ && !seen.has(r + "," + c)) stranded++;
     if (stranded) issues.push(`${stranded} pellets unreachable from spawn`);
     return issues.length ? issues : "maze structure OK";
   }
   ```
   These thresholds are HARD gates, not suggestions: a failing number means the map
   data is wrong — fix the data and re-run the check until it passes. Do NOT explain a
   failing count away ("that's normal for this game") and do NOT weaken the check;
   verification you reinterpret after the fact is verification you don't have.
   Get symmetry and corridor width right BY CONSTRUCTION, not by inspection: author
   only the LEFT half of each row and mirror it programmatically —
   ```js
   const HALF = [
     "WWWWWWWWWWWWWW",   // 14 cols; W wall, . pellet, o power, ' ' empty, - door
     "W......W......",
     // ... one string per row, left half only
   ];
   const MAZE = HALF.map(h => h + [...h].reverse().join(""));  // 28 cols, symmetric by construction
   ```
   then spot-fix the middle seam (tunnel rows, ghost-house door) and re-run the checks.
   Fix the MAP DATA until this passes — hand-author the layout row by row if generation
   fights you; a known-good hardcoded classic layout beats a broken generator.
   For a PACMAN-STYLE game, do not author the maze from scratch: start from this
   reference layout (28 cols × 31 rows; W wall, `.` pellet, `o` power pellet, `-`
   ghost-house door, space = walkable empty; validated: symmetric, no dead ends, no
   open fields, all 240 pellets + 4 power pellets reachable):
   ```
   WWWWWWWWWWWWWWWWWWWWWWWWWWWW
   W............WW............W
   W.WWWW.WWWWW.WW.WWWWW.WWWW.W
   WoWWWW.WWWWW.WW.WWWWW.WWWWoW
   W.WWWW.WWWWW.WW.WWWWW.WWWW.W
   W............WW............W
   W.WWWW.WW.WWWWWWWW.WW.WWWW.W
   W.WWWW.WW.WWWWWWWW.WW.WWWW.W
   W......WW..........WW......W
   WWWWWW.WW WWWWWWWW WW.WWWWWW
   WWWWWW.WW WWWWWWWW WW.WWWWWW
   WWWWWW.WW          WW.WWWWWW
   WWWWWW.WW WWW--WWW WW.WWWWWW
   WWWWWW.WW W      W WW.WWWWWW
   WWWWWW.WW W      W WW.WWWWWW
         .   WWWWWWWW   .      
   WWWWWW.WW WWWWWWWW WW.WWWWWW
   WWWWWW.WW          WW.WWWWWW
   WWWWWW.WW WWWWWWWW WW.WWWWWW
   WWWWWW.WW WWWWWWWW WW.WWWWWW
   W............WW............W
   W.WWWW.WWWWW.WW.WWWWW.WWWW.W
   W.WWWW.WWWWW.WW.WWWWW.WWWW.W
   Wo..WW................WW..oW
   WWW.WW.WW.WWWWWWWW.WW.WW.WWW
   WWW.WW.WW.WWWWWWWW.WW.WW.WWW
   W......WW....WW....WW......W
   W.WWWWWWWWWW.WW.WWWWWWWWWW.W
   W.WWWWWWWWWW.WW.WWWWWWWWWW.W
   W............WW............W
   WWWWWWWWWWWWWWWWWWWWWWWWWWWW
   ```
   Geography, so nothing gets placed wrong: the ghost-house INTERIOR is rows 13–14,
   cols 11–16 (spawn all four ghosts there); the door is row 12, cols 13–14; the wrap
   TUNNEL is row 15 and is fully walled off from the house — no entity belongs on row
   15 at start. Pac-Man spawns on row 23 (the `o..` row), center. Copy the layout
   VERBATIM — row 15 has 6 leading AND 6 trailing spaces, every row is exactly 28
   chars; run the validator to prove the copy — then adapt tile ids to your engine.
   Pellet/row counts are whatever the validator reports — there is no magic number to
   hit beyond the checks passing; never invent numeric targets and fight the map to
   reach them. Entity
   visibility belongs here too: after starting the game, assert the player and every
   enemy is inside the playfield bounds and actually drawn (position within canvas,
   not NaN, not stuck at an off-screen HUD coordinate).

Common root causes to check when "X is drawn on/over Y" in tile games:
- sprite radius/bbox larger than the tile (e.g. radius 20 in a 32px cell → guaranteed overlap)
- spawn/position constants landing on wall tiles (verify against the map array!)
- collision testing only the CENTER point while the sprite is bbox-sized
- two coordinate conventions mixed: tile-origin (col*T) vs tile-center (col*T + T/2)
- duplicate hardcoded dimensions drifting apart (map rows vs hardcoded height)
- draw order (addChild order / missing layers) — check last, it's rarer than geometry
