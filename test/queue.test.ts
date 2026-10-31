import { beforeEach, describe, expect, it } from "vitest";
import type { ClipRef, Requester } from "../src/shared/types.js";
import type { Resolved } from "../src/server/clips/resolve.js";
import { openDb } from "../src/server/db.js";
import { QueueService } from "../src/server/queue/service.js";

const CH = 100;
const alice: Requester = { id: 1, username: "alice", color: null };
const bob: Requester = { id: 2, username: "bob", color: null };
const yt = (id: string): ClipRef => ({ provider: "youtube", id: id.padEnd(11, "x"), url: `https://youtu.be/${id.padEnd(11, "x")}` });

let resolver: (ref: ClipRef) => Promise<Resolved>;
let q: QueueService;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  resolver = async (ref) => ({ ok: true, ref, meta: { title: ref.id, thumbnail: null, author: null, duration: null, mediaUrl: null } });
  q = new QueueService(openDb(":memory:"), (ref) => resolver(ref), () => clock++);
  q.upsertChannel({ id: CH, slug: "erph", displayName: "Erph", chatroomId: 555 }, CH);
  q.updateSettings(CH, { open: true });
});

const ids = () => q.state(CH, true).queue.map((i) => i.clipId.replace(/x+$/, ""));
const current = () => q.state(CH, true).current?.clipId.replace(/x+$/, "") ?? null;

describe("submit rules", () => {
  it("queues in order", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), bob, "m2");
    expect(ids()).toEqual(["a", "b"]);
  });

  it("rejects when closed", async () => {
    q.updateSettings(CH, { open: false });
    expect(await q.submit(CH, yt("a"), alice, "m1")).toEqual({ ok: false, reason: "closed" });
  });

  it("rejects disabled providers", async () => {
    q.updateSettings(CH, { providers: ["kick"] });
    expect(await q.submit(CH, yt("a"), alice, "m1")).toEqual({ ok: false, reason: "provider_disabled" });
  });

  it("rejects a clip already waiting or playing", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    expect(await q.submit(CH, yt("a"), bob, "m2")).toEqual({ ok: false, reason: "duplicate" });
    q.next(CH);
    expect(current()).toBe("a");
    expect(await q.submit(CH, yt("a"), bob, "m3")).toEqual({ ok: false, reason: "duplicate" });
  });

  it("accepts a clip again right after it played or was skipped", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    q.next(CH);
    q.next(CH); // a played
    expect((await q.submit(CH, yt("a"), bob, "m2")).ok).toBe(true);
    q.next(CH);
    q.next(CH, "skipped");
    expect((await q.submit(CH, yt("a"), bob, "m3")).ok).toBe(true);
  });

  it("enforces per-user limit on waiting clips only", async () => {
    q.updateSettings(CH, { perUserLimit: 2 });
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), alice, "m2");
    expect(await q.submit(CH, yt("c"), alice, "m3")).toEqual({ ok: false, reason: "user_limit" });
    expect((await q.submit(CH, yt("c"), bob, "m4")).ok).toBe(true);
    q.next(CH); // alice's "a" is now playing, not waiting
    expect((await q.submit(CH, yt("d"), alice, "m5")).ok).toBe(true);
  });

  it("enforces max size", async () => {
    q.updateSettings(CH, { maxSize: 1, perUserLimit: 0 });
    await q.submit(CH, yt("a"), alice, "m1");
    expect(await q.submit(CH, yt("b"), bob, "m2")).toEqual({ ok: false, reason: "full" });
  });

  it("passes through resolver rejections", async () => {
    resolver = async () => ({ ok: false, reason: "not_found" });
    expect(await q.submit(CH, yt("a"), alice, "m1")).toEqual({ ok: false, reason: "not_found" });
    expect(ids()).toEqual([]);
  });

  it("re-checks rules after the lookup (two viewers, same clip, same moment)", async () => {
    const [r1, r2] = await Promise.all([q.submit(CH, yt("a"), alice, "m1"), q.submit(CH, yt("a"), bob, "m2")]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    expect(ids()).toEqual(["a"]);
  });

  it("keeps chat order when a later link's lookup finishes first", async () => {
    const gates = new Map<string, () => void>();
    const inner = resolver;
    resolver = (ref) => new Promise<void>((r) => gates.set(ref.id[0]!, r)).then(() => inner(ref));
    const slow = q.submit(CH, yt("a"), alice, "m1");
    const fast = q.submit(CH, yt("b"), bob, "m2");
    gates.get("b")!();
    await fast;
    gates.get("a")!();
    await slow;
    expect(ids()).toEqual(["a", "b"]);
  });

  it("keeps chat order across a reorder done while a lookup is in flight", async () => {
    q.updateSettings(CH, { perUserLimit: 0 });
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), alice, "m2");
    q.next(CH); // a playing
    q.next(CH); // b playing
    q.previous(CH); // a playing, b back on top with a lower position
    let release!: () => void;
    const inner = resolver;
    resolver = (ref) => new Promise<void>((r) => (release = r)).then(() => inner(ref));
    const pending = q.submit(CH, yt("c"), bob, "m3");
    q.move(CH, q.state(CH, true).queue[0]!.id, 0);
    release();
    await pending;
    expect(ids()).toEqual(["b", "c"]);
  });

  it("respects closing the queue while a lookup is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = resolver;
    resolver = async (ref) => (await gate, inner(ref));
    const pending = q.submit(CH, yt("a"), alice, "m1");
    q.updateSettings(CH, { open: false });
    release();
    expect(await pending).toEqual({ ok: false, reason: "closed" });
  });

  it("dedupes TikTok short links by their real id after expanding", async () => {
    resolver = async () => ({
      ok: true,
      ref: { provider: "tiktok", id: "7312345678901234567", url: "https://www.tiktok.com/video/7312345678901234567" },
      meta: { title: null, thumbnail: null, author: null, duration: null, mediaUrl: null },
    });
    const short = (code: string): ClipRef => ({ provider: "tiktok", id: code, url: `https://vm.tiktok.com/${code}/`, shortLink: true });
    expect((await q.submit(CH, short("A1"), alice, "m1")).ok).toBe(true);
    expect(await q.submit(CH, short("B2"), bob, "m2")).toEqual({ ok: false, reason: "duplicate" });
  });
});

