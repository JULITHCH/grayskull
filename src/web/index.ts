#!/usr/bin/env bun
import { startWebServer } from "./server";

const port = Number(process.env["GRAYSKULL_WEB_PORT"] ?? process.argv[2] ?? 4242);
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
