import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ToolDef } from "../types";

const schema = z.object({
  path: z.string().describe("Path to the finished file to offer, absolute or relative to the project directory."),
  label: z.string().optional().describe("Optional display name for the download button (defaults to the file name)."),
});

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Explicit hand-off: the agent calls this once a generated artifact (PDF,
 *  CSV, zip, image, …) is written to disk to surface a download button in the
 *  web UI. Read-only w.r.t. the tool contract — it just points at an existing
 *  file; the web layer (session.ts) tokenises the path so /dl can serve it. */
export const offerDownloadTool: ToolDef = {
  name: "offer_download",
  description:
    "Offer an already-written file to the user as a download (button in the web UI). " +
    "Call this after you have created a deliverable such as a PDF, CSV, spreadsheet, image or archive. " +
    "The file must already exist on disk; this does not create it.",
  kind: "read",
  schema,
  describeCall: (args) => `offer_download(${basename(String(args["path"] ?? ""))})`,
  execute: async (args, ctx) => {
    const { path, label } = schema.parse(args);
    const full = resolve(ctx.cwd, path);
    if (!existsSync(full)) return `error: file not found: ${full} — write the file before offering it for download.`;
    const st = statSync(full);
    if (!st.isFile()) return `error: not a regular file: ${full}`;
    const name = (label && label.trim()) || basename(full);
    return {
      text: `Offered "${name}" (${human(st.size)}) for download.`,
      download: { path: full, name, size: st.size },
    };
  },
};