describe("playback", () => {
  beforeEach(async () => {
    q.updateSettings(CH, { perUserLimit: 0 });
    for (const [i, id] of ["a", "b", "c"].entries()) await q.submit(CH, yt(id), alice, `m${i}`);
  });

  it("next walks the queue and ends empty", () => {
    expect(current()).toBeNull();
    q.next(CH);
    expect(current()).toBe("a");
    q.next(CH);
    q.next(CH);
    expect(current()).toBe("c");
    q.next(CH);
    expect(current()).toBeNull();
    expect(q.state(CH, true).history.map((i) => i.status)).toEqual(["played", "played", "played"]);
  });

  it("skip marks skipped", () => {
    q.next(CH);
    q.next(CH, "skipped");
    expect(q.state(CH, true).history[0]?.status).toBe("skipped");
  });

  it("previous replays the last clip and puts the current one back on top", () => {
    q.next(CH); // a
    q.next(CH); // b
    q.previous(CH);
    expect(current()).toBe("a");
    expect(ids()).toEqual(["b", "c"]);
    q.next(CH);
    expect(current()).toBe("b");
  });

  it("previous with no history does nothing", () => {
    q.next(CH);
    q.previous(CH);
    expect(current()).toBe("a");
  });

  it("play jumps to a queued clip; the interrupted one goes back on top", () => {
    q.next(CH); // a
    const c = q.state(CH, true).queue.find((i) => i.clipId.startsWith("c"))!;
    expect(q.play(CH, c.id)).toBe(true);
    expect(current()).toBe("c");
    expect(ids()).toEqual(["a", "b"]);
    expect(q.state(CH, true).history).toEqual([]);
    q.next(CH);
    expect(current()).toBe("a");
    expect(ids()).toEqual(["b"]);
  });

  it("vote skip: one vote per viewer, skips at the threshold, then starts over", () => {
    q.updateSettings(CH, { voteSkip: 3 });
    expect(q.voteSkip(CH, 1).status).toBe("nothing_playing");
    q.next(CH); // a
    expect(q.voteSkip(CH, 1)).toMatchObject({ status: "counted", votes: 1, needed: 3 });
    expect(q.voteSkip(CH, 1)).toMatchObject({ status: "already_voted", votes: 1 });
    expect(q.voteSkip(CH, 2)).toMatchObject({ status: "counted", votes: 2 });
    expect(q.state(CH, true).skipVotes).toBe(2);
    expect(q.voteSkip(CH, 3)).toMatchObject({ status: "skipped", votes: 3 });
    expect(current()).toBe("b");
    expect(q.state(CH, true).history[0]?.status).toBe("skipped");
    // Fresh count for the new clip; old voters can vote again.
    expect(q.state(CH, true).skipVotes).toBe(0);
    expect(q.voteSkip(CH, 1)).toMatchObject({ status: "counted", votes: 1 });
  });

  it("vote skip: votes don't carry over when the clip changes another way", () => {
    q.updateSettings(CH, { voteSkip: 2 });
    q.next(CH); // a
    q.voteSkip(CH, 1);
    q.next(CH); // b
    expect(q.voteSkip(CH, 2)).toMatchObject({ status: "counted", votes: 1 });
  });

  it("vote skip: 0 turns it off; default is 15", () => {
    expect(q.settings(CH).voteSkip).toBe(15);
    q.updateSettings(CH, { voteSkip: 0 });
    q.next(CH);
    expect(q.voteSkip(CH, 1).status).toBe("off");
    expect(current()).toBe("a");
  });

  it("play with nothing playing just starts the clip", () => {
    const b = q.state(CH, true).queue[1]!;
    q.play(CH, b.id);
    expect(current()).toBe("b");
    expect(ids()).toEqual(["a", "c"]);
  });

  it("move reorders", () => {
    const c = q.state(CH, true).queue[2]!;
    q.move(CH, c.id, 0);
    expect(ids()).toEqual(["c", "a", "b"]);
    q.move(CH, c.id, 99);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("removing the playing clip starts the next one", () => {
    q.next(CH);
    const a = q.state(CH, true).current!;
    q.remove(CH, a.id);
    expect(current()).toBe("b");
  });

  it("clear empties the queue but keeps the current clip", () => {
    q.next(CH);
    q.clear(CH);
    expect(ids()).toEqual([]);
    expect(current()).toBe("a");
  });

  it("can't touch another channel's items", () => {
    q.upsertChannel({ id: 200, slug: "other", displayName: "Other", chatroomId: 777 }, 200);
    const a = q.state(CH, true).queue[0]!;
    expect(q.remove(200, a.id)).toBe(false);
    expect(q.play(200, a.id)).toBe(false);
    expect(q.move(200, a.id, 0)).toBe(false);
    expect(ids()).toEqual(["a", "b", "c"]);
  });
});

describe("moderation", () => {
  it("deleting a chat message removes its clip", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), bob, "m2");
    q.removeByMessage(CH, "m1");
    expect(ids()).toEqual(["b"]);
  });

  it("a message deleted during the lookup never lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = resolver;
    resolver = async (ref) => (await gate, inner(ref));
    const pending = q.submit(CH, yt("a"), alice, "m1");
    q.removeByMessage(CH, "m1");
    release();
    expect(await pending).toEqual({ ok: false, reason: "moderated" });
    expect(ids()).toEqual([]);
  });

  it("a ban removes the user's clips, including the playing one", async () => {
    q.updateSettings(CH, { perUserLimit: 0 });
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), bob, "m2");
    await q.submit(CH, yt("c"), alice, "m3");
    q.next(CH); // alice's a plays
    q.removeByUser(CH, alice.id);
    expect(current()).toBe("b");
    expect(ids()).toEqual([]);
  });
});

