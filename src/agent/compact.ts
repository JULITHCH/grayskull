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
