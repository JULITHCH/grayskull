import { randomBytes } from "node:crypto";

/** API-key minting, in its own module so the settings layer (TUI included) can
 *  generate keys without pulling in the whole HTTP/agent stack. */

/** `gsk-` + 40 hex characters. */
export function generateApiKey(): string {
  return `gsk-${randomBytes(20).toString("hex")}`;
}

export function newApiKeyId(): string {
  return `k${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}
