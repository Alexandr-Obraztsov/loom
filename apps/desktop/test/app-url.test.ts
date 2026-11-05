import { describe, expect, it } from "vitest";
import { appTarget, isAppUrl } from "../src/main/app-url.js";

describe("isAppUrl", () => {
  const file = appTarget(undefined, "/app/out/renderer/index.html");
  const dev = appTarget("http://localhost:5173/", "/unused");

  it("accepts the built index regardless of hash and query", () => {
    expect(isAppUrl(file, "file:///app/out/renderer/index.html")).toBe(true);
    expect(isAppUrl(file, "file:///app/out/renderer/index.html?x=1#y")).toBe(true);
  });

  it("rejects other files, other schemes and garbage", () => {
    expect(isAppUrl(file, "file:///etc/passwd")).toBe(false);
    expect(isAppUrl(file, "https://evil.example/")).toBe(false);
    expect(isAppUrl(file, "about:blank")).toBe(false);
    expect(isAppUrl(file, "not a url")).toBe(false);
  });

  it("accepts only the dev server origin in dev", () => {
    expect(isAppUrl(dev, "http://localhost:5173/some/path")).toBe(true);
    expect(isAppUrl(dev, "http://localhost:5174/")).toBe(false);
    expect(isAppUrl(dev, "https://localhost:5173/")).toBe(false);
    expect(isAppUrl(dev, "file:///app/out/renderer/index.html")).toBe(false);
  });
});
