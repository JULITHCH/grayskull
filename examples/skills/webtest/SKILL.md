---
name: webtest
description: Test a web page in headless Chrome — functionality and rendering issues — using the playwright MCP tools. Works without vision by combining console errors, accessibility snapshots, and JS layout assertions.
---

You are testing a web page in headless Chrome via the mcp__playwright__ tools. You cannot SEE the page — you compensate with structure and measurements. Follow this procedure:

1. **Load**: `browser_navigate` to the URL (start the app's server first if needed, backgrounded with `&`). `browser_resize` to 1280x800 unless told otherwise.

2. **Console first**: `browser_console_messages`. JS errors are behind most rendering problems. Report every error/warning with its source line.

3. **Structure**: `browser_snapshot` — the accessibility tree is your eyes. Check: are the expected elements present, in sensible order, with accessible names? Anything missing here is invisible or broken markup.

4. **Layout assertions** — run with `browser_evaluate`. This JS finds the common rendering bugs numerically; adapt per page:

```js
() => {
  const issues = [];
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) issues.push(`overflow-x: ${el.tagName}.${el.className} at ${Math.round(r.left)},${Math.round(r.right)}`);
    if (el.scrollWidth > el.clientWidth + 1 && s.overflowX === 'visible') issues.push(`content overflow: ${el.tagName}.${el.className}`);
  }
  // overlap check for siblings that should not overlap
  const els = [...document.querySelectorAll('main *, body > *')].filter(e => e.getBoundingClientRect().height > 0).slice(0, 80);
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
    const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 8 && oy > 8) issues.push(`overlap: ${els[i].tagName}.${els[i].className} x ${els[j].tagName}.${els[j].className}`);
  }
  if (document.documentElement.scrollWidth > vw + 1) issues.push('page has horizontal scrollbar');
  return issues.length ? issues : 'no layout issues detected';
}
```

5. **Interact**: exercise the main flows with `browser_click` / `browser_type` / `browser_press_key` (games: send the actual keys, e.g. Space, ArrowLeft). After each interaction re-check console + snapshot (or evaluate game state directly, e.g. `() => window.game?.state`).

6. **Responsive**: repeat step 4 at 375x667 (`browser_resize`) — most layout bugs hide on mobile widths.

7. **Evidence for the human**: `browser_take_screenshot` with `filename` set to an absolute path under the project (e.g. `<cwd>/.grayskull/screenshots/page.png`) and tell the user the path — they can SEE what you cannot. Take one per tested viewport/state.

8. **Report**: console errors, structural problems, layout assertion hits, behavior bugs, screenshot paths. Concrete and terse; quote selectors and numbers.
