import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDef } from "../types";

const MAX_READ_CHARS = 60_000;

const readSchema = z.object({
  path: z.string().describe("File path, absolute or relative to the project directory."),
  offset: z.number().int().min(1).optional().describe("1-based line to start reading from."),
  limit: z.number().int().min(1).optional().describe("Max lines to read (default 800)."),
});

export const readTool: ToolDef = {
  name: "read",
  description: "Read a text file. Returns numbered lines. Use offset/limit for large files.",
  kind: "read",
  schema: readSchema,
  describeCall: (args) => `read(${String(args["path"] ?? "")})`,
  execute: async (args, ctx) => {
    const { path, offset, limit } = readSchema.parse(args);
    const full = resolve(ctx.cwd, path);
    if (!existsSync(full)) return `error: file not found: ${full}`;
    const lines = readFileSync(full, "utf8").split("\n");
    const start = (offset ?? 1) - 1;
    const slice = lines.slice(start, start + (limit ?? 800));
    let text = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    if (text.length > MAX_READ_CHARS) {
      text = text.slice(0, MAX_READ_CHARS) + "\n[truncated — read again with offset/limit]";
    }
    if (start + slice.length < lines.length) {
      text += `\n[${lines.length - start - slice.length} more lines — use offset=${start + slice.length + 1}]`;
    }
    return text || "(empty file)";
  },
};

const writeSchema = z.object({
  path: z.string().describe("File path to create or overwrite."),
  content: z.string().describe("Full file content."),
});

export const writeTool: ToolDef = {
  name: "write",
  description: "Create or overwrite a file with the given content. For small changes to existing files prefer edit.",
  kind: "edit",
  schema: writeSchema,
  describeCall: (args) => `write(${String(args["path"] ?? "")})`,
  previewCall: async (args, cwd) => {
    const { path, content } = writeSchema.parse(args);
    const full = resolve(cwd, path);
    const old = existsSync(full) ? readFileSync(full, "utf8") : "";
    return createTwoFilesPatch(path, path, old, content, "", "", { context: 3 });
  },
  execute: async (args, ctx) => {
    const { path, content } = writeSchema.parse(args);
    const full = resolve(ctx.cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return `wrote ${content.length} chars to ${full}`;
  },
};

const editSchema = z.object({
  path: z.string().describe("File to edit."),
  old_string: z.string().describe("Exact text to replace. Must appear exactly once unless replace_all."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence (default false)."),
});

function applyEdit(cwd: string, args: Record<string, unknown>): { full: string; before: string; after: string } | string {
  const { path, old_string, new_string, replace_all } = editSchema.parse(args);
  const full = resolve(cwd, path);
  if (!existsSync(full)) return `error: file not found: ${full}`;
  const before = readFileSync(full, "utf8");
  if (!before.includes(old_string)) {
    return "error: old_string not found in file. Read the file again and match the text exactly, including whitespace.";
  }
  if (!replace_all) {
    const count = before.split(old_string).length - 1;
    if (count > 1) return `error: old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`;
  }
  const after = replace_all
    ? before.split(old_string).join(new_string)
    : before.replace(old_string, new_string);
  return { full, before, after };
}

export const editTool: ToolDef = {
  name: "edit",
  description: "Replace an exact string in a file. old_string must match the file content exactly (copy it from a read result).",
  kind: "edit",
  schema: editSchema,
  describeCall: (args) => `edit(${String(args["path"] ?? "")})`,
  previewCall: async (args, cwd) => {
    const res = applyEdit(cwd, args);
    if (typeof res === "string") return res;
    const path = String(args["path"]);
    return createTwoFilesPatch(path, path, res.before, res.after, "", "", { context: 3 });
  },
  execute: async (args, ctx) => {
    const res = applyEdit(ctx.cwd, args);
    if (typeof res === "string") return res;
    writeFileSync(res.full, res.after);
    return `edited ${res.full}`;
  },
};
