import type { FastifyBaseLogger } from "fastify";
import type { ChannelInfo, QueueItem, SongSettings } from "../../shared/types.js";
import type { KickBot } from "../kick/bot.js";
import type { ChatMessage } from "../kick/chat.js";
import type { QueueService, RejectReason } from "../queue/service.js";
import { parseSongQuery } from "./resolve.js";

// Song request chat commands. Anyone:
//   !sr <YouTube/Spotify link or song name>   request a song
//   !song                                      what's playing
//   !mysong                                    your next song and when it plays
//   !wrongsong                                 remove your last request
//   !songs                                     how many are waiting, and the song page link
//   !voteskip                                  vote to skip the playing song
//   !volume                                    the song volume
// Broadcaster and moderators: !songs open|close|skip|prev|clear, !songs remove <user>,
//   !volume <0-100> (or +10 / -10).

/** Info commands (!song, !songs) answer at most this often per channel. */
const INFO_COOLDOWN_MS = 10_000;
/** !mysong answers each viewer at most this often. */
const MYSONG_COOLDOWN_MS = 15_000;

const REJECT_TEXT: Partial<Record<RejectReason, string>> = {
  closed: "song requests are closed right now.",
  not_allowed: "you can't request songs here.",
  full: "the song queue is full, try again later.",
  duplicate: "that song is already in the queue.",
  not_found: "I couldn't find that song.",
  unplayable: "that video can't be played outside YouTube. Try another one.",
  live: "live streams can't be requested.",
};

/** Why a song request was turned down, in words for the viewer. Null: say nothing (banned, deleted). */
export function rejectText(reason: RejectReason, s: SongSettings): string | null {
  if (reason === "too_long") return `songs can be up to ${clock(s.maxDuration)} long.`;
  if (reason === "user_limit") {
    return `you already have ${s.perUserLimit} song${s.perUserLimit === 1 ? "" : "s"} waiting. Type !wrongsong to remove your last one.`;
  }
  return REJECT_TEXT[reason] ?? null;
}

/** "3:34" or "1:02:03". */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "plays now", "plays in about 7 min". */
export function eta(startsIn: number | null): string {
  if (startsIn === null) return "";
  if (startsIn < 45) return "plays next";
  return `plays in about ${Math.max(1, Math.round(startsIn / 60))} min`;
}

function title(item: QueueItem): string {
  const t = item.title?.trim() || "that song";
  return `"${t.length > 70 ? `${t.slice(0, 69)}…` : t}"`;
}

interface Deps {
  queues: QueueService;
  bot: KickBot;
  log: FastifyBaseLogger;
  publicUrl: string;
  /** `!voteskip`: counted and answered by the bridge, like `!vs` for clips. */
  vote: (channelId: number, msg: ChatMessage) => void;
}

