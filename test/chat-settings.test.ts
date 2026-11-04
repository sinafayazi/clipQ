import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_STREAK_SETTINGS,
  chatObsQuery,
  chatPreviewQuery,
  chatPreviewShellQuery,
  clampBgOpacity,
  clampFadeOutMs,
  clampFontSize,
  clampFontWeight,
  fontStack,
  googleFontsCssUrl,
  parseFadeIn,
  parseFont,
  parseGoogleFontsInput,
  streakObsQuery,
  streakPreviewShellQuery,
  withOverlayQuery,
} from "../src/web/overlays/chat-settings";

describe("chat overlay settings", () => {
  it("encodes transparent default into the OBS query", () => {
    expect(chatObsQuery(DEFAULT_CHAT_SETTINGS)).toBe("&bg=0");
  });

  it("encodes custom look into the OBS query without demo mode", () => {
    const q = chatObsQuery({
      ...DEFAULT_CHAT_SETTINGS,
      font: "inter",
      fontSize: 28,
      fontWeight: 700,
      fadeOutMs: 12_000,
      fadeIn: "slide",
      bgOpacity: 45,
      maxMessages: 20,
    });
    expect(q).toContain("bg=45");
    expect(q).toContain("font=inter");
    expect(q).toContain("size=28");
    expect(q).toContain("weight=700");
    expect(q).toContain("ttl=12000");
    expect(q).toContain("anim=slide");
    expect(q).toContain("max=20");
    expect(q).not.toContain("demo=");
  });

  it("encodes a Google Fonts custom family into the OBS query", () => {
    const q = chatObsQuery({
      ...DEFAULT_CHAT_SETTINGS,
      font: "custom",
      googleFontFamily: "Space Grotesk",
      googleFontLink: "https://fonts.google.com/specimen/Space+Grotesk",
    });
    expect(q).toContain("font=custom");
    expect(q).toContain("ff=Space+Grotesk");
  });

  it("adds demo=1 only for fake preview", () => {
    expect(chatPreviewQuery({ ...DEFAULT_CHAT_SETTINGS, preview: "fake" })).toContain("demo=1");
    expect(chatPreviewQuery({ ...DEFAULT_CHAT_SETTINGS, preview: "live" })).not.toContain("demo=");
    expect(chatPreviewShellQuery("fake")).toBe("&demo=1");
    expect(chatPreviewShellQuery("live")).toBe("");
  });

  it("clamps and parses values", () => {
    expect(clampFontSize(8)).toBe(12);
    expect(clampFontSize(99)).toBe(48);
    expect(clampFontWeight(450)).toBe(500);
    expect(clampFontWeight(860)).toBe(900);
    expect(clampFontWeight(200)).toBe(400);
    expect(clampBgOpacity(120)).toBe(100);
    expect(clampFadeOutMs(500)).toBe(2000);
    expect(parseFadeIn("pop")).toBe("pop");
    expect(parseFadeIn("nope")).toBe("fade");
    expect(parseFont("rubik")).toBe("rubik");
    expect(parseFont("custom")).toBe("custom");
    expect(parseFont("comic")).toBe("jakarta");
  });

  it("parses Google Fonts links into a family and stylesheet", () => {
    expect(parseGoogleFontsInput("https://fonts.google.com/specimen/Roboto")).toEqual({
      family: "Roboto",
      cssUrl: googleFontsCssUrl("Roboto"),
    });
    expect(
      parseGoogleFontsInput(
        "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap",
      ),
    ).toEqual({
      family: "Open Sans",
      cssUrl: "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap",
    });
    expect(
      parseGoogleFontsInput(
        '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400..700&display=swap" rel="stylesheet">',
      )?.family,
    ).toBe("DM Sans");
    expect(parseGoogleFontsInput("not a font!!!")).toBeNull();
    expect(fontStack("custom", "Space Grotesk")).toBe('"Space Grotesk", sans-serif');
  });

  it("appends query onto an existing overlay URL", () => {
    const base = "https://example.com/overlays/chat/?c=1&k=abc";
    expect(withOverlayQuery(base, "&size=24&demo=1")).toBe(`${base}&size=24&demo=1`);
  });
});

describe("streak overlay settings", () => {
  it("encodes idle TTL and anim into the OBS query without demo mode", () => {
    expect(streakObsQuery(DEFAULT_STREAK_SETTINGS)).toBe("");
    const q = streakObsQuery({
      ...DEFAULT_STREAK_SETTINGS,
      fadeOutMs: 12_000,
      fadeIn: "slide",
    });
    expect(q).toContain("ttl=12000");
    expect(q).toContain("anim=slide");
    expect(q).not.toContain("demo=");
  });

  it("adds demo=1 only for fake streak preview", () => {
    expect(streakPreviewShellQuery("fake")).toBe("&demo=1");
    expect(streakPreviewShellQuery("live")).toBe("");
  });
});
