import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/server/db.js";
import { QueueService } from "../src/server/queue/service.js";
import { channelRewards, duration } from "../src/server/rewards.js";
import type { ChannelInfo } from "../src/shared/types.js";

const CH = 100;
const channel: ChannelInfo = { id: CH, slug: "erph", displayName: "Erph", chatroomId: 555 };

let q: QueueService;
let calls: string[];
let said: string[];
let kickError: string | null;
let rewards: ReturnType<typeof channelRewards>;

beforeEach(() => {
  q = new QueueService(openDb(":memory:"), async () => ({ ok: false, reason: "not_found" }) as never);
  q.upsertChannel(channel, CH);
  q.updateSettings(CH, { rewards: { songToTop: "ping", timeout: "Timeout", untimeout: "Untimeout", timeoutMinutes: 10 } });
  calls = [];
  said = [];
  kickError = null;
  rewards = channelRewards({
    queues: q,
    bot: {
      say: async (_c, text) => (said.push(text), true),
      timeout: async (_c, user, minutes) => (calls.push(`timeout ${user} ${minutes}`), kickError),
      untimeout: async (_c, user) => (calls.push(`untimeout ${user}`), kickError),
      // Only "faraway" is found through Kick; everyone else has to have chatted.
      userId: async (_c, name) => (name.toLowerCase() === "faraway" ? 77 : null),
    },
    log: { info: () => {} },
    superUsers: new Set(["siiinfa"]),
  });
  rewards.sawChatter(CH, 5, "Troll");
  rewards.sawChatter(CH, 6, "ModMan");
  q.noteChatRole(CH, 6, "ModMan", true);
});

const redeem = (title: string, input: string) => rewards.redeemed(channel, { title, userId: 1, username: "fan", input });

describe("timeout reward", () => {
  it("times out the named viewer on Kick, matching the reward name in any case", async () => {
    expect(await redeem("TIMEOUT", "@troll please")).toBe("@troll is timed out for 10 minutes (redeemed by @fan).");
    expect(calls).toEqual(["timeout 5 10"]);
    expect(said).toHaveLength(1);
  });

  it("finds viewers who haven't chatted through Kick", async () => {
    await redeem("Timeout", "faraway");
    expect(calls).toEqual(["timeout 77 10"]);
    expect(await redeem("Timeout", "nobody")).toBe('@fan I can\'t find "nobody" on Kick.');
  });

  it("asks for a name when none was typed", async () => {
    expect(await redeem("Timeout", "  ")).toBe('@fan type the viewer\'s name when you redeem "Timeout".');
    expect(await redeem("Timeout", "!!!")).toMatch(/type the viewer's name/);
    expect(calls).toEqual([]);
  });

  it("never times out the streamer, mods, super users or dashboard editors", async () => {
    rewards.sawChatter(CH, 9, "siiinfa");
    rewards.sawChatter(CH, 10, "helper");
    q.addEditor(CH, "helper");
    rewards.sawChatter(CH, CH, "erph");
    for (const name of ["erph", "modman", "siiinfa", "helper"]) {
      expect(await redeem("Timeout", name)).toBe(`@fan @${name} can't be timed out.`);
    }
    expect(calls).toEqual([]);
  });

  it("adds up when redeemed again on someone already timed out", async () => {
    await redeem("Timeout", "troll");
    expect(await redeem("Timeout", "troll")).toBe("@troll's timeout is 10 minutes longer: 20 minutes left (redeemed by @fan).");
    expect(calls).toEqual(["timeout 5 10", "untimeout 5", "timeout 5 20"]);
    rewards.banned(CH, 5, Date.now() + 10079 * 60_000);
    await redeem("Timeout", "troll");
    expect(calls.at(-1)).toBe("timeout 5 10080"); // Kick's 7-day limit
  });

  it("leaves a permanent ban alone", async () => {
    rewards.banned(CH, 5, null);
    expect(await redeem("Timeout", "troll")).toBe("@fan @troll is already banned.");
    expect(calls).toEqual([]);
  });

  it("says why when Kick refuses", async () => {
    kickError = "clipQ can't time people out yet: the streamer has to log in to clipQ again and allow moderation.";
    expect(await redeem("Timeout", "troll")).toBe(`@fan ${kickError}`);
  });

  it("ignores rewards that are turned off or not clipQ's", async () => {
    q.updateSettings(CH, { rewards: { ...q.settings(CH).rewards, timeout: "" } });
    expect(await redeem("Timeout", "troll")).toBeNull();
    expect(await redeem("Hydrate", "troll")).toBeNull();
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe("untimeout reward", () => {
  it("lifts a timeout clipQ saw in chat", async () => {
    rewards.banned(CH, 5, Date.now() + 60_000);
    expect(await redeem("Untimeout", "troll")).toBe("@troll's timeout is lifted (redeemed by @fan).");
    expect(calls).toEqual(["untimeout 5"]);
    // Gone now: a second redemption does nothing on Kick.
    expect(await redeem("Untimeout", "troll")).toBe("@fan @troll isn't timed out.");
    expect(calls).toEqual(["untimeout 5"]);
  });

  it("works on a timeout given by the timeout reward", async () => {
    await redeem("Timeout", "troll");
    await redeem("Untimeout", "troll");
    expect(calls).toEqual(["timeout 5 10", "untimeout 5"]);
  });

  it("takes off the reward's minutes from a longer timeout, and lifts the rest", async () => {
    await redeem("Timeout", "troll");
    await redeem("Timeout", "troll"); // 20 minutes
    calls = [];
    expect(await redeem("Untimeout", "troll")).toBe("@troll's timeout is 10 minutes shorter: 10 minutes left (redeemed by @fan).");
    expect(calls).toEqual(["untimeout 5", "timeout 5 10"]);
    expect(await redeem("Untimeout", "troll")).toBe("@troll's timeout is lifted (redeemed by @fan).");
    expect(await redeem("Untimeout", "troll")).toBe("@fan @troll isn't timed out.");
  });

  it("never lifts a permanent ban, or a ban it can't tell is a timeout", async () => {
    rewards.banned(CH, 5, null);
    expect(await redeem("Untimeout", "troll")).toBe("@fan @troll is banned, not timed out. Only a mod can lift that.");
    expect(await redeem("Untimeout", "faraway")).toBe("@fan @faraway isn't timed out."); // never seen banned
    rewards.banned(CH, 77, Date.now() - 1); // already over
    expect(await redeem("Untimeout", "faraway")).toBe("@fan @faraway isn't timed out.");
    rewards.banned(CH, 77, Date.now() + 60_000);
    rewards.unbanned(CH, 77); // a mod lifted it
    expect(await redeem("Untimeout", "faraway")).toBe("@fan @faraway isn't timed out.");
    expect(calls).toEqual([]);
  });
});

describe("song to the top reward", () => {
  it("still answers when the viewer has no song", async () => {
    expect(await redeem("Ping", "")).toBe("@fan you have no song waiting. Request one with !sr first, then redeem it.");
  });
});

it("writes durations the way people say them", () => {
  expect([1, 5, 60, 90, 120, 1440, 10080].map(duration)).toEqual([
    "1 minute", "5 minutes", "1 hour", "90 minutes", "2 hours", "1 day", "7 days",
  ]);
});
