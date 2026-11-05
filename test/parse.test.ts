import { describe, expect, it } from "vitest";
import { findClips, parseClipUrl, parseTimestamp } from "../src/server/clips/parse.js";
import { parseInstagramEmbed } from "../src/server/clips/resolve.js";
import { commandsText, parseDuration } from "../src/server/bridge.js";
import { adjust, votesText } from "../src/server/songs/commands.js";
import { parseLength, parseLoudness } from "../src/server/songs/resolve.js";
import { songVolume } from "../src/shared/types.js";

const ref = (url: string) => {
  const r = parseClipUrl(url);
  return r && { provider: r.provider, id: r.id, start: r.start, shortLink: r.shortLink };
};

describe("parseClipUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ?feature=share", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("youtube %s", (url, id) => {
    expect(ref(url)).toMatchObject({ provider: "youtube", id });
  });

  it("youtube start times", () => {
    expect(ref("https://youtu.be/dQw4w9WgXcQ?t=90")?.start).toBe(90);
    expect(ref("https://youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")?.start).toBe(90);
    expect(ref("https://youtube.com/watch?v=dQw4w9WgXcQ&t=1h0m5s")?.start).toBe(3605);
    expect(ref("https://youtu.be/dQw4w9WgXcQ?t=garbage")?.start).toBeUndefined();
  });

  it("rejects non-video youtube links", () => {
    expect(ref("https://youtube.com/@channel")).toBeNull();
    expect(ref("https://youtube.com/watch?v=short")).toBeNull();
    expect(ref("https://youtube.com/playlist?list=PL123")).toBeNull();
  });

  it.each([
    ["https://clips.twitch.tv/AwkwardHelplessSalamanderSwiftRage", "AwkwardHelplessSalamanderSwiftRage"],
    ["https://www.twitch.tv/xqc/clip/AwkwardHelplessSalamander-abc123_X", "AwkwardHelplessSalamander-abc123_X"],
    ["https://m.twitch.tv/clip/Funny-Clip_1", "Funny-Clip_1"],
    ["https://clips.twitch.tv/embed?clip=FunnyClip&parent=x.com", "FunnyClip"],
  ])("twitch %s", (url, id) => {
    expect(ref(url)).toMatchObject({ provider: "twitch", id });
  });

  it("rejects twitch channels and vods", () => {
    expect(ref("https://twitch.tv/xqc")).toBeNull();
    expect(ref("https://twitch.tv/videos/12345")).toBeNull();
  });

  it.each([
    "https://kick.com/erph/clips/clip_01K33WRXJM0KT1XZTXVAZJR5RJ",
    "https://kick.com/erph?clip=clip_01K33WRXJM0KT1XZTXVAZJR5RJ",
    "kick.com/clips/clip_01K33WRXJM0KT1XZTXVAZJR5RJ",
  ])("kick %s", (url) => {
    expect(ref(url)).toMatchObject({ provider: "kick", id: "clip_01K33WRXJM0KT1XZTXVAZJR5RJ" });
  });

  it("rejects kick channels", () => {
    expect(ref("https://kick.com/erph")).toBeNull();
  });

  it("tiktok", () => {
    expect(ref("https://www.tiktok.com/@someone/video/7312345678901234567?lang=en")).toMatchObject({
      provider: "tiktok",
      id: "7312345678901234567",
    });
    expect(ref("https://vm.tiktok.com/ZMabc123/")).toMatchObject({ provider: "tiktok", id: "ZMabc123", shortLink: true });
    expect(ref("https://www.tiktok.com/t/ZTabc123/")).toMatchObject({ provider: "tiktok", id: "ZTabc123", shortLink: true });
    expect(ref("https://www.tiktok.com/@someone")).toBeNull();
  });

  it("x / twitter", () => {
    expect(ref("https://x.com/user/status/1790000000000000000")).toMatchObject({ provider: "x", id: "1790000000000000000" });
    expect(ref("https://twitter.com/i/status/1790000000000000000?s=20")).toMatchObject({ provider: "x" });
    expect(ref("https://x.com/user")).toBeNull();
  });

  it.each([
    "https://www.instagram.com/reel/C9xYz_Ab12/",
    "https://instagram.com/reels/C9xYz_Ab12?igsh=abc",
    "https://www.instagram.com/p/C9xYz_Ab12/?img_index=1",
    "instagram.com/tv/C9xYz_Ab12",
    "https://www.instagram.com/someone/reel/C9xYz_Ab12/",
    "https://m.instagram.com/reel/C9xYz_Ab12",
  ])("instagram %s", (url) => {
    expect(ref(url)).toMatchObject({ provider: "instagram", id: "C9xYz_Ab12" });
  });

  it("normalises instagram links and rejects profiles", () => {
    expect(parseClipUrl("instagram.com/reels/C9xYz_Ab12?igsh=abc")?.url).toBe("https://www.instagram.com/p/C9xYz_Ab12/");
    expect(ref("https://www.instagram.com/someone/")).toBeNull();
    expect(ref("https://www.instagram.com/stories/someone/123/")).toBeNull();
  });

  it("streamable", () => {
    expect(ref("https://streamable.com/abc12")).toMatchObject({ provider: "streamable", id: "abc12" });
    expect(ref("https://streamable.com/e/abc12")).toMatchObject({ provider: "streamable", id: "abc12" });
  });

  it("ignores unsupported and malformed links", () => {
    expect(ref("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(ref("https://evil-youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(ref("youtube.com.evil.io/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(ref("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("normalises to https", () => {
    expect(parseClipUrl("http://youtu.be/dQw4w9WgXcQ")?.url).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(parseClipUrl("youtu.be/dQw4w9WgXcQ")?.url).toBe("https://youtu.be/dQw4w9WgXcQ");
  });
});

describe("findClips", () => {
  it("finds links inside chat text, trimming punctuation", () => {
    const found = findClips("ببین اینو youtu.be/dQw4w9WgXcQ), and this: https://clips.twitch.tv/FunnyClip!");
    expect(found.map((r) => [r.provider, r.id])).toEqual([
      ["youtube", "dQw4w9WgXcQ"],
      ["twitch", "FunnyClip"],
    ]);
  });

  it("drops repeats of the same clip in one message", () => {
    const found = findClips("youtu.be/dQw4w9WgXcQ https://youtube.com/watch?v=dQw4w9WgXcQ&t=10");
    expect(found).toHaveLength(1);
  });

  it("ignores emotes and plain text", () => {
    expect(findClips("[emote:37226:KEKW] lol hello.world")).toEqual([]);
  });
});

describe("parseTimestamp", () => {
  it.each([
    ["90", 90],
    ["90s", 90],
    ["2m", 120],
    ["1h2m3s", 3723],
    ["", 0],
    ["abc", 0],
  ])("%s -> %d", (t, s) => expect(parseTimestamp(t)).toBe(s));
});

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["10m", 600_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    ["15", 900_000],
    ["0m", null],
    ["31d", null],
    ["10x", null],
    ["", null],
  ])("%s -> %s", (t, ms) => expect(parseDuration(t)).toBe(ms));
});

