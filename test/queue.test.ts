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

  it("rejects repeats since the queue opened, unless allowed", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    q.next(CH);
    q.next(CH); // a finished
    expect(await q.submit(CH, yt("a"), bob, "m2")).toEqual({ ok: false, reason: "already_played" });
    q.updateSettings(CH, { allowRepeats: true });
    expect((await q.submit(CH, yt("a"), bob, "m3")).ok).toBe(true);
  });

  it("forgets played clips when the queue is reopened", async () => {
    await q.submit(CH, yt("a"), alice, "m1");
    q.next(CH);
    q.next(CH);
    q.updateSettings(CH, { open: false });
    q.updateSettings(CH, { open: true });
    expect((await q.submit(CH, yt("a"), bob, "m2")).ok).toBe(true);
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

  it("play jumps to a queued clip; the old one goes to history", () => {
    q.next(CH); // a
    const c = q.state(CH, true).queue.find((i) => i.clipId.startsWith("c"))!;
    expect(q.play(CH, c.id)).toBe(true);
    expect(current()).toBe("c");
    expect(ids()).toEqual(["b"]);
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
