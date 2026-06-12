import { z } from "zod";
import type { ToolDef } from "../types";
import type { ToolSchema } from "../llm/client";
import { bashTool } from "./bash";
import { readTool, writeTool, editTool } from "./files";
import { grepTool, globTool } from "./search";
import { askUserTool } from "./ask_user";
import { todoTool } from "./todo";

export function builtinTools(): ToolDef[] {
  return [bashTool, readTool, writeTool, editTool, grepTool, globTool, askUserTool, todoTool];
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  unregisterPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) this.tools.delete(name);
    }
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** OpenAI-format schemas, optionally restricted to a subset of names. */
  schemas(only?: string[]): ToolSchema[] {
    return this.list()
      .filter((t) => !only || only.includes(t.name) || only.some((p) => p.endsWith("*") && t.name.startsWith(p.slice(0, -1))))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema ?? toJsonSchema(t.schema!),
      }));
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}