describe("settings", () => {
  it("rejects invalid values", () => {
    expect(() => q.updateSettings(CH, { maxSize: 0 })).toThrow();
    expect(q.settings(CH).maxSize).toBe(100);
  });

  it("survives junk in the stored JSON", () => {
    const db = openDb(":memory:");
    const s = new QueueService(db, resolver);
    s.upsertChannel({ id: 1, slug: "x", displayName: "x", chatroomId: null }, 1);
    db.prepare(`UPDATE channels SET settings = 'not json' WHERE id = 1`).run();
    expect(s.settings(1).maxSize).toBe(100);
  });
});

describe("per-platform access", () => {
  const vip = (id: number) => ({ id, username: `v${id}`, color: null });

  it("everyone can post by default", async () => {
    expect((await q.submit(CH, yt("a"), alice, "m1", [])).ok).toBe(true);
  });

  it("limits a platform to the chosen badges", async () => {
    q.updateSettings(CH, { access: { youtube: ["og", "vip"] }, perUserLimit: 0 });
    expect(await q.submit(CH, yt("a"), alice, "m1", [])).toEqual({ ok: false, reason: "not_allowed" });
    expect(await q.submit(CH, yt("b"), alice, "m2", ["subscriber"])).toEqual({ ok: false, reason: "not_allowed" });
    expect((await q.submit(CH, yt("c"), vip(5), "m3", ["vip"])).ok).toBe(true);
    expect((await q.submit(CH, yt("d"), vip(6), "m4", ["og", "subscriber"])).ok).toBe(true);
  });

  it("only affects that platform", async () => {
    q.updateSettings(CH, { access: { youtube: ["moderator"] } });
    const kick: ClipRef = { provider: "kick", id: "clip_01K33WRXJM0KT1XZTXVAZJR5RJ", url: "https://kick.com/x/clips/clip_01K33WRXJM0KT1XZTXVAZJR5RJ" };
    expect((await q.submit(CH, kick, alice, "m1", [])).ok).toBe(true);
  });

  it("subscribers include founders; the broadcaster is always allowed", async () => {
    q.updateSettings(CH, { access: { youtube: ["subscriber"] }, perUserLimit: 0 });
    expect((await q.submit(CH, yt("a"), alice, "m1", ["founder"])).ok).toBe(true);
    q.updateSettings(CH, { access: { youtube: ["moderator"] } });
    expect((await q.submit(CH, yt("b"), bob, "m2", ["broadcaster"])).ok).toBe(true);
  });

  it("rejects an empty group list", () => {
    expect(() => q.updateSettings(CH, { access: { youtube: [] } })).toThrow();
  });
});