describe("commandsText", () => {
  it("fits one Kick message and mentions the vote count", () => {
    const t = commandsText(15);
    expect([...t].length).toBeLessThanOrEqual(500);
    expect(t).toContain("!cvs");
    expect(t).toContain("15 votes");
    expect(t.startsWith("!")).toBe(false); // the bot must not trigger itself
    expect(t).toContain("!sr");
    expect(commandsText(0)).not.toContain("!cvs");
  });
});

describe("parseInstagramEmbed", () => {
  // As it appears in the embed page: JSON inside a JSON string inside a script.
  const html =
    String.raw`{\"is_video\":true,\"display_url\":\"https:\\\/\\\/cdn.example\\\/p.jpg\",\"video_view_count\":1341657}},` +
    String.raw`\"video_url\":\"https:\\\/\\\/instagram.fx.fna.fbcdn.net\\\/o1\\\/v.mp4?a=1\\u0026oe=6AED5AA5\",\"video_duration\":82.6,` +
    String.raw`\"owner\":{\"id\":\"328093556\",\"username\":\"raminikoo\",\"is_verified\":false}`;

  it("finds the video file, length, poster and author", () => {
    expect(parseInstagramEmbed(html)).toEqual({
      mediaUrl: "https://instagram.fx.fna.fbcdn.net/o1/v.mp4?a=1&oe=6AED5AA5",
      duration: 83,
      thumbnail: "https://cdn.example/p.jpg",
      author: "raminikoo",
    });
  });

  it("plays a carousel's first video", () => {
    const carousel =
      String.raw`{\"__typename\":\"GraphSidecar\",\"edge_sidecar_to_children\":{\"edges\":[` +
      String.raw`{\"node\":{\"is_video\":false,\"display_url\":\"https:\\\/\\\/cdn\\\/1.jpg\"}},` +
      String.raw`{\"node\":{\"is_video\":true,\"display_url\":\"https:\\\/\\\/cdn\\\/2.jpg\",\"video_url\":\"https:\\\/\\\/cdn\\\/2.mp4\"}}]}}`;
    expect(parseInstagramEmbed(carousel).mediaUrl).toBe("https://cdn/2.mp4");
  });

  it("has no file for a photo or a page without the post", () => {
    expect(parseInstagramEmbed("<html>login</html>")).toEqual({ mediaUrl: null, duration: null, thumbnail: null, author: null });
  });
});

