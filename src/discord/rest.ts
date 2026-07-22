/** Thin Discord REST v10 helpers — only what the bot needs. Retries 429s. */

const API = "https://discord.com/api/v10";
const MAX_RETRIES = 4;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: DiscordUser;
  timestamp?: string;
  mentions?: DiscordUser[];
  referenced_message?: DiscordMessage | null;
  attachments?: { filename: string; url: string }[];
}

export interface FileUpload {
  name: string;
  data: Uint8Array;
}

export class DiscordRest {
  constructor(private token: string) {}

  private async call(method: string, path: string, body?: unknown, files?: FileUpload[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      // with files: multipart/form-data (payload_json + files[n]), else JSON
      let payload: FormData | string | undefined;
      const headers: Record<string, string> = {
        Authorization: `Bot ${this.token}`,
        "User-Agent": "DiscordBot (grayskull, 0.1)",
      };
      if (files?.length) {
        const form = new FormData();
        form.set("payload_json", JSON.stringify(body ?? {}));
        files.forEach((f, i) => form.set(`files[${i}]`, new Blob([f.data.buffer as ArrayBuffer]), f.name));
        payload = form; // fetch sets the multipart boundary header itself
      } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((r) => setTimeout(r, ((data.retry_after ?? 1) + 0.1) * 1000));
        continue;
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`discord ${method} ${path} → ${res.status}: ${text}`);
      }
      return res.status === 204 ? null : await res.json();
    }
  }

  /** Newest-first, like the API returns them. */
  async recentMessages(channelId: string, limit: number): Promise<DiscordMessage[]> {
    return (await this.call("GET", `/channels/${channelId}/messages?limit=${limit}`)) as DiscordMessage[];
  }

  /** Send `content`, optionally as a reply and/or with file attachments. Mass
   *  mentions are never rendered (allowed_mentions), so the model can't
   *  accidentally ping @everyone. */
  async createMessage(channelId: string, content: string, replyToId?: string, files?: FileUpload[]): Promise<void> {
    await this.call(
      "POST",
      `/channels/${channelId}/messages`,
      {
        content,
        allowed_mentions: { parse: ["users"], replied_user: true },
        ...(replyToId ? { message_reference: { message_id: replyToId, fail_if_not_exists: false } } : {}),
      },
      files,
    );
  }

  /** "grayskull is typing…" — lasts ~10s, re-trigger while working. */
  async triggerTyping(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }
}
