import { describe, expect, it } from "vitest";
import {
  ProtocolValidationError,
  assertChangeId,
  triageProfile,
  validateChangeId,
} from "../src/index.js";

describe("change IDs", () => {
  it("accepts semantic lowercase kebab-case IDs", () => {
    expect(validateChangeId("rename-submit-button")).toBe(true);
    expect(validateChangeId("fix-login-redirect-after-timeout")).toBe(true);
  });

  it.each([
    "ab",
    "Add-profile-export",
    "2026-add-button",
    "add--button",
    "add_button",
    "new",
    "archive",
    `a${"b".repeat(64)}`,
  ])("rejects invalid or reserved ID %s", (id) => {
    expect(validateChangeId(id)).toBe(false);
  });

  it("throws a stable protocol error from assertChangeId", () => {
    expect(() => assertChangeId("new")).toThrow(ProtocolValidationError);
    try {
      assertChangeId("new");
    } catch (error) {
      expect((error as ProtocolValidationError).toJSON()).toMatchObject({
        code: "ROCKSPEC_PROTOCOL_VALIDATION_ERROR",
        message: "Invalid change ID",
      });
    }
  });
});

describe("profile triage", () => {
  it("uses standard for an unspecified change", () => {
    expect(triageProfile()).toMatchObject({
      profile: "standard",
      minimumProfile: "standard",
      matched_risks: [],
    });
  });

  it.each(["copy", "style", "config"] as const)("routes %s to lite", (kind) => {
    expect(triageProfile({ kind, requestedProfile: "auto" }).profile).toBe("lite");
  });

  it.each(["feature", "fix"] as const)("routes %s to standard", (kind) => {
    expect(triageProfile({ kind }).profile).toBe("standard");
  });

  it("promotes an explicit lower-risk profile", () => {
    expect(triageProfile({ kind: "copy", requestedProfile: "strict" })).toMatchObject({
      profile: "strict",
      minimumProfile: "lite",
      promoted: true,
    });
  });

  it("forces strict when a high-risk factor is present", () => {
    expect(triageProfile({ kind: "fix", riskFactors: ["privacy"] })).toMatchObject({
      profile: "strict",
      matched_risks: ["privacy"],
    });
  });

  it("reports a high-risk kind as a matched risk", () => {
    expect(triageProfile({ kind: "security" })).toMatchObject({
      profile: "strict",
      matched_risks: ["security"],
    });
  });

  it("rejects a requested profile below the computed minimum", () => {
    expect(() => triageProfile({ kind: "payment", requestedProfile: "standard" })).toThrow(
      ProtocolValidationError,
    );
    expect(() => triageProfile({ kind: "feature", requestedProfile: "lite" })).toThrow(
      ProtocolValidationError,
    );
  });
});
