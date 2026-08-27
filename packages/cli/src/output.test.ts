import { describe, expect, it } from "vitest";
import type { StatusResult } from "@rockspec/engine";
import { failureEnvelope, formatHuman, formatHumanFailure, projectStatus, successEnvelope } from "./output.js";

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
      error: {
        code: "GATE_FAILED",
        details: ["review missing"],
        retryable: false,
        state_changed: false,
        recovery_command: null,
      },
    });
  });

  it("provides a deterministic recovery command for stale manual bindings", () => {
    expect(failureEnvelope("revise", {
      code: "RECOVERY_TRIGGER_MISMATCH",
      message: "Finding bindings changed",
      details: { change_id: "recover-design" },
    })).toMatchObject({
      error: {
        retryable: false,
        state_changed: false,
        recovery_command: "rockspec recover apply recover-design",
      },
    });
  });

  it("renders artifact validation failures as concise Chinese field guidance", () => {
    const failure = failureEnvelope("validate", {
      code: "VALIDATION_FAILED",
      message: "RockSpec validation did not pass",
      details: {
        errors: [{
          code: "invalid_value",
          message: "Invalid option",
          paths: ["reviews/task.md", "findings", "0", "owner_domain"],
          received: "acceptance",
          allowed: ["planning", "implementation", "testing"],
        }],
      },
    });
    expect(formatHumanFailure(failure)).toContain("reviews/task.md -> findings -> 0 -> owner_domain");
    expect(formatHumanFailure(failure)).toContain("问题：字段值不在允许范围内");
    expect(formatHumanFailure(failure)).toContain("可选值：planning、implementation、testing");
  });

  it("normalizes raw zod issues from submit-path errors into the same field guidance", () => {
    // 提交路径（action complete）直接透传 result.error.issues，形态是 { path, issues }
    // 而非 { errors }。归一化后应与 dry-run 渲染出同样的「可选值」「期望」指引。
    const enumFailure = failureEnvelope("action.complete", {
      code: "INVALID_REQUIREMENTS_REVIEW",
      message: "Requirements Review metadata is invalid",
      details: {
        path: "reviews/requirements-review.md",
        issues: [{
          code: "invalid_value",
          values: ["requirements", "design", "planning", "implementation", "testing", "workflow"],
          path: ["findings", 0, "owner_domain"],
          message: 'Invalid option: expected one of "requirements"|"design"',
        }],
      },
    });
    const enumOutput = formatHumanFailure(enumFailure);
    expect(enumOutput).toContain("reviews/requirements-review.md -> findings -> 0 -> owner_domain");
    expect(enumOutput).toContain("问题：字段值不在允许范围内");
    expect(enumOutput).toContain("可选值：requirements、design、planning、implementation、testing、workflow");
    expect(enumOutput).not.toContain('"issues"');

    const typeFailure = failureEnvelope("action.complete", {
      code: "INVALID_PROPOSAL",
      message: "Proposal must declare non-goals, assumptions, and resolved open questions",
      details: {
        path: "proposal.md",
        issues: [{
          expected: "object",
          code: "invalid_type",
          path: ["assumptions", 0],
          message: "Invalid input: expected object, received string",
        }],
      },
    });
    const typeOutput = formatHumanFailure(typeFailure);
    expect(typeOutput).toContain("proposal.md -> assumptions -> 0");
    expect(typeOutput).toContain("问题：字段类型不正确");
    expect(typeOutput).toContain("期望：object");
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

  it("renders a Chinese approval summary with formal artifact paths and an opaque machine receipt", () => {
    const rendered = formatHuman({
      gate: "design",
      path: "runtime/approvals/design-package.yaml",
      hash: `sha256:${"a".repeat(64)}`,
      review_summary: {
        language: "zh-CN",
        title: "设计审批",
        approval_prompt: "请输入“批准设计”继续，或直接提出修改意见。",
        machine_receipt_note: "仅用于机器一致性校验，无需复制或理解。",
        artifact_root: ".rockspec/changes/add-export",
        artifacts: [{
          label: "技术设计",
          path: ".rockspec/changes/add-export/design.md",
          relative_path: "design.md",
          description: "记录方案比较、架构决策、接口、安全和回滚设计。",
        }],
        sections: [{
          title: "核心设计决策",
          items: ["D-001 使用现有服务边界\n决定：复用现有服务\n理由：避免平行链路\n影响：外部接口不变"],
        }],
      },
    });
    expect(rendered).toContain("【设计审批】");
    expect(rendered).toContain("- D-001 使用现有服务边界\n  决定：复用现有服务\n  理由：避免平行链路\n  影响：外部接口不变");
    expect(rendered).toContain("正式评审材料\n目录：\n  .rockspec/changes/add-export/");
    expect(rendered).toContain("1. 技术设计\n   文件：design.md\n   说明：记录方案比较、架构决策、接口、安全和回滚设计。");
    expect(rendered).not.toContain("技术设计：.rockspec/changes/add-export/design.md");
    expect(rendered).toContain("请输入“批准设计”继续");
    expect(rendered).toContain("机器凭证：sha256:");
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
        execution: { active_task: "T-001", active_execution: "implementer-1", registry: [] },
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
    expect(projectStatus(status, "resume")).toMatchObject({
      view: "resume",
      active_task: "T-001",
      remaining_tasks: [{ id: "T-001", status: "in_progress" }],
      resume_note: expect.stringContaining("Engine 已持久化状态"),
    });
    expect(formatHuman(projectStatus(status, "resume"))).toContain("剩余 Task：");
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
