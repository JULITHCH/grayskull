---
name: canvasgame
description: research-first canvas game build with a hard gameplay-feel gate
context: shared
steps:
  research authentic mechanics online and list the concrete rules to implement, do not write code yet: think=off temp=0.7 gate=false mcp=on
  implement the game following the researched rules and the canvastest skill, copy any reference map data from the skill verbatim instead of authoring or researching your own: think=off temp=0.7 require=canvastest mcp=on
  verify gameplay feel, run every canvastest assert and report each measured number, end with VERDICT PASS or VERDICT FAIL plus the failing asserts: think=on temp=0.6 gate=true require=canvastest mcp=on
  write the final summary listing features and the measured assert table with screenshot paths, do not edit code and do not research anything in this step: think=off temp=0.7 gate=false mcp=on
---

research authentic mechanics online and list the concrete rules to implement, do not write code yet
-> implement the game following the researched rules and the canvastest skill, copy any reference map data from the skill verbatim instead of authoring or researching your own
-> verify gameplay feel, run every canvastest assert and report each measured number, end with VERDICT PASS or VERDICT FAIL plus the failing asserts
-> write the final summary listing features and the measured assert table with screenshot paths, do not edit code and do not research anything in this step
