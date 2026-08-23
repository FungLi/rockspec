import { describe, expect, it } from "vitest";
import type { StatusResult } from "@rockspec/engine";
import { failureEnvelope, formatHuman, projectStatus, successEnvelope } from "./output.js";

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

  it("shows a Finding-bound recovery directive in human output", () => {
    expect(
      formatHuman({
        change: { id: "add-export", profile: "standard" },
        current_state: "IMPLEMENTING",
        recommended_next: { action: "revise", reason: "Recover an upstream Finding" },
        recovery: {
          kind: "revision",
          review_id: "task:T-004",
          target: "design",
          finding_ids: ["F-001"],
        },
        blocked_by: [],
      }),
    ).toContain("Recovery: revision -> design from task:T-004 [F-001]");
  });

  it("projects compact status views without replaying the full Change history", () => {
    const status = {
      schema_version: 1,
      current_state: "IMPLEMENTING",
      change: {
        id: "compact-status",
        title: "Compact status",
        profile: "standard",
        state: "IMPLEMENTING",
        base_ref: "main",
        base_commit: "abcdef1",
        workspace: null,
        updated_at: "2026-08-22T00:00:00.000Z",
        execution: { active_task: "T-001", active_execution: "implementer-1" },
        prototype: { required: false, provider: null, status: "not_required" },
        verification: { status: "pending" },
        knowledge_evolution: { status: "pending" },
        tasks: {
          "T-001": {
            id: "T-001",
            title: "Implement",
            status: "in_progress",
            dependencies: [],
            supersedes: [],
            finding_ids: [],
          },
        },
        revisions: [],
        feedback_batches: [],
        artifacts: {},
        approvals: {},
        reviews: {},
        evidence: [{ id: "E-001", command: "large historical output" }],
      },
      recommended_next: { action: "task.execute", entry_skill: "rockspec-implement", reason: "Continue" },
      alternatives: [],
      blocked_by: [],
      allowed_actions: ["task.execute"],
      recovery: null,
    } as unknown as StatusResult;

    expect(projectStatus(status, "summary")).toMatchObject({
      view: "summary",
      change_id: "compact-status",
      change: { task_counts: { in_progress: 1 } },
    });
    expect(JSON.stringify(projectStatus(status, "summary"))).not.toContain("large historical output");
    expect(projectStatus(status, "tasks")).toMatchObject({
      view: "tasks",
      active_task: "T-001",
      tasks: [{ id: "T-001", status: "in_progress" }],
    });
    expect(projectStatus(status, "full")).toBe(status);
  });

  it("projects legacy feedback Revisions as compact interaction", () => {
    const status = {
      schema_version: 1,
      current_state: "SCOPING",
      change: {
        id: "legacy-feedback",
        revisions: [{
          id: "RV-008",
          status: "open",
          source: "acceptance.validate",
          target: "requirements",
          mode: "feedback_reopen",
          kind: "upstream",
          classifications: ["decision_change"],
          authority_delta: "changed",
          approval_policy: "human",
          gate_policies: { spec: "human" },
          convergence_round: 1,
        }],
        feedback_batches: [{ id: "FB-001", revision_id: "RV-008" }],
        reviews: {},
      },
      recommended_next: { action: "requirements.clarify", entry_skill: "rockspec-requirements", reason: "Revise" },
      alternatives: [],
      blocked_by: [],
      allowed_actions: ["requirements.clarify"],
      recovery: null,
    } as unknown as StatusResult;

    expect(projectStatus(status, "recovery")).toMatchObject({
      open_revision: { id: "RV-008", interaction_mode: "compact" },
    });
  });
});
