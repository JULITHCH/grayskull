import { z } from "zod";
import type { ToolDef } from "../types";

export interface TodoItem {
  text: string;
  done: boolean;
}

const schema = z.object({
  items: z
    .array(z.object({ text: z.string(), done: z.boolean() }))
    .describe("The COMPLETE task list (it replaces the previous one). Mark finished items done:true."),
});

/** Factory so each web session gets its own todo state (the TUI uses the
 *  shared default below). */
export function makeTodoTool(): { tool: ToolDef; state: { items: TodoItem[] } } {
  const state: { items: TodoItem[] } = { items: [] };
  const tool: ToolDef = {
    name: "todo",
    description:
      "Maintain your task list for multi-step work. Call it when you start a task (plan the steps) and after finishing each step. Always send the full list.",
    kind: "read",
    schema,
    describeCall: (args) => {
      const items = (args["items"] as TodoItem[] | undefined) ?? [];
      return `todo(${items.filter((i) => i.done).length}/${items.length} done)`;
    },
    execute: async (args) => {
      const { items } = schema.parse(args);
      state.items = items;
      return items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.text}`).join("\n") || "(empty)";
    },
  };
  return { tool, state };
}

const defaultTodo = makeTodoTool();
/** Session-scoped task list; keeps a mid-size model on track across turns. */
export const todoState = defaultTodo.state;
export const todoTool = defaultTodo.tool;