describe("mod number commands", () => {
  it("sets, raises and lowers within bounds", () => {
    expect(adjust(50, "40", 100)).toBe(40);
    expect(adjust(50, "+10", 100)).toBe(60);
    expect(adjust(95, "+10", 100)).toBe(100);
    expect(adjust(5, "-10", 100)).toBe(0);
    expect(adjust(15, "2000", 1000)).toBe(1000);
    expect(adjust(15, undefined, 1000)).toBeNull();
    expect(adjust(15, "lots", 1000)).toBeNull();
  });

  it("answers the vote count", () => {
    expect(votesText("clip", 20, true)).toBe("Clip vote skip now needs 20 votes.");
    expect(votesText("song", 10, false)).toBe("Song vote skip needs 10 votes.");
    expect(votesText("clip", 0, true)).toBe("Vote skip for clips is now off.");
  });
});

describe("song loudness", () => {
  it("reads YouTube's loudness from the watch page", () => {
    expect(parseLoudness('..."audioConfig":{"loudnessDb":-4.6599998,"perceptualLoudnessDb":-18.66}...')).toBe(-4.66);
    expect(parseLoudness('"loudnessDb":5.71')).toBe(5.71);
    expect(parseLoudness("<html>consent page</html>")).toBeNull();
  });

  it("reads the length from the watch page", () => {
    expect(parseLength('"videoDetails":{"videoId":"x","lengthSeconds":"213"')).toBe(213);
    expect(parseLength('"lengthSeconds":"0"')).toBeNull(); // live streams
    expect(parseLength("<html></html>")).toBeNull();
  });

  it("turns quiet songs up and leaves loud ones to YouTube", () => {
    expect(songVolume(60, -6, true)).toBe(120); // 60 × 2.0; the player stops at YouTube's 100%
    expect(songVolume(40, -6, true)).toBe(80);
    expect(songVolume(60, 5.7, true)).toBe(60); // YouTube's player already lowers it to 52%
    expect(songVolume(60, 0, true)).toBe(60);
    expect(songVolume(60, null, true)).toBe(60);
    expect(songVolume(40, -6, false)).toBe(40);
  });
});
