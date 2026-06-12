import { z } from "zod";
import type { ToolDef } from "../types";
import { loadSkills, skillInvocation } from "./registry";

const schema = z.object({
  name: z.string().describe("Skill name from the 'Available skills' list."),
  args: z.string().optional().describe("Optional arguments/context for the skill."),
});

export function skillTool(cwd: string): ToolDef {
  return {
    name: "skill",
    description:
      "Load a skill's instructions. When the user's request matches an available skill, call this FIRST and then follow the returned instructions.",
    kind: "read",
    schema,
    describeCall: (args) => `skill(${String(args["name"] ?? "")})`,
    execute: async (args) => {
      const { name, args: skillArgs } = schema.parse(args);
      const skill = loadSkills(cwd).find((s) => s.name === name);
      if (!skill) {
        const names = loadSkills(cwd).map((s) => s.name).join(", ") || "(none)";
        return `error: no skill named "${name}". Available skills: ${names}`;
      }
      return skillInvocation(skill, skillArgs ?? "");
    },
  };
}
