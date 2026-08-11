import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITIES, resolveCapability } from "./index.js";

describe("resolveCapability", () => {
  it("resolves the configured external provider when the host exposes it", () => {
    expect(
      resolveCapability(
        "ui.prototype",
        DEFAULT_CAPABILITIES,
        new Set(["ui-ux-pro-max"]),
      ),
    ).toEqual({
      id: "ui.prototype",
      provider: "ui-ux-pro-max",
      distribution: "installed",
      available: true,
    });
  });

  it("blocks when an installed provider is unavailable", () => {
    const result = resolveCapability("ui.prototype", DEFAULT_CAPABILITIES);

    expect(result.available).toBe(false);
    expect(result.reason).toContain("ui-ux-pro-max");
  });

  it("treats bundled providers as available", () => {
    const result = resolveCapability("ui.prototype", {
      capabilities: {
        "ui.prototype": { provider: "internal-provider", distribution: "bundled" },
      },
    });

    expect(result.available).toBe(true);
  });

  it("returns a stable missing-binding result", () => {
    const result = resolveCapability("unknown.capability", DEFAULT_CAPABILITIES);

    expect(result).toMatchObject({
      id: "unknown.capability",
      provider: "",
      available: false,
    });
  });
});
