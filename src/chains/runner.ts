import type { GrayskullAgent, UiBridge } from "../agent/loop";
import type { MemoryManager } from "../memory/memory";
import {
  expandStep,
  stepGate,
  stepPresetName,
  resolveStepConfig,
  type ChainDef,
  type ChainContextMode,
} from "./registry";

const MAX_GATE_RETRIES = 2;
const HANDOFF_CAP = 4000;

/** Mutable progress for the statusline, same trick as tools/todo.ts todoState. */
export const chainState: {
  running: {
    name: string;
    step: number;
    total: number;
    steps: string[];
    gates: boolean[];
    mode: ChainContextMode;
    retrying: boolean;
    /** model preset name driving the current step (for the statusline) */
    model?: string;
  } | null;
  /** sticky chain applied to every prompt until /thinkingchain off */
  sticky: { def: ChainDef; mode: ChainContextMode } | null;
} = { running: null, sticky: null };

function buildDirective(opts: {
  chain: ChainDef;
  task: string;
  index: number;
  failReason?: string;
  handoff?: string;
}): string {
  const { chain, task, index } = opts;
  const step = chain.steps[index]!;
  const parts = [
    `[Thinking chain "${chain.name}" — step ${index + 1}/${chain.steps.length}: ${step}]`,
    expandStep(step, stepGate(step, chain)),
    `\nOriginal task: ${task}`,
  ];
  if (opts.handoff) parts.push(`\nResults of previous steps:\n${opts.handoff}`);
  if (opts.failReason) {
    parts.push(
      `\nA review gate FAILED after your previous attempt at this step. Fix these problems:\n${opts.failReason}`,
    );
  }
  const cfg = resolveStepConfig(step, chain);
  if (cfg?.subagentsEnabled === true) {
    parts.push(
      `\nWhere this step's work splits across independent files, modules or subtopics, spawn sub-agents with spawn_agent (one call per unit — multiple calls in one response run in parallel) and synthesise their reports.`,
    );
  }
  parts.push(
    `\nDo ONLY this step. Do not work ahead — later steps in the chain handle the rest.`,
  );
  return parts.join("\n");
}

function parseVerdict(text: string): { verdict: "pass" | "fail" | "missing"; reason: string } {
  const m = text.match(/VERDICT:\s*(PASS|FAIL)\s*:?\s*([\s\S]*)/i);
  if (!m) return { verdict: "missing", reason: "" };
  if (m[1]!.toUpperCase() === "PASS") return { verdict: "pass", reason: "" };
  return { verdict: "fail", reason: (m[2] ?? "").trim().slice(0, 1500) || "(no reason given)" };
}

