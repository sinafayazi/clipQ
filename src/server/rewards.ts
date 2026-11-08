import type { ChannelInfo } from "../shared/types.js";
import type { KickBot } from "./kick/bot.js";
import type { QueueService } from "./queue/service.js";

// Kick channel point rewards: song to the top, and timing a viewer out on Kick or lifting it.
// The streamer names each reward in Settings; a redemption whose title matches one (any case) runs it.

/** Names remembered per channel (to find a viewer's id from what the redeemer typed). */
const MAX_CHATTERS = 5000;
const NAME = /^[a-z0-9_-]{1,25}$/i;
/** Kick's longest timeout, in minutes (7 days). */
const MAX_TIMEOUT = 10080;

type Log = { info: (o: object, m: string) => void };

export interface Redemption {
  title: string;
  userId: number;
  username: string;
  input: string;
}

export function channelRewards(deps: {
  queues: Pick<QueueService, "settings" | "prioritizeSong" | "isKickMod" | "editors">;
  bot: Pick<KickBot, "say" | "timeout" | "untimeout" | "userId">;
  log: Log;
  superUsers: ReadonlySet<string>;
}) {
  const { queues, bot, log, superUsers } = deps;
  /** channel -> lowercase name -> Kick user id, from chat. */
  const chatters = new Map<number, Map<string, number>>();
  /**
   * channel -> user id -> when their ban ends (ms), null for good. From Kick's chat, so it only knows
   * bans since clipQ started; the untimeout reward does nothing for anyone not in here.
   */
  const bans = new Map<number, Map<number, number | null>>();

  const of = <K, V>(map: Map<number, Map<K, V>>, channelId: number) => {
    let m = map.get(channelId);
    if (!m) map.set(channelId, (m = new Map()));
    return m;
  };

  async function findUser(channelId: number, name: string): Promise<number | null> {
    return chatters.get(channelId)?.get(name.toLowerCase()) ?? (await bot.userId(channelId, name));
  }

  /** Mods, the streamer and the people they trust can't be timed out by viewers. */
  function protectedUser(channel: ChannelInfo, userId: number, name: string): boolean {
    const lower = name.toLowerCase();
    return (
      userId === channel.id ||
      lower === channel.slug.toLowerCase() ||
      superUsers.has(lower) ||
      queues.isKickMod(channel.id, userId) ||
      queues.editors(channel.id).includes(lower)
    );
  }

  /** Minutes left of an active timeout, or null when there's none clipQ knows of (or it's a permanent ban). */
  function minutesLeft(channelId: number, userId: number): number | null {
    const until = bans.get(channelId)?.get(userId);
    if (until === null || until === undefined || until <= Date.now()) return null;
    return Math.ceil((until - Date.now()) / 60_000);
  }

  /**
   * Sets a viewer's timeout to `minutes` from now. An active one is lifted first, so Kick takes the
   * new length whether or not it would change an existing timeout in place.
   */
  async function retime(channelId: number, userId: number, minutes: number, reason: string, active: boolean) {
    if (active) await bot.untimeout(channelId, userId); // if this fails, the timeout below says why
    const error = await bot.timeout(channelId, userId, minutes, reason);
    if (!error) banned(channelId, userId, Date.now() + minutes * 60_000);
    return error;
  }

  async function timeout(channel: ChannelInfo, r: Redemption, name: string, minutes: number) {
    const target = await findUser(channel.id, name);
    if (target === null) return `@${r.username} I can't find "${name}" on Kick.`;
    if (protectedUser(channel, target, name)) return `@${r.username} @${name} can't be timed out.`;
    if (bans.get(channel.id)?.get(target) === null) return `@${r.username} @${name} is already banned.`;
    // Redeemed again on someone already timed out: the time adds up (Kick's longest is 7 days).
    const left = minutesLeft(channel.id, target);
    const total = Math.min(MAX_TIMEOUT, (left ?? 0) + minutes);
    const error = await retime(channel.id, target, total, `Channel points, redeemed by ${r.username}`, left !== null);
    log.info({ channel: channel.slug, by: r.username, target: name, minutes, total, error }, "timeout reward redeemed");
    if (error) return `@${r.username} ${error}`;
    return left === null
      ? `@${name} is timed out for ${duration(total)} (redeemed by @${r.username}).`
      : `@${name}'s timeout is ${duration(total - left)} longer: ${duration(total)} left (redeemed by @${r.username}).`;
  }

  async function untimeout(channel: ChannelInfo, r: Redemption, name: string, minutes: number) {
    const target = await findUser(channel.id, name);
    if (target === null) return `@${r.username} I can't find "${name}" on Kick.`;
    // Never touches a permanent ban, or one clipQ didn't see (it could be permanent).
    if (bans.get(channel.id)?.get(target) === null) return `@${r.username} @${name} is banned, not timed out. Only a mod can lift that.`;
    const left = minutesLeft(channel.id, target);
    if (left === null) return `@${r.username} @${name} isn't timed out.`;
    // Each redemption takes off the reward's minutes; the last bit lifts it.
    if (left > minutes) {
      const error = await retime(channel.id, target, left - minutes, `Channel points, shortened by ${r.username}`, true);
      log.info({ channel: channel.slug, by: r.username, target: name, minutes, left: left - minutes, error }, "untimeout reward redeemed");
      if (error) return `@${r.username} ${error}`;
      return `@${name}'s timeout is ${duration(minutes)} shorter: ${duration(left - minutes)} left (redeemed by @${r.username}).`;
    }
    const error = await bot.untimeout(channel.id, target);
    log.info({ channel: channel.slug, by: r.username, target: name, error }, "untimeout reward redeemed");
    if (error) return `@${r.username} ${error}`;
    unbanned(channel.id, target);
    return `@${name}'s timeout is lifted (redeemed by @${r.username}).`;
  }

  function banned(channelId: number, userId: number, until: number | null) {
    of(bans, channelId).set(userId, until);
  }

  function unbanned(channelId: number, userId: number) {
    bans.get(channelId)?.delete(userId);
  }

  return {
    /** Every chat message: remembers who's who, so a redeemer can name someone. */
    sawChatter(channelId: number, userId: number, username: string) {
      const m = of(chatters, channelId);
      const key = username.toLowerCase();
      m.delete(key);
      m.set(key, userId);
      if (m.size > MAX_CHATTERS) m.delete(m.keys().next().value!);
    },
    banned,
    unbanned,

    /** Runs the reward this redemption matches, if any. Returns what the bot said (for tests), or null. */
    async redeemed(channel: ChannelInfo, r: Redemption): Promise<string | null> {
      const s = queues.settings(channel.id).rewards;
      const title = r.title.trim().toLowerCase();
      const is = (name: string) => name.trim() !== "" && name.trim().toLowerCase() === title;

      let reply: string | null = null;
      if (is(s.songToTop)) {
        const song = queues.prioritizeSong(channel.id, r.userId);
        log.info({ channel: channel.slug, user: r.username, reward: r.title, moved: song?.id ?? null }, "priority reward redeemed");
        reply = song
          ? `@${r.username} "${song.title ?? "your song"}" is next up.`
          : `@${r.username} you have no song waiting. Request one with !sr first, then redeem it.`;
      } else if (is(s.timeout) || is(s.untimeout)) {
        const name = r.input.trim().split(/\s+/)[0]?.replace(/^@/, "") ?? "";
        if (!NAME.test(name)) reply = `@${r.username} type the viewer's name when you redeem "${r.title}".`;
        else if (is(s.timeout)) reply = await timeout(channel, r, name, s.timeoutMinutes);
        else reply = await untimeout(channel, r, name, s.timeoutMinutes);
      }
      if (reply) void bot.say(channel.id, reply);
      return reply;
    },
  };
}

/** 5 -> "5 minutes", 60 -> "1 hour", 1440 -> "1 day". */
export function duration(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}
