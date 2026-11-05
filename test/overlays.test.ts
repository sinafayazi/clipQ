import { describe, expect, it } from "vitest";
import { overlayKey, overlayKeyValid, overlayUrl } from "../src/server/overlays/keys.js";

describe("overlay keys", () => {
  it("signs distinct keys for chat and streak", () => {
    const chat = overlayKey("chat", 42);
    const streak = overlayKey("streak", 42);
    expect(chat).not.toBe(streak);
    expect(chat).toHaveLength(24);
    expect(streak).toHaveLength(24);
  });

  it("validates keys with timing-safe compare", () => {
    const key = overlayKey("chat", 7);
    expect(overlayKeyValid("chat", 7, key)).toBe(true);
    expect(overlayKeyValid("streak", 7, key)).toBe(false);
    expect(overlayKeyValid("chat", 8, key)).toBe(false);
    expect(overlayKeyValid("streak", 7, overlayKey("streak", 7))).toBe(true);
  });

  it("builds public overlay URLs", () => {
    const url = overlayUrl("chat", 99);
    expect(url).toContain("/overlays/chat/?c=99&k=");
    expect(url).toContain(overlayKey("chat", 99));
    expect(overlayUrl("streak", 99)).toContain("/overlays/emote-streak/?c=99&k=");
  });
});