export async function runChain(opts: {
  chain: ChainDef;
  task: string;
  mode: ChainContextMode;
  agent: GrayskullAgent;
  ui: UiBridge;
  memory: MemoryManager;
}): Promise<void> {
  const { chain, task, mode, agent, ui, memory } = opts;
  const retries = new Map<number, number>();
  /** fresh mode: rolling reports of completed steps, keyed by step index */
  const reports: string[] = [];
  let failReason: string | undefined;

  ui.pushItem({
    type: "banner",
    text: `⛓ chain "${chain.name}" (${mode}) — ${chain.steps.length} steps\n${chain.steps.join(" → ")}`,
    color: "magenta",
  });

  // per-step model switching: remember the session model and restore it after
  const baseModel = agent.snapshotModelPreset();
  let activeModel = baseModel;
  const gates = chain.steps.map((s) => stepGate(s, chain));

  let i = 0;
  try {
    while (i < chain.steps.length) {
      const step = chain.steps[i]!;
      const cfg = resolveStepConfig(step, chain);

      // resolve + apply the step's model (named preset), else stay on base
      let target = baseModel;
      let modelLabel = baseModel.model;
      if (cfg?.model) {
        const preset = agent.lookupModelPreset(cfg.model);
        if (preset) {
          target = preset;
          modelLabel = cfg.model;
        } else {
          ui.pushItem({
            type: "note",
            text: `⛓ unknown model "${cfg.model}" — staying on ${baseModel.model}`,
          });
        }
      }
      if (target.baseURL !== activeModel.baseURL || target.model !== activeModel.model) {
        agent.applyModelSwitch(target);
        activeModel = target;
      }

      chainState.running = {
        name: chain.name,
        step: i + 1,
        total: chain.steps.length,
        steps: chain.steps,
        gates,
        mode,
        retrying: failReason !== undefined,
        model: modelLabel,
      };
      ui.pushItem({
        type: "banner",
        text: `⛓ step ${i + 1}/${chain.steps.length}: ${step}${failReason ? " (retry)" : ""}`,
        color: "magenta",
      });

      const handoff =
        mode === "fresh" && reports.length > 0
          ? reports.slice(-2).join("\n\n---\n\n").slice(-HANDOFF_CAP)
          : undefined;
      const directive = buildDirective({ chain, task, index: i, failReason, handoff });
      failReason = undefined;

      // per-step inference profile: thinking + sampling flipped together
      // (resolved AFTER the model switch so it reflects the step's model family)
      const preset = stepPresetName(step, chain);
      const profile = agent.resolveChainStepProfile(step, chain);
      agent.setInferenceProfile(profile);
      // per-step skills: force-load required, block forbidden (auto-load + tool)
      agent.setStepSkills(cfg?.requiredSkills ?? [], cfg?.forbiddenSkills ?? []);
      // per-step MCP tools: off by default in the editor, opt-in per step
      agent.setStepMcp(cfg?.mcpEnabled, cfg?.mcpTools ?? []);
      // per-step sub-agents: enable + nudge fan-out, or remove the spawn tools
      agent.setStepSubagents(cfg?.subagentsEnabled);
      ui.pushItem({
        type: "note",
        text: `⛓ profile: ${preset} · model ${modelLabel} (think:${profile.enableThinking ? "on" : "off"} · temp ${profile.temperature} · top_p ${profile.topP})`,
      });

      let result: string;
      try {
        if (mode === "shared") {
          result = await agent.runTurn(directive);
        } else {
          result = await agent.runIsolated(directive);
          ui.pushItem({ type: "note", text: `⛓ step ${i + 1} report captured (${result.length} chars)` });
        }
      } finally {
        agent.setInferenceProfile(null); // revert to session sampling between steps
        agent.setStepSkills([], []); // clear per-step skill overrides
        agent.setStepMcp(undefined, []); // clear per-step MCP gate
        agent.setStepSubagents(undefined); // clear per-step sub-agent gate
      }
      reports[i] = `step ${i + 1} (${step}):\n${result}`;

      if (agent.lastInterrupted) {
        ui.pushItem({ type: "note", text: `⛓ chain "${chain.name}" stopped at step ${i + 1}` });
        break;
      }

      // a step that errored (e.g. model 400) produced no real output — say so,
      // and never let a gate silently PASS on it
      const stepErr = agent.lastError;
      if (stepErr) {
        ui.pushItem({ type: "note", text: `⛓ step ${i + 1} (${step}) errored — ${stepErr}` });
      }

      if (gates[i]) {
        if (stepErr) {
          ui.pushItem({
            type: "note",
            text: `⛓ gate could not run (errored) — continuing WITHOUT verification`,
          });
          i++;
          continue;
        }
        const { verdict, reason } = parseVerdict(result);
        if (verdict === "missing") {
          ui.pushItem({ type: "note", text: "⛓ gate gave no VERDICT — treating as PASS" });
        }
        if (verdict === "fail") {
          // jump back to the nearest previous non-gate step
          let back = i - 1;
          while (back >= 0 && gates[back]) back--;
          if (back < 0) back = i; // gate is the first step — retry the gate itself
          const attempts = (retries.get(back) ?? 0) + 1;
          retries.set(back, attempts);
          if (attempts > MAX_GATE_RETRIES) {
            ui.pushItem({
              type: "note",
              text: `⛓ gate still failing after ${MAX_GATE_RETRIES} retries — continuing anyway: ${reason}`,
            });
          } else {
            ui.pushItem({ type: "note", text: `⛓ gate FAILED → back to step ${back + 1}: ${reason}` });
            failReason = reason;
            i = back;
            continue;
          }
        }
      }
      i++;
    }
  } finally {
    // belt-and-suspenders: never let a per-step gate survive the chain (a throw
    // in the wrong spot could otherwise leave MCP/sub-agents/skills gated for the
    // next normal turn). The per-step finally already clears these each step.
    agent.setInferenceProfile(null);
    agent.setStepSkills([], []);
    agent.setStepMcp(undefined, []);
    agent.setStepSubagents(undefined);
    // restore the session model if a per-step switch left us on another one
    if (activeModel.baseURL !== baseModel.baseURL || activeModel.model !== baseModel.model) {
      agent.applyModelSwitch(baseModel);
      ui.pushItem({ type: "note", text: `⛓ restored session model: ${baseModel.model}` });
    }
  }

  chainState.running = null;
  ui.pushItem({ type: "banner", text: `⛓ chain "${chain.name}" finished`, color: "magenta" });

  if (mode === "fresh") {
    // the per-step contexts are gone — give the main conversation one summary
    // turn and feed the memory extractor once for the whole chain
    const summary = `[Thinking chain "${chain.name}" completed the task: ${task}]\n\n${reports.join("\n\n").slice(0, 8000)}`;
    agent.history.push(
      { role: "user", content: `[chain "${chain.name}" run] ${task}` },
      { role: "assistant", content: summary },
    );
    void memory.extractFromTurn(summary);
  }
}
