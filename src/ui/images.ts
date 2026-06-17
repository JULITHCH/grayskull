import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Read an image file into a base64 data URL, or null if missing/unsupported. */
export function fileToDataUrl(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const mime = MIME[extname(path).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Grab an image off the clipboard (Wayland then X11) as a data URL, or null.
 *  Needs a graphical session + wl-clipboard/xclip; degrades to null in a tty. */
export function clipboardImageDataUrl(): string | null {
  const tries: Array<[string, string[]]> = [
    ["wl-paste", ["-t", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0 && r.stdout && r.stdout.length > 8) {
        return `data:image/png;base64,${r.stdout.toString("base64")}`;
      }
    } catch {
      // tool missing or no clipboard — try next
    }
  }
  return null;
}

/**
 * Pull image attachments out of a prompt and return the cleaned text + data
 * URLs. Recognizes image file paths (bare or @-prefixed, e.g. from the @ picker)
 * and the literal token `@clipboard`. Each attached image is replaced in the
 * text by a `[image #N]` marker so the model knows one is present.
 */
export function extractImages(text: string, cwd: string): { text: string; images: string[] } {
  const images: string[] = [];

  let out = text.replace(/(^|\s)@clipboard\b/gi, (m, pre: string) => {
    const url = clipboardImageDataUrl();
    if (!url) return m;
    images.push(url);
    return `${pre}[image #${images.length} (clipboard)]`;
  });

  out = out.replace(/@?((?:~|\.{0,2}\/)?[\w./~-]+\.(?:png|jpe?g|gif|webp|bmp))/gi, (m, p: string) => {
    const path = resolve(cwd, p.replace(/^~/, process.env["HOME"] ?? "~"));
    const url = fileToDataUrl(path);
    if (!url) return m;
    images.push(url);
    return `[image #${images.length}: ${p}]`;
  });

  return { text: out, images };
}
