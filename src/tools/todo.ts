import { z } from "zod";
import type { ToolDef } from "../types";

export interface TodoItem {
  text: string;
  done: boolean;
}

/** Session-scoped task list; keeps a mid-size model on track across turns. */
export const todoState: { items: TodoItem[] } = { items: [] };

const schema = z.object({
  items: z
    .array(z.object({ text: z.string(), done: z.boolean() }))
    .describe("The COMPLETE task list (it replaces the previous one). Mark finished items done:true."),
});

export const todoTool: ToolDef = {
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
    todoState.items = items;
    return items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.text}`).join("\n") || "(empty)";
  },
};
