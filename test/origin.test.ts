import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/server/origin.js";

const pub = "http://localhost:5173";

describe("originAllowed", () => {
  it("accepts PUBLIC_URL and loopback aliases on the same port", () => {
    expect(originAllowed("http://localhost:5173", pub)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5173", pub)).toBe(true);
    expect(originAllowed("http://[::1]:5173", pub)).toBe(true);
  });

  it("rejects other hosts, ports, and schemes", () => {
    expect(originAllowed("http://evil.example:5173", pub)).toBe(false);
    expect(originAllowed("http://localhost:3000", pub)).toBe(false);
    expect(originAllowed("https://localhost:5173", pub)).toBe(false);
    expect(originAllowed("not a url", pub)).toBe(false);
  });
});
