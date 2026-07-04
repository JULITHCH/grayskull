---
name: canvasgame
description: research, plan, build, feel-gate verify — canvas game pipeline
context: fresh
steps:
  research authentic mechanics online and list the concrete rules to implement, do not write code yet: think=off temp=0.7 gate=false mcp=on
  write an implementation plan that pins every architecture decision before any code, one single direction table and keymap derived from it, the exact map data source copied verbatim from the canvastest skill, ghost house geometry with spawn tiles and door tiles and exit path, the debug hook shape with live getters and forceWin forceDeath seams, the tile-center movement and cornering math, and the list of measured asserts the build must pass, do not write the game yet: think=on temp=0.6 gate=false require=canvastest mcp=off
  implement the game exactly as planned, then save the feeltest runner from the canvastest skill and run it with bash, fixing every FAIL line before you finish, deviate from the plan only if it is impossible and say so: think=off temp=0.7 require=canvastest mcp=on
  verify gameplay feel, run every canvastest assert and report each measured number, end with VERDICT PASS or VERDICT FAIL plus the failing asserts: think=on temp=0.6 gate=true require=canvastest mcp=on
  write the final summary listing features and the measured assert table with screenshot paths, do not edit code and do not research anything in this step: think=off temp=0.7 gate=false mcp=on
---

research authentic mechanics online and list the concrete rules to implement, do not write code yet
-> write an implementation plan that pins every architecture decision before any code, one single direction table and keymap derived from it, the exact map data source copied verbatim from the canvastest skill, ghost house geometry with spawn tiles and door tiles and exit path, the debug hook shape with live getters and forceWin forceDeath seams, the tile-center movement and cornering math, and the list of measured asserts the build must pass, do not write the game yet
-> implement the game exactly as planned, then save the feeltest runner from the canvastest skill and run it with bash, fixing every FAIL line before you finish, deviate from the plan only if it is impossible and say so
-> verify gameplay feel, run every canvastest assert and report each measured number, end with VERDICT PASS or VERDICT FAIL plus the failing asserts
-> write the final summary listing features and the measured assert table with screenshot paths, do not edit code and do not research anything in this step
