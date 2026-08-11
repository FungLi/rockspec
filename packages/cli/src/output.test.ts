import { describe, expect, it } from "vitest";
import { failureEnvelope, formatHuman, successEnvelope } from "./output.js";

describe("CLI output", () => {
  it("versions successful JSON output", () => {
    expect(successEnvelope("status", { current_state: "READY" })).toEqual({
      schema_version: 1,
      ok: true,
      command: "status",
      data: { current_state: "READY" },
    });
  });

  it("normalizes structured errors", () => {
    expect(
      failureEnvelope("gate", {
        code: "GATE_FAILED",
        message: "The gate is blocked",
        details: ["review missing"],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "GATE_FAILED", details: ["review missing"] },
    });
  });

  it("shows the next action in human output", () => {
    expect(
      formatHuman({
        change: { id: "add-export", profile: "standard" },
        current_state: "SPEC_APPROVED",
        recommended_next: { action: "design.technical", reason: "Spec approved" },
        blocked_by: [],
      }),
    ).toContain("Next: design.technical - Spec approved");
  });
});
