#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { startWebServer } from "./server";
import { GLOBAL_SETTINGS } from "../config/paths";
import { ensureDirs } from "../config/paths";

/** Patch web.passwordHash in the raw global settings.json (never dump merged
 *  settings — that would bake defaults into the user's file). */
function patchWebPassword(hash: string | undefined): void {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(GLOBAL_SETTINGS)) raw = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf8"));
  } catch {
    raw = {};
  }
  const web = (raw["web"] ??= {}) as Record<string, unknown>;
  if (hash === undefined) delete web["passwordHash"];
  else web["passwordHash"] = hash;
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify(raw, null, 2) + "\n");
}

const argv = process.argv.slice(2);
if (argv[0] === "--set-password") {
  ensureDirs(process.cwd());
  let pw = argv[1] ?? "";
  if (!pw && !process.stdin.isTTY) pw = (await Bun.stdin.text()).trim();
  if (!pw) {
    console.error('usage: grayskull-web --set-password "<password>"   (or pipe it on stdin)');
    process.exit(1);
  }
  patchWebPassword(await Bun.password.hash(pw));
  console.log(`✓ web login password set (argon2id hash in ${GLOBAL_SETTINGS}) — restart grayskull-web`);
  process.exit(0);
}
if (argv[0] === "--clear-password") {
  patchWebPassword(undefined);
  console.log("✓ web login disabled — restart grayskull-web (do NOT expose the port like this)");
  process.exit(0);
}

const port = Number(process.env["GRAYSKULL_WEB_PORT"] ?? argv[0] ?? 4242);
const server = startWebServer({
  port,
  hostname: "0.0.0.0",
  defaultCwd: process.cwd(),
});

console.log(`
  ____ ____      _ __   ______  _  ___   _ _     _
 / ___|  _ \\    / \\\\ \\ / / ___|| |/ / | | | |   | |
| |  _| |_) |  / _ \\\\ V /\\___ \\| ' /| | | | |   | |
| |_| |  _ <  / ___ \\| |  ___) | . \\| |_| | |___| |___
 \\____|_| \\_\\/_/   \\_\\_| |____/|_|\\_\\\\___/|_____|_____|

  WEB · BY THE POWER OF GRAYSKULL
  serving on http://${server.hostname}:${server.port}  (ctrl+c to stop)
`);
