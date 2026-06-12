import type { GrayskullAgent, UiBridge } from "../agent/loop";
import type { MemoryManager } from "../memory/memory";
import { expandStep, isGate, type ChainDef, type ChainContextMode } from "./registry";

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
    expandStep(step),
    `\nOriginal task: ${task}`,
  ];
  if (opts.handoff) parts.push(`\nResults of previous steps:\n${opts.handoff}`);
  if (opts.failReason) {
    parts.push(
      `\nA review gate FAILED after your previous attempt at this step. Fix these problems:\n${opts.failReason}`,
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

  let i = 0;
  while (i < chain.steps.length) {
    const step = chain.steps[i]!;
    chainState.running = {
      name: chain.name,
      step: i + 1,
      total: chain.steps.length,
      steps: chain.steps,
      gates: chain.steps.map(isGate),
      mode,
      retrying: failReason !== undefined,
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

    let result: string;
    if (mode === "shared") {
      result = await agent.runTurn(directive);
    } else {
      result = await agent.runIsolated(directive);
      ui.pushItem({ type: "note", text: `⛓ step ${i + 1} report captured (${result.length} chars)` });
    }
    reports[i] = `step ${i + 1} (${step}):\n${result}`;

    if (agent.lastInterrupted) {
      ui.pushItem({ type: "note", text: `⛓ chain "${chain.name}" stopped at step ${i + 1}` });
      break;
    }

    if (isGate(step)) {
      const { verdict, reason } = parseVerdict(result);
      if (verdict === "missing") {
        ui.pushItem({ type: "note", text: "⛓ gate gave no VERDICT — treating as PASS" });
      }
      if (verdict === "fail") {
        // jump back to the nearest previous non-gate step
        let back = i - 1;
        while (back >= 0 && isGate(chain.steps[back]!)) back--;
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
