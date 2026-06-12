import { z } from "zod";
import type { ToolDef } from "../types";

const schema = z.object({
  question: z.string().describe("One short, concrete question for the user."),
  options: z.array(z.string()).max(4).optional().describe("Optional 2-4 answer choices; the user can always type a free-form answer."),
});

export const askUserTool: ToolDef = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question and wait for their answer. Use BEFORE starting work when requirements are ambiguous or you lack domain knowledge. Ask one question per call, max 3 per task.",
  kind: "read",
  schema,
  describeCall: (args) => `ask_user(${String(args["question"] ?? "").slice(0, 60)})`,
  execute: async (args, ctx) => {
    const { question, options } = schema.parse(args);
    const answer = await ctx.askUser(question, options);
    return `User answered: ${answer}`;
  },
};
