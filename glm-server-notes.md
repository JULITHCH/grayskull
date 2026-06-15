# glm-server-notes.md — GLM-4.5-Air handoff

Verified values for the grayskull `glm4.5` model profile. The grayskull-side
values below are sourced from authoritative docs (the original notes file from
the vLLM setup step was not present, and no GLM server was running, so these
were re-derived from the GLM-4.5-Air model card + vLLM GLM docs as the task
instructed). **The server-runtime values are still TBD** — run the vLLM
GLM-4.5-Air server task to fill them in and to enable live verification.

## Verified (grayskull side — wired into `src/llm/profiles.ts`)

| Item | Value | Source |
|---|---|---|
| tool-call parser | `glm45` | vLLM blog (2025-08-19), vLLM recipes GLM guide, zai-org/GLM-4.5 model card |
| reasoning parser | `glm45` | same |
| thinking toggle | `chat_template_kwargs: {"enable_thinking": <bool>}`, **default ON** | vLLM blog, zai-org/GLM-4.5 issue #42, model card |
| reasoning field | `reasoning_content` (OpenAI message delta) | vLLM blog ("wrapped in reasoning_content; content holds only the final answer") |
| tool-call leak format | `<tool_call>NAME` + `<arg_key>K</arg_key><arg_value>V</arg_value>…` + `</tool_call>` — **XML, not JSON** | vLLM `glm4_moe` tool parser, GLM `chat_template.jinja`, lmstudio-ai/lmstudio-bug-tracker #829 |
| sampling (default) | temp 0.6 / top_p 0.95 / top_k 40 / min_p 0 | zai-org/GLM-4.5 issue #12 (official), Z.AI param docs |

grayskull presets (`glm4.5` profile):
- `codegen` → thinking OFF, temp 0.2 / top_p 0.95 / top_k 40 / min_p 0 (deterministic code; GLM-4.5-Air does not publish a distinct non-thinking coding preset, so temp is lowered from the documented default — tune as desired)
- `reason` → thinking ON, temp 0.6 / top_p 0.95 / top_k 40 / min_p 0 (GLM documented default)

## TBD — fill from the vLLM server task (not run here)

- endpoint URL + port (task default `--port 8001`; same Spark → likely `http://10.8.0.22:8001/v1`)
- served-model-name (task default `glm-4.5-air`)
- pinned 4-bit quant + exact revision (NVFP4 preferred, else AWQ/GPTQ)
- fitted `--max-model-len` and computed `--gpu-memory-utilization`
- measured tokens/sec, thinking-on vs off

Launch flags template (verified parser names; fill the bracketed runtime values):

```
vllm serve <pinned-4bit-GLM-4.5-Air> \
  --port 8001 --served-model-name glm-4.5-air \
  --enable-prefix-caching \
  --enable-auto-tool-choice --tool-call-parser glm45 \
  --reasoning-parser glm45 \
  --kv-cache-dtype fp8 \
  --max-model-len <fits> --gpu-memory-utilization <computed> \
  -tp 1 --trust-remote-code
```

## Switch grayskull to GLM

In `~/.config/grayskull/settings.json` (or a project `.grayskull/settings.json`):

```json
{
  "modelFamily": "glm4.5",
  "baseURL": "http://10.8.0.22:8001/v1",
  "model": "glm-4.5-air",
  "enableThinking": false
}
```

`modelFamily: "glm4.5"` switches the leak-recovery dialect and the chain-step
sampling presets. Reverting to `"qwen3.5"` (or omitting it) restores the Qwen
path with no other change.
