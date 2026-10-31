import type { FastifyBaseLogger } from "fastify";
import type { Provider, QueueItem, QueueKind } from "../shared/types.js";
import { findClips } from "./clips/parse.js";
import type { KickBot } from "./kick/bot.js";
import type { ChatMessage, KickChat } from "./kick/chat.js";
import { MAX_TIMEOUT_MS, type QueueService } from "./queue/service.js";
import { songCommands } from "./songs/commands.js";

/** Most links taken from one message; the per-user limit usually cuts it lower. */
const MAX_LINKS_PER_MESSAGE = 5;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Votes arriving within this window get one reply with the latest count, not one reply each. */
const VOTE_REPLY_DELAY_MS = 2500;
/** `!cq commands` answers at most this often per channel, so viewers can't make the bot spam. */
const HELP_COOLDOWN_MS = 30_000;

/** The command list the bot posts for `!cq commands`. */
export function commandsText(voteSkip: number): string {
  const vote = voteSkip > 0 ? `!vs votes to skip the clip (${voteSkip} votes).` : "";
  return (
    `clipQ: post a clip link to queue it. ${vote} ` +
    `Songs: !sr <link or name>, !song, !mysong, !wrongsong, !songs, !voteskip. ` +
    `Mods: !cq open/close/next/skip/prev/clear, !cq ban/unban <user>, !cq timeout <user> [10m], !songs open/close/skip/clear, !songs remove <user>, !volume <0-100>.`
  ).replace(/\s+/g, " ");
}

const PROVIDER_NAME: Record<Provider, string> = {
  kick: "Kick",
  youtube: "YouTube",
  twitch: "Twitch",
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X",
  streamable: "Streamable",
};

function shortTitle(item: QueueItem): string {
  const t = item.title?.trim();
  if (!t) return item.queue === "songs" ? "the song" : `the ${PROVIDER_NAME[item.provider]} clip`;
  return `"${t.length > 60 ? `${t.slice(0, 59)}…` : t}"`;
}

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
export function bridgeChat(
  chat: KickChat,
  queues: QueueService,
  bot: KickBot,
  log: FastifyBaseLogger,
  publicUrl: string,
  superUsers: ReadonlySet<string> = new Set(),
) {
  const voteReply = new Map<string, { timer: NodeJS.Timeout; text: string }>();
  const lastHelp = new Map<number, number>();
  const songs = songCommands({ queues, bot, log, publicUrl, vote: (id, msg) => vote(id, msg, "songs") });

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

  async function onMessage(raw: ChatMessage) {
    const channel = queues.channelByChatroom(raw.chatroomId);
    if (!channel) return;
    // Super users act as the broadcaster everywhere, so every permission check lets them through.
    const msg = superUsers.has(raw.sender.username.toLowerCase())
      ? { ...raw, sender: { ...raw.sender, badges: [...raw.sender.badges, "broadcaster"] } }
      : raw;

    const text = msg.content.trim();
    if (text.startsWith("!")) {
      if (!songs(channel, msg, text)) runCommand(channel.id, msg, text);
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

  /** `!vs` (clips) or `!voteskip` (songs): one vote to skip what's playing. The bot answers with the count. */
  function vote(channelId: number, msg: ChatMessage, kind: QueueKind = "clips") {
    const r = queues.voteSkip(channelId, msg.sender.id, kind);
    if (!("item" in r) || r.status === "already_voted") return;
    const key = `${channelId}:${kind}`;
    const pending = voteReply.get(key);
    if (r.status === "skipped") {
      if (pending) clearTimeout(pending.timer);
      voteReply.delete(key);
      void bot.say(channelId, `Skipped ${shortTitle(r.item)} by vote (${r.votes}/${r.needed}).`);
      return;
    }
    const command = kind === "songs" ? "!voteskip" : "!vs";
    const text = `Vote skip for ${shortTitle(r.item)}: ${r.votes}/${r.needed}. Type ${command} to vote.`;
    if (pending) {
      pending.text = text;
      return;
    }
    const timer = setTimeout(() => {
      const reply = voteReply.get(key);
      voteReply.delete(key);
      // It may have changed while we waited; don't post a count for something that's gone.
      const s = queues.state(channelId, false);
      const now = kind === "songs" ? s.songs.current : s.current;
      if (reply && now?.id === r.item.id) void bot.say(channelId, reply.text);
    }, VOTE_REPLY_DELAY_MS);
    voteReply.set(key, { timer, text });
  }

  /**
   * Anyone: `!vs`, `!cq commands` (or `!cq help`).
   * Broadcaster and moderators: `!cq open|close|next|skip|prev|clear`, `!cq ban <user>`,
   * `!cq timeout <user> [10m]`, `!cq unban <user>`.
   */
  function runCommand(channelId: number, msg: ChatMessage, text: string) {
    const [cmd, arg, target, duration] = text.toLowerCase().split(/\s+/);
    if (cmd === "!vs") return vote(channelId, msg);
    if (cmd !== "!cq" && cmd !== "!clipq") return;

    if (arg === "commands" || arg === "help" || arg === undefined) {
      const now = Date.now();
      if (now - (lastHelp.get(channelId) ?? 0) < HELP_COOLDOWN_MS) return;
      lastHelp.set(channelId, now);
      void bot.say(channelId, commandsText(queues.settings(channelId).voteSkip), msg.id);
      return;
    }

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
