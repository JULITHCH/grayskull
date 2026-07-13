/** Two-step expand→plan pre-pass. On a substantial turn (the plan-first gate is
 *  armed), GRAYSKULL first rewrites the user's terse request into a
 *  comprehensive build spec that DECOMPOSES the work and assigns a specialist
 *  persona to each sub-task — before any blueprint is written. The brief is
 *  shown to the user, persisted next to the blueprint, and prepended to the turn
 *  so both planning and execution see it.
 *
 *  Background-safe: any failure returns "" and the turn degrades to today's
 *  behavior (the plan-first gate still demands a blueprint on its own). */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "../llm/client";
import type { AgentDef } from "../types";
import { localDir } from "../config/paths";

const EXPAND_SYSTEM = `You are the planning front-end of GRAYSKULL, a coding agent. You do NOT write code or call tools. Your only job: turn a user's (often terse) request into a comprehensive build spec that a coding agent will then plan and execute.

You are given the list of available specialist personas (sub-agents). Rewrite the request into a spec with these sections, and NOTHING else:

## Goal
What "done" looks like, in observable behavior — 1-3 sentences.

## Constraints & assumptions
Anything implied but unstated (target platform, existing conventions to respect, out-of-scope items). Keep it short and concrete.

## Task breakdown
An ordered list of concrete sub-tasks. For EACH sub-task, name the persona that should own it in the form "→ owner: <persona-name>", chosen from the available personas. If a needed specialist does not exist in the list, write "→ owner: NEW <suggested-name> (<one-line role>)" so the agent creates it with create_agent. Keep sub-tasks independent where possible so they can run concurrently.

Rules: be specific to THIS request — no boilerplate. Do not invent requirements the user did not imply. Do not include a plan/blueprint (that is the next step). Output only the three sections as Markdown.`;

/** Rewrite `userText` into a persona-assigning build spec. Returns "" on any
 *  failure (caller degrades gracefully). */
export async function expandPrompt(
  client: LlmClient,
  userText: string,
  agents: AgentDef[],
  cwd: string,
): Promise<string> {
  const roster = agents.length
    ? agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
    : "(none defined yet — assign owners as NEW personas)";
  const user = `Available specialist personas:\n${roster}\n\nUser request:\n${userText}`;
  let brief = "";
  try {
    brief = (await client.oneShot(EXPAND_SYSTEM, user, 2048)).trim();
  } catch {
    return "";
  }
  if (!brief) return "";
  // persist next to the blueprint the plan gate will demand
  try {
    const dir = join(localDir(cwd), "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug(userText)}.brief.md`), `# Expanded brief\n\n> ${userText.replace(/\n+/g, " ").slice(0, 300)}\n\n${brief}\n`);
  } catch {
    // persistence is best-effort; the brief is still injected into the turn
  }
  return brief;
}

/** Filesystem-safe slug from the request; matches the blueprint's <slug>.md. */
function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return s || "task";
}
