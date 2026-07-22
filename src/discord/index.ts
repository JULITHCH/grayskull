#!/usr/bin/env bun
import { GLOBAL_DIR } from "../config/paths";
import { loadSettings } from "../config/settings";
import { DiscordBot } from "./bot";

const USAGE = `grayskull-discord — GRAYSKULL as a real Discord bot

usage: grayskull-discord [--dir <botDir>]

The bot answers when @mentioned, replied to, DM'd, or called by name
("grayskull …"), reading the recent channel history for context and
web-searching factual questions. It is sandboxed to its bot directory
(default ~/.config/grayskull/discord-bot) — no other local files.

setup:
  1. https://discord.com/developers/applications → New Application → Bot
  2. Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT
  3. Bot → Reset Token → paste it in grayskull-web (⚙ → DISCORD), or
     export DISCORD_BOT_TOKEN="<token>"
  4. OAuth2 → URL Generator → scope "bot", permissions: View Channels,
     Send Messages, Read Message History → open the URL, invite the bot
  5. grayskull-discord

options:
  --dir <d>   bot directory (sandbox root); also settings discord.dir
  -h, --help  this help`;

const argv = process.argv.slice(2);
let dir: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--dir") {
    dir = argv[++i];
    if (!dir) {
      console.error("--dir needs a path");
      process.exit(1);
    }
  } else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option "${a}"\n\n${USAGE}`);
    process.exit(1);
  }
}

let settings: ReturnType<typeof loadSettings>;
try {
  settings = loadSettings(GLOBAL_DIR);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
// settings token (set via the web GUI's DISCORD settings tab) wins over env
const tokenEnv = settings.discord.tokenEnv;
const token = settings.discord.token?.trim() || process.env[tokenEnv];
if (!token) {
  console.error(`no bot token — set one in the grayskull-web settings (⚙ → DISCORD) or export $${tokenEnv}\n\n${USAGE}`);
  process.exit(1);
}

console.log(`
  ____ ____      _ __   ______  _  ___   _ _     _
 / ___|  _ \\    / \\\\ \\ / / ___|| |/ / | | | |   | |
| |  _| |_) |  / _ \\\\ V /\\___ \\| ' /| | | | |   | |
| |_| |  _ <  / ___ \\| |  ___) | . \\| |_| | |___| |___
 \\____|_| \\_\\/_/   \\_\\_| |____/|_|\\_\\\\___/|_____|_____|

  DISCORD · BY THE POWER OF GRAYSKULL
`);

const bot = new DiscordBot(token, { dir }, (text) => console.log(text));
await bot.start();

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log("\nshutting down…");
    void bot.stop().then(() => process.exit(0));
  });
}