describe("bans and timeouts", () => {
  it("ignores a banned viewer's links and removes what they had waiting", async () => {
    q.updateSettings(CH, { perUserLimit: 0 });
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), bob, "m2");
    q.ban(CH, "Alice", null);
    expect(ids()).toEqual(["b"]);
    expect(await q.submit(CH, yt("c"), alice, "m3")).toEqual({ ok: false, reason: "banned" });
    expect(q.state(CH, true).bans).toMatchObject([{ username: "alice", until: null }]);
  });

  it("matches @names and any capitalisation", async () => {
    q.ban(CH, "@ALICE", null);
    expect(await q.submit(CH, yt("a"), { ...alice, username: "aLiCe" }, "m1")).toEqual({ ok: false, reason: "banned" });
  });

  it("follows a viewer who was seen before, even after a rename", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    q.ban(CH, "alice", null);
    expect(await q.submit(CH, yt("b"), { ...alice, username: "alice_new" }, "m2")).toEqual({ ok: false, reason: "banned" });
  });

  it("a timeout ends by itself", async () => {
    q.ban(CH, "alice", 60_000);
    expect(await q.submit(CH, yt("a"), alice, "m1")).toEqual({ ok: false, reason: "banned" });
    clock += 61_000;
    expect((await q.submit(CH, yt("a"), alice, "m2")).ok).toBe(true);
    expect(q.state(CH, true).bans).toEqual([]);
  });

  it("re-banning replaces the old ban; unban lifts it", async () => {
    q.ban(CH, "alice", 60_000);
    q.ban(CH, "alice", null);
    expect(q.state(CH, true).bans).toHaveLength(1);
    expect(q.state(CH, true).bans[0]?.until).toBeNull();
    expect(q.unban(CH, "ALICE")).toBe(true);
    expect((await q.submit(CH, yt("a"), alice, "m1")).ok).toBe(true);
  });

  it("removes the banned viewer's playing clip and starts the next one", async () => {
    q.updateSettings(CH, { perUserLimit: 0 });
    await q.submit(CH, yt("a"), alice, "m1");
    await q.submit(CH, yt("b"), bob, "m2");
    q.next(CH);
    q.ban(CH, "alice", 60_000);
    expect(current()).toBe("b");
  });

  it("a ban during the lookup still stops the link", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = resolver;
    resolver = async (ref) => (await gate, inner(ref));
    const pending = q.submit(CH, yt("a"), alice, "m1");
    q.ban(CH, "alice", null);
    release();
    expect(await pending).toEqual({ ok: false, reason: "banned" });
  });

  it("refuses silly durations and empty names", () => {
    expect(q.ban(CH, "alice", 0)).toBeNull();
    expect(q.ban(CH, "alice", 365 * 86_400_000)).toBeNull();
    expect(q.ban(CH, "  @ ", null)).toBeNull();
    expect(q.state(CH, true).bans).toEqual([]);
  });

  it("bans are per channel", async () => {
    q.upsertChannel({ id: 200, slug: "other", displayName: "Other", chatroomId: 777 }, 200);
    q.updateSettings(200, { open: true });
    q.ban(CH, "alice", null);
    expect((await q.submit(200, yt("a"), alice, "m1")).ok).toBe(true);
  });
});

