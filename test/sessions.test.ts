import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/server/db.js";
import { SESSION_COOKIE, Sessions } from "../src/server/sessions.js";

const DAY = 24 * 3600 * 1000;

function fakeReply() {
  const set: { name: string; expires: Date }[] = [];
  const reply = { setCookie: (name: string, _v: string, o: { expires: Date }) => set.push({ name, expires: o.expires }) };
  return { reply: reply as unknown as FastifyReply, set };
}

function setup() {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO channels (id, slug, display_name, owner_id, created_at) VALUES (1, 'erph', 'Erph', 1, 0)`).run();
  const sessions = new Sessions(db);
  const { reply } = fakeReply();
  sessions.create(reply, 1, { id: 1, username: "erph" });
  const id = (db.prepare(`SELECT id FROM sessions`).get() as { id: string }).id;
  const req = { cookies: { [SESSION_COOKIE]: id } } as unknown as FastifyRequest;
  const expiry = () => (db.prepare(`SELECT expires_at FROM sessions`).get() as { expires_at: number }).expires_at;
  return { db, sessions, req, expiry };
}

describe("dashboard logins", () => {
  it("last about a year", () => {
    const { expiry } = setup();
    expect(expiry() - Date.now()).toBeGreaterThan(360 * DAY);
  });

  it("aren't renewed again on the same day", () => {
    const { sessions, req, expiry } = setup();
    const before = expiry();
    const { reply, set } = fakeReply();
    sessions.renew(req, reply);
    expect(set).toEqual([]);
    expect(expiry()).toBe(before);
  });

  it("start a fresh year when used after a day", () => {
    const { db, sessions, req, expiry } = setup();
    db.prepare(`UPDATE sessions SET expires_at = ?`).run(Date.now() + 100 * DAY);
    const { reply, set } = fakeReply();
    sessions.renew(req, reply);
    expect(expiry() - Date.now()).toBeGreaterThan(360 * DAY);
    expect(set.map((c) => c.name)).toEqual([SESSION_COOKIE]);
  });

  it("stay expired once expired", () => {
    const { db, sessions, req } = setup();
    db.prepare(`UPDATE sessions SET expires_at = ?`).run(Date.now() - 1);
    const { reply, set } = fakeReply();
    sessions.renew(req, reply);
    expect(set).toEqual([]);
    expect(sessions.get(req)).toBeNull();
  });
});
