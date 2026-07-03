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

8. **Report**: console errors, each assertion's numbers, screenshot paths, verdict.
   If assertions fail, the bug is NOT fixed — keep working, do not report success.

Common root causes to check when "X is drawn on/over Y" in tile games:
- sprite radius/bbox larger than the tile (e.g. radius 20 in a 32px cell → guaranteed overlap)
- spawn/position constants landing on wall tiles (verify against the map array!)
- collision testing only the CENTER point while the sprite is bbox-sized
- two coordinate conventions mixed: tile-origin (col*T) vs tile-center (col*T + T/2)
- duplicate hardcoded dimensions drifting apart (map rows vs hardcoded height)
- draw order (addChild order / missing layers) — check last, it's rarer than geometry
