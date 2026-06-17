import type { ChatMessage } from "../types";
import type { LlmClient } from "../llm/client";
import { estimateMessagesTokens } from "../llm/client";

const KEEP_RECENT = 6;

const COMPACT_SYSTEM = `You compress a coding-session transcript into a briefing for an AI agent that will continue the work. Keep, in this order:
1. The user's overall goal and any explicit requirements/preferences.
2. Current state: what has been done, what files were changed and how.
3. Key technical facts learned (APIs, paths, commands, gotchas).
4. What remains to be done next.
Be dense and factual. No prose padding. Max ~800 words.`;

const HANDOFF_SYSTEM = `You are writing a HANDOFF BRIEF for an AI coding agent whose context window was just reset mid-task. After the reset, this brief plus the agent's project memory are the ONLY things it knows about the work in progress, so it MUST be complete enough to resume and FINISH the task without re-reading the conversation. Do not tell it to start over.

Write densely and factually, no padding, under these headings:
TASK: the exact goal / feature being implemented and any explicit requirements.
DONE: what is already built or changed, and in which files (real paths).
KEY FACTS: paths, function/symbol names, commands, decisions, and gotchas needed to continue.
NEXT STEPS: the precise remaining steps, in order, to finish.
VERIFY: the exact command(s) to confirm it works.

Be concrete (real file paths and names from the transcript). Max ~600 words. Output only the brief.`;

/** Truncated transcript of a history, bounded so it can't overflow oneShot. */
export function historyToTranscript(messages: ChatMessage[], perMsgCap = 2000, totalCap = 200000): string {
  let t = messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const calls =
        "tool_calls" in m && m.tool_calls
          ? m.tool_calls
              .flatMap((tc) =>
                tc.type === "function"
                  ? [`\n[called ${tc.function.name}(${tc.function.arguments.slice(0, 300)})]`]
                  : [],
              )
              .join("")
          : "";
      return `${m.role}: ${content.slice(0, perMsgCap)}${calls}`;
    })
    .join("\n\n");
  if (t.length > totalCap) t = "…[earlier history truncated]…\n" + t.slice(-totalCap);
  return t;
}

/**
 * "memory-swap" strategy: write a task-continuation brief, then FULLY clear the
 * window and reseed it with just that brief. Durable facts already live in
 * project memory (auto-extracted each turn, re-injected) — this brief carries
 * the live task state. The model resumes from brief + memory instead of from a
 * half-summarized history, which a mid-size model follows far more reliably.
 */
export async function memorySwap(client: LlmClient, history: ChatMessage[]): Promise<ChatMessage[]> {
  const brief = await client.oneShot(HANDOFF_SYSTEM, historyToTranscript(history), 1600);
  if (!brief.trim()) throw new Error("empty handoff brief");
  return [
    {
      role: "user",
      content:
        "[Your context was nearly full and has been reset to keep you fast and accurate. " +
        "Durable project facts are in your memory (above). Below is the live state of the task " +
        "you are in the middle of — RESUME and FINISH it, do not restart from scratch:]\n\n" +
        brief,
    },
  ];
}

export function needsCompaction(
  messages: ChatMessage[],
  contextWindow: number,
  threshold: number,
  maxTokens: number,
): boolean {
  // leave room for the reply
  return estimateMessagesTokens(messages) > contextWindow * threshold - maxTokens;
}

/**
 * Replace everything but the most recent messages with a model-written
 * summary. Memory files survive untouched — they are re-injected into the
 * system prompt each turn, which is what makes compaction safe.
 */
export async function compact(
  client: LlmClient,
  history: ChatMessage[],
): Promise<ChatMessage[]> {
  if (history.length <= KEEP_RECENT) return history;
  // never split a tool-result off from its assistant tool-call message
  let cut = history.length - KEEP_RECENT;
  while (cut < history.length && history[cut]!.role === "tool") cut++;
  const older = history.slice(0, cut);
  const recent = history.slice(cut);

  const transcript = older
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const calls =
        "tool_calls" in m && m.tool_calls
          ? m.tool_calls
              .flatMap((tc) =>
                tc.type === "function"
                  ? [`\n[called ${tc.function.name}(${tc.function.arguments.slice(0, 300)})]`]
                  : [],
              )
              .join("")
          : "";
      return `${m.role}: ${content.slice(0, 2000)}${calls}`;
    })
    .join("\n\n");

  const summary = await client.oneShot(COMPACT_SYSTEM, transcript, 2048);
  return [
    {
      role: "user",
      content: `[Conversation so far was compacted. Briefing:]\n${summary}`,
    },
    ...recent,
  ];
}
