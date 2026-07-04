---
name: canvasgame
description: research-first canvas game build with a hard gameplay-feel gate
context: shared
steps:
  research authentic mechanics online and list the concrete rules to implement: think=off temp=0.7 gate=false mcp=on
  implement the game following the researched rules and the canvastest skill: think=off temp=0.7 require=canvastest mcp=on
  verify gameplay feel, run every canvastest assert and report each measured number, end with VERDICT PASS or VERDICT FAIL plus the failing asserts: think=on temp=0.6 gate=true require=canvastest mcp=on
  final report with screenshots and the measured assert table: think=off temp=0.7 gate=false mcp=on
---

research authentic mechanics online and list the concrete rules to implement
-> implement the game following the researched rules and the canvastest skill
-> verify gameplay feel, run every canvastest assert and report each measured number, end with VERDICT PASS or VERDICT FAIL plus the failing asserts
-> final report with screenshots and the measured assert table
