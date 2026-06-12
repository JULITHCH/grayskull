import { Marked } from "marked";
// @ts-expect-error marked-terminal ships no types for the named export we use
import { markedTerminal } from "marked-terminal";

const renderer = new Marked();
renderer.use(markedTerminal({ reflowText: false, tab: 2 }));

export function renderMarkdown(text: string): string {
  try {
    return (renderer.parse(text) as string).trimEnd();
  } catch {
    return text;
  }
}