describe("settings migration", () => {
  it("turns Instagram on for settings saved before it existed, once", () => {
    const db = openDb(":memory:");
    const s = new QueueService(db, resolver);
    s.upsertChannel({ id: 1, slug: "x", displayName: "x", chatroomId: null }, 1);
    db.prepare(`UPDATE channels SET settings = ? WHERE id = 1`).run(JSON.stringify({ providers: ["kick", "youtube"] }));
    expect(s.settings(1).providers).toEqual(["kick", "youtube", "instagram"]);
    s.updateSettings(1, { providers: ["kick"] });
    expect(s.settings(1).providers).toEqual(["kick"]);
  });
});

describe("song requests", () => {
  // A fake lookup: "id:seconds" or "id" (3 minutes). "missing" isn't found.
  const lookups: string[] = [];
  let s: QueueService;
  const song = (text: string) => ({ type: "search" as const, text });
  const req = (text: string, who: Requester = alice, badges: string[] = []) => s.requestSong(CH, song(text), who, null, badges);
  const titles = () => s.state(CH, true).songs.queue.map((i) => i.clipId);
  const playing = () => s.state(CH, true).songs.current?.clipId ?? null;

  beforeEach(() => {
    lookups.length = 0;
    s = new QueueService(openDb(":memory:"), (ref) => resolver(ref), () => clock, {
      resolve: async (q) => {
        const text = q.type === "search" ? q.text : "";
        lookups.push(text);
        if (text === "missing") return { ok: false, reason: "not_found" };
        const [id, secs] = text.split(":");
        const v = { id: id!.padEnd(11, "x"), title: `Song ${id}`, author: null, duration: secs ? Number(secs) : 180, thumbnail: "", start: null };
        return { ok: true, video: v };
      },
      obsUrl: (id) => `http://x/obs/?c=${id}`,
    });
    s.upsertChannel({ id: CH, slug: "erph", displayName: "Erph", chatroomId: 555 }, CH);
    s.updateSettings(CH, { open: true, songs: { ...s.settings(CH).songs, open: true } });
  });

  it("are closed by default, with sensible defaults", () => {
    const fresh = new QueueService(openDb(":memory:"), resolver);
    fresh.upsertChannel({ id: 1, slug: "a", displayName: "A", chatroomId: 1 }, 1);
    expect(fresh.settings(1).songs).toEqual({
      open: false, maxSize: 50, perUserLimit: 2, maxDuration: 600, voteSkip: 10, access: ["everyone"], player: "dashboard", volume: 60,
    });
  });

  it("the first song starts right away; the rest wait in order; clips are untouched", async () => {
    expect((await req("a")).ok).toBe(true);
    expect((await req("b", bob)).ok).toBe(true);
    expect((await req("c", { ...bob, id: 3, username: "cara" })).ok).toBe(true);
    expect(playing()).toMatch(/^a/);
    expect(titles().map((t) => t[0])).toEqual(["b", "c"]);
    expect(s.state(CH, true).queue).toEqual([]);
    expect(s.state(CH, true).current).toBeNull();
    s.next(CH); // clips: nothing happens to songs
    expect(playing()).toMatch(/^a/);
    s.next(CH, "played", "songs");
    expect(playing()).toMatch(/^b/);
  });

  it("enforces closed, duplicates, the per-viewer limit, length and who can request", async () => {
    await req("a");
    expect(await req("a", bob)).toEqual({ ok: false, reason: "duplicate" }); // a is playing
    await req("b");
    await req("c"); // alice: a playing, b and c waiting (the default limit is 2)
    expect(await req("c2")).toEqual({ ok: false, reason: "user_limit" });
    expect(await req("long:900", bob)).toEqual({ ok: false, reason: "too_long" });
    expect(await req("missing", bob)).toEqual({ ok: false, reason: "not_found" });
    s.updateSettings(CH, { songs: { ...s.settings(CH).songs, access: ["vip"] } });
    expect(await req("d", bob)).toEqual({ ok: false, reason: "not_allowed" });
    expect((await req("d", bob, ["vip"])).ok).toBe(true);
    s.updateSettings(CH, { songs: { ...s.settings(CH).songs, open: false } });
    expect(await req("e", bob, ["vip"])).toEqual({ ok: false, reason: "closed" });
  });

  it("counts only waiting songs toward the per-viewer limit", async () => {
    s.updateSettings(CH, { songs: { ...s.settings(CH).songs, perUserLimit: 1 } });
    expect((await req("a")).ok).toBe(true); // playing, not waiting
    expect((await req("b")).ok).toBe(true);
    expect(await req("c")).toEqual({ ok: false, reason: "user_limit" });
  });

  it("the broadcaster (and super users, who chat as one) skip the per-viewer limit, access and bans", async () => {
    s.updateSettings(CH, { songs: { ...s.settings(CH).songs, perUserLimit: 1, access: ["vip"] } });
    s.ban(CH, "alice", null);
    const boss = ["broadcaster"];
    expect((await req("a", alice, boss)).ok).toBe(true);
    expect((await req("b", alice, boss)).ok).toBe(true);
    expect((await req("c", alice, boss)).ok).toBe(true);
    expect(await req("d", alice)).toEqual({ ok: false, reason: "banned" });
  });

  it("knows when each song will start", async () => {
    await req("a:200");
    await req("b:100", bob);
    await req("c:60", { ...bob, id: 3, username: "cara" });
    clock += 50_000; // 50 s into a
    const tl = s.songTimeline(CH);
    expect(tl.left).toBe(150);
    expect(tl.queue.map((q) => q.startsIn)).toEqual([150, 250]);
  });

  it("a viewer can change a waiting song in place, or remove it; only their own", async () => {
    await req("a");
    await req("b", bob);
    await req("c", { ...bob, id: 3, username: "cara" });
    const b = s.state(CH, true).songs.queue[0]!;
    expect(await s.replaceSong(CH, b.id, { id: alice.id, username: "alice" }, song("x"))).toEqual({ ok: false, reason: "not_found" });
    expect((await s.replaceSong(CH, b.id, { id: bob.id, username: "bob" }, song("z"))).ok).toBe(true);
    expect(titles().map((t) => t[0])).toEqual(["z", "c"]); // same place
    expect(s.removeOwnSong(CH, b.id, alice.id)).toBe(false);
    expect(s.removeOwnSong(CH, b.id, bob.id)).toBe(true);
    expect(titles().map((t) => t[0])).toEqual(["c"]);
  });

  it("!wrongsong removes the viewer's latest waiting song", async () => {
    await req("a");
    await req("b");
    await req("c");
    expect(s.wrongSong(CH, alice.id)?.clipId).toMatch(/^c/);
    expect(titles().map((t) => t[0])).toEqual(["b"]);
    expect(s.wrongSong(CH, bob.id)).toBeNull();
  });

  it("bans and deleted messages remove songs too; vote skip is separate from clips", async () => {
    s.updateSettings(CH, { songs: { ...s.settings(CH).songs, voteSkip: 2 } });
    await req("a");
    await req("b", bob);
    expect(s.voteSkip(CH, 10, "songs")).toMatchObject({ status: "counted", votes: 1, needed: 2 });
    expect(s.voteSkip(CH, 10).status).toBe("nothing_playing"); // clips
    expect(s.voteSkip(CH, 11, "songs")).toMatchObject({ status: "skipped" });
    expect(playing()).toMatch(/^b/);
    s.ban(CH, "bob", null);
    expect(playing()).toBeNull();
  });

  it("the public page shows the queue and the viewer's own songs", async () => {
    await req("a:120");
    await req("b:60", bob);
    await req("c:60");
    s.next(CH, "played", "songs"); // a done
    const pub = s.publicSongs(CH, { id: alice.id, username: "alice" });
    expect(pub.current?.title).toBe("Song b");
    expect(pub.queue.map((q) => q.title)).toEqual(["Song c"]);
    expect(pub.me?.queued.map((q) => q.title)).toEqual(["Song c"]);
    expect(pub.me?.history.map((q) => q.title)).toEqual(["Song a"]);
    expect(s.publicSongs(CH, null).me).toBeNull();
  });

  it("settings saved before songs existed get the song defaults", () => {
    const db = openDb(":memory:");
    const fresh = new QueueService(db, resolver);
    fresh.upsertChannel({ id: 1, slug: "a", displayName: "A", chatroomId: 1 }, 1);
    db.prepare(`UPDATE channels SET settings = ? WHERE id = 1`).run(JSON.stringify({ open: true, voteSkip: 5 }));
    expect(fresh.settings(1).voteSkip).toBe(5);
    expect(fresh.settings(1).songs.maxDuration).toBe(600);
  });
});