export function songCommands({ queues, bot, log, publicUrl, vote }: Deps) {
  const lastInfo = new Map<string, number>();
  const cooled = (key: string, ms: number) => {
    const now = Date.now();
    if (now - (lastInfo.get(key) ?? 0) < ms) return false;
    lastInfo.set(key, now);
    if (lastInfo.size > 5000) lastInfo.clear();
    return true;
  };
  const songPage = (c: ChannelInfo) => `${publicUrl}/s/${c.slug}`;

  async function request(channel: ChannelInfo, msg: ChatMessage, rest: string) {
    const at = `@${msg.sender.username}`;
    const query = parseSongQuery(rest);
    if (!query) {
      void bot.say(channel.id, `${at} type !sr and a YouTube or Spotify link, or the song's name.`);
      return;
    }
    const requester = { id: msg.sender.id, username: msg.sender.username, color: msg.sender.color };
    let result;
    try {
      result = await queues.requestSong(channel.id, query, requester, msg.id, msg.sender.badges);
    } catch (err) {
      log.warn({ err, channel: channel.slug }, "song lookup failed");
      void bot.say(channel.id, `${at} I couldn't look that up right now, try again in a moment.`);
      return;
    }
    if (!result.ok) {
      const text = rejectText(result.reason, queues.settings(channel.id).songs);
      // Banned viewers and deleted messages get no answer.
      if (text) void bot.say(channel.id, `${at} ${text}`);
      log.debug({ channel: channel.slug, user: requester.username, reason: result.reason }, "song rejected");
      return;
    }
    const item = result.item;
    log.info({ channel: channel.slug, user: requester.username, song: item.clipId }, "song queued");
    if (item.status === "playing") {
      void bot.say(channel.id, `${at} ${title(item)} is playing now.`);
      return;
    }
    const tl = queues.songTimeline(channel.id);
    const i = tl.queue.findIndex((q) => q.item.id === item.id);
    const when = i >= 0 ? eta(tl.queue[i]!.startsIn) : "";
    const length = item.duration !== null ? ` (${clock(item.duration)})` : "";
    void bot.say(channel.id, `${at} added ${title(item)}${length} at #${i + 1}${when ? `, ${when}` : ""}.`);
  }

  function nowPlaying(channel: ChannelInfo) {
    if (!cooled(`${channel.id}:song`, INFO_COOLDOWN_MS)) return;
    const tl = queues.songTimeline(channel.id);
    const c = tl.current;
    if (!c) {
      void bot.say(channel.id, "No song is playing. Request one with !sr and a link or the song's name.");
      return;
    }
    const left = tl.left !== null && c.duration !== null ? `, ${clock(tl.left)} left` : "";
    // No video link: clipQ reads chat for clip links and would queue the bot's own message.
    void bot.say(channel.id, `Now playing: ${title(c)}, requested by @${c.requestedBy.username}${left}.`);
  }

  function mySong(channel: ChannelInfo, msg: ChatMessage) {
    if (!cooled(`${channel.id}:me:${msg.sender.id}`, MYSONG_COOLDOWN_MS)) return;
    const at = `@${msg.sender.username}`;
    const tl = queues.songTimeline(channel.id);
    if (tl.current?.requestedBy.id === msg.sender.id) {
      void bot.say(channel.id, `${at} your song ${title(tl.current)} is playing now.`);
      return;
    }
    const mine = tl.queue.map((q, i) => ({ ...q, pos: i + 1 })).filter((q) => q.item.requestedBy.id === msg.sender.id);
    const first = mine[0];
    if (!first) {
      void bot.say(channel.id, `${at} you have no songs waiting. Request one with !sr.`);
      return;
    }
    const when = eta(first.startsIn);
    const more = mine.length > 1 ? ` You have ${mine.length - 1} more after it.` : "";
    void bot.say(channel.id, `${at} ${title(first.item)} is #${first.pos}${when ? `, ${when}` : ""}.${more}`);
  }

  function wrongSong(channel: ChannelInfo, msg: ChatMessage) {
    const removed = queues.wrongSong(channel.id, msg.sender.id);
    const at = `@${msg.sender.username}`;
    void bot.say(channel.id, removed ? `${at} removed ${title(removed)}.` : `${at} you have no songs waiting.`);
  }

  function songList(channel: ChannelInfo) {
    if (!cooled(`${channel.id}:songs`, INFO_COOLDOWN_MS)) return;
    const tl = queues.songTimeline(channel.id);
    const n = tl.queue.length;
    const total = tl.queue.reduce<number | null>((t, q) => (t === null || q.item.duration === null ? null : t + q.item.duration), 0);
    const open = queues.settings(channel.id).songs.open ? "" : " Requests are closed.";
    const count = n === 0 ? "No songs waiting." : `${n} song${n === 1 ? "" : "s"} waiting${total ? ` (${clock(total)})` : ""}.`;
    void bot.say(channel.id, `${count}${open} See the list and your songs: ${songPage(channel)}`);
  }

  /** `!volume`: anyone sees it; mods set it with a number or a change ("!volume 40", "!volume +10"). */
  function volume(channel: ChannelInfo, msg: ChatMessage, arg: string | undefined) {
    const s = queues.settings(channel.id).songs;
    const canControl = msg.sender.badges.includes("broadcaster") || msg.sender.badges.includes("moderator");
    const m = arg?.match(/^([+-]?)(\d{1,3})%?$/);
    if (!m || !canControl) {
      if (cooled(`${channel.id}:volume`, INFO_COOLDOWN_MS)) void bot.say(channel.id, `Song volume is ${s.volume}%.`);
      return;
    }
    const n = Number(m[2]);
    const next = Math.max(0, Math.min(100, m[1] === "+" ? s.volume + n : m[1] === "-" ? s.volume - n : n));
    queues.updateSettings(channel.id, { songs: { ...s, volume: next } });
    void bot.say(channel.id, `Song volume set to ${next}%.`);
  }

  function modCommand(channel: ChannelInfo, msg: ChatMessage, arg: string, target: string | undefined) {
    const canControl = msg.sender.badges.includes("broadcaster") || msg.sender.badges.includes("moderator");
    if (!canControl) return false;
    const id = channel.id;
    switch (arg) {
      case "open":
      case "close": {
        const s = queues.settings(id).songs;
        queues.updateSettings(id, { songs: { ...s, open: arg === "open" } });
        void bot.say(id, arg === "open" ? "Song requests are open! Type !sr and a link or song name." : "Song requests are closed.");
        return true;
      }
      case "skip":
      case "next":
        queues.next(id, arg === "skip" ? "skipped" : "played", "songs");
        return true;
      case "prev":
        queues.previous(id, "songs");
        return true;
      case "clear":
        queues.clear(id, "songs");
        return true;
      case "remove":
        if (target) queues.removeSongsByName(id, target);
        return true;
    }
    return false;
  }

  /** Handles a song command. Returns false if `text` isn't one. */
  return function handle(channel: ChannelInfo, msg: ChatMessage, text: string): boolean {
    const [cmdRaw = "", ...restParts] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const rest = text.slice(cmdRaw.length).trim();
    switch (cmd) {
      case "!sr":
      case "!songrequest":
        void request(channel, msg, rest);
        return true;
      case "!song":
      case "!np":
        nowPlaying(channel);
        return true;
      case "!mysong":
      case "!when":
        mySong(channel, msg);
        return true;
      case "!wrongsong":
        wrongSong(channel, msg);
        return true;
      case "!voteskip":
        vote(channel.id, msg);
        return true;
      case "!volume":
      case "!vol":
        volume(channel, msg, restParts[0]);
        return true;
      case "!songs": {
        const [arg, target] = restParts.map((p) => p.toLowerCase());
        if (arg && modCommand(channel, msg, arg, target)) return true;
        songList(channel);
        return true;
      }
    }
    return false;
  };
}
