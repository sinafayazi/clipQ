import type { FastifyBaseLogger } from "fastify";
import { findClips } from "./clips/parse.js";
import type { ChatMessage, KickChat } from "./kick/chat.js";
import { MAX_TIMEOUT_MS, type QueueService } from "./queue/service.js";

/** Most links taken from one message; the per-user limit usually cuts it lower. */
const MAX_LINKS_PER_MESSAGE = 5;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** "30s", "10m", "2h", "1d", or plain minutes ("15") -> ms. Anything else -> null. */
export function parseDuration(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d+)([smhd]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, "": 60_000 }[m[2] as "s" | "m" | "h" | "d" | ""];
  const ms = n * unit;
  return ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : null;
}

/** Wires Kick chat into the queues: links become requests, mod actions remove them. */
export function bridgeChat(chat: KickChat, queues: QueueService, log: FastifyBaseLogger) {
  chat.on("message", (msg) => {
    onMessage(msg).catch((err) => log.error({ err }, "chat message handling failed"));
  });

  chat.on("deleted", ({ chatroomId, messageId }) => {
    const channel = queues.channelByChatroom(chatroomId);
    if (channel) queues.removeByMessage(channel.id, messageId);
  });

  chat.on("banned", ({ chatroomId, userId }) => {
    const channel = queues.channelByChatroom(chatroomId);
    if (channel) queues.removeByUser(channel.id, userId);
  });

  // Dashboards show the chat connection, so push fresh state to all of them.
  chat.on("status", () => {
    for (const c of queues.channels()) queues.emit("changed", c.id);
  });

  async function onMessage(msg: ChatMessage) {
    const channel = queues.channelByChatroom(msg.chatroomId);
    if (!channel) return;

    const text = msg.content.trim();
    if (text.startsWith("!")) {
      runCommand(channel.id, msg, text);
      return;
    }

    const requester = { id: msg.sender.id, username: msg.sender.username, color: msg.sender.color };
    // In order, one at a time, so the per-user limit sees each previous result.
    for (const ref of findClips(text).slice(0, MAX_LINKS_PER_MESSAGE)) {
      const result = await queues.submit(channel.id, ref, requester, msg.id, msg.sender.badges);
      if (result.ok) log.info({ channel: channel.slug, user: requester.username, clip: `${ref.provider}:${result.item.clipId}` }, "clip queued");
      else log.debug({ channel: channel.slug, user: requester.username, url: ref.url, reason: result.reason }, "clip rejected");
    }
  }

  /**
   * `!cq open|close|next|skip|prev|clear`, `!cq ban <user>`, `!cq timeout <user> [10m]`,
   * `!cq unban <user>`. Broadcaster and moderators only.
   */
  function runCommand(channelId: number, msg: ChatMessage, text: string) {
    const [cmd, arg, target, duration] = text.toLowerCase().split(/\s+/);
    if (cmd !== "!cq" && cmd !== "!clipq") return;
    const canControl = msg.sender.badges.includes("broadcaster") || msg.sender.badges.includes("moderator");
    if (!canControl) return;

    switch (arg) {
      case "ban":
        if (target) queues.ban(channelId, target, null);
        break;
      case "timeout": {
        const ms = duration === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(duration);
        if (target && ms !== null) queues.ban(channelId, target, ms);
        break;
      }
      case "unban":
        if (target) queues.unban(channelId, target);
        break;
      case "open":
        queues.updateSettings(channelId, { open: true });
        break;
      case "close":
        queues.updateSettings(channelId, { open: false });
        break;
      case "next":
        queues.next(channelId, "played");
        break;
      case "skip":
        queues.next(channelId, "skipped");
        break;
      case "prev":
        queues.previous(channelId);
        break;
      case "clear":
        queues.clear(channelId);
        break;
    }
  }
}
