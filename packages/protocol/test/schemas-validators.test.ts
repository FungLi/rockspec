import { describe, expect, it } from "vitest";
import {
  AcceptanceDocumentSchema,
  ChangeSnapshotSchema,
  DesignDefinitionSchema,
  FindingSchema,
  InstallLockSchema,
  InstallManifestSchema,
  KnowledgeDeltaDocumentSchema,
  KnowledgeEvolutionSchema,
  KnowledgeReviewDocumentSchema,
  PlanDefinitionSchema,
  ProtocolValidationError,
  ReconciliationReviewDocumentSchema,
  ReviewDocumentSchema,
  RevisionSchema,
  FeedbackBatchSchema,
  StageReviewDocumentSchema,
  TaskDefinitionSchema,
  TaskRecordSchema,
  hashContent,
  parseChangeSnapshot,
  parseConfig,
  validateEvidence,
  validateReview,
  validateTaskCommit,
  validateUniqueTaskCommits,
  type TaskRecord,
} from "../src/index.js";

const now = "2026-08-10T10:00:00Z";
const later = "2026-08-10T10:01:00Z";
const commit = "abcdef1";
const hash = hashContent("artifact");

function snapshot(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "rename-submit-button",
    title: "Rename submit button",
    profile: "lite",
    state: "SCOPING",
    base_ref: "main",
    base_commit: commit,
    created_at: now,
    updated_at: now,
    external_refs: [],
    artifacts: {
      brief: { path: "brief.md", hash, updated_at: now },
    },
    approvals: {},
    prototype: {
      required: false,
      capability: "ui.prototype",
      provider: "ui-ux-pro-max",
      status: "not_required",
    },
    execution: { active_task: null, active_execution: null },
    tasks: {},
    evidence: [],
    reviews: {},
    verification: { status: "pending" },
    completed_actions: [],
  };
}

describe("config and change snapshot schemas", () => {
  it("applies practical config defaults", () => {
    expect(parseConfig({ capabilities: {} })).toEqual({
      schema_version: 1,
      default_profile: "standard",
      max_reconciliation_rounds: 2,
      capabilities: {},
      workspace: {
        mode: "auto",
        directory: ".worktrees",
        branch_prefix: "rockspec/",
        auto_create: false,
      },
    });
  });

  it("parses the host-independent change snapshot", () => {
    expect(parseChangeSnapshot(snapshot())).toMatchObject({
      id: "rename-submit-button",
      schema_version: 1,
      workspace: null,
      verification: { status: "pending" },
    });
  });

  it("defaults feedback and delivery boundary fields for legacy snapshots", () => {
    const parsed = parseChangeSnapshot(snapshot());
    expect(parsed.feedback_batches).toEqual([]);
    expect(parsed.delivery_head).toBeUndefined();
  });

  it("validates a user acceptance Feedback Batch", () => {
    expect(FeedbackBatchSchema.parse({
      schema_version: 1,
      id: "FB-001",
      source: "user_acceptance",
      route: "same_change",
      status: "submitted",
      reason: "Acceptance found a related interaction adjustment.",
      target: "requirements",
      items: [{ id: "FB-ITEM-001", description: "Show the reset result in the UI." }],
      affected_ids: ["R-001"],
      submitted_at: now,
    })).toMatchObject({
      id: "FB-001",
      route: "same_change",
      interaction_mode: "compact",
      submitted_by: "user",
    });
    for (const interactionMode of ["reconcile", "compact", "full"] as const) {
      expect(FeedbackBatchSchema.safeParse({
        schema_version: 1,
        id: "FB-001",
        source: "user_acceptance",
        route: "same_change",
        interaction_mode: interactionMode,
        status: "submitted",
        reason: "Acceptance feedback.",
        target: "requirements",
        items: [{ id: "FB-ITEM-001", description: "Adjust the visible result." }],
        affected_ids: ["R-001"],
        submitted_at: now,
      }).success).toBe(true);
    }
  });

  it("validates portable workspace bindings", () => {
    expect(parseChangeSnapshot({
      ...snapshot(),
      workspace: { mode: "worktree", branch: "rockspec/rename-submit-button", managed: true },
    })).toMatchObject({
      workspace: { mode: "worktree", branch: "rockspec/rename-submit-button", managed: true },
    });
    expect(ChangeSnapshotSchema.safeParse({
      ...snapshot(),
      workspace: { mode: "current", branch: "main", managed: true },
    }).success).toBe(false);
  });

  it("rejects unknown snapshot fields and inconsistent active task pointers", () => {
    expect(ChangeSnapshotSchema.safeParse({ ...snapshot(), unknown: true }).success).toBe(false);
    const active = snapshot();
    active.execution = { active_task: "T-001", active_execution: "exec-1" };
    expect(ChangeSnapshotSchema.safeParse(active).success).toBe(false);
  });

  it("requires archived snapshots to record the archive time", () => {
    expect(() => parseChangeSnapshot({ ...snapshot(), state: "ARCHIVED" })).toThrow(
      ProtocolValidationError,
    );
  });
});

describe("installation schemas", () => {
  const integrity = `sha256:${"a".repeat(64)}`;

  it("accepts a safe distribution Manifest", () => {
    expect(InstallManifestSchema.safeParse({
      schema_version: 1,
      rockspec: {
        version: "0.1.0",
        runtime: "distribution/runtime/rockspec.mjs",
        skills: ["rockspec-change"],
      },
      capabilities: {
        "ui.prototype": { provider: "ui-ux-pro-max", default: true },
      },
      external_skills: {
        "ui-ux-pro-max": {
          capability: "ui.prototype",
          source: {
            type: "local-discovery",
            candidates: [".agents/skills/ui-ux-pro-max"],
          },
          license: "UNKNOWN",
          hosts: ["codex", "claude"],
        },
      },
    }).success).toBe(true);
  });

  it("rejects distribution paths that escape the source root", () => {
    expect(InstallManifestSchema.safeParse({
      schema_version: 1,
      rockspec: {
        version: "0.1.0",
        runtime: "../runtime/rockspec.mjs",
        skills: ["rockspec-change"],
      },
    }).success).toBe(false);
  });

  it("accepts a Lock for a single selected host", () => {
    expect(InstallLockSchema.safeParse({
      schema_version: 1,
      rockspec: {
        version: "0.1.0",
        runtime_path: ".rockspec/bin/rockspec.mjs",
        integrity,
      },
      installed_at: now,
      hosts: {
        codex: { skills_root: ".agents/skills", mode: "canonical" },
      },
      skills: {
        "rockspec-change": {
          name: "rockspec-change",
          owner: "rockspec",
          source_type: "bundled",
          source_ref: "rockspec@0.1.0",
          license: "Apache-2.0",
          integrity,
          canonical_path: ".agents/skills/rockspec-change",
        },
      },
      managed_paths: [{
        path: ".agents/skills/rockspec-change",
        kind: "directory",
        integrity,
      }],
    }).success).toBe(true);
  });

  it("rejects malformed managed path integrity", () => {
    expect(InstallLockSchema.safeParse({
      schema_version: 1,
      rockspec: {
        version: "0.1.0",
        runtime_path: ".rockspec/bin/rockspec.mjs",
        integrity,
      },
      installed_at: now,
      hosts: {
        claude: { skills_root: ".claude/skills", mode: "copy" },
      },
      skills: {},
      managed_paths: [{
        path: ".rockspec/bin/rockspec.mjs",
        kind: "file",
        integrity: "sha256:not-a-hash",
      }],
    }).success).toBe(false);
  });
});

describe("review, evidence, and task commit validation", () => {
  it("validates structured Task scope and Review submissions", () => {
    expect(TaskDefinitionSchema.safeParse({
      schema_version: 1,
      id: "T-001",
      title: "Implement behavior",
      dependencies: [],
      requirement_ids: ["R-001"],
      scenario_ids: ["S-001"],
      acceptance_criteria: ["The behavior is observable"],
      consumes: [],
      produces: ["feature.run(input: Input): Output"],
      allowed_paths: ["src/feature.ts", "test/feature.test.ts"],
    }).success).toBe(true);
    expect(TaskDefinitionSchema.safeParse({
      schema_version: 1,
      id: "T-002",
      title: "Replace a suspended task",
      dependencies: [],
      supersedes: ["T-001"],
      requirement_ids: ["R-001"],
      scenario_ids: ["S-001"],
      finding_ids: ["F-001"],
      acceptance_criteria: ["The replacement closes the recovery finding"],
      allowed_paths: ["src/feature.ts"],
    }).success).toBe(true);
    expect(TaskRecordSchema.safeParse({
      id: "T-001",
      status: "superseded",
      superseded_by: "T-002",
      superseded_in_revision: "RV-001",
      superseded_at: now,
      attempts: [{
        execution_id: "execution-1",
        status: "superseded",
        revision_id: "RV-001",
        base_commit: commit,
        head_commit: commit,
        brief_path: "revisions/RV-001/before/runtime/tasks/T-001/brief.md",
        brief_hash: hash,
        review_attempts: 0,
        suspended_at: now,
      }],
    }).success).toBe(true);
    expect(TaskRecordSchema.safeParse({
      id: "T-001",
      status: "superseded",
      superseded_by: "T-002",
    }).success).toBe(false);
    expect(TaskDefinitionSchema.safeParse({
      schema_version: 1,
      id: "T-001",
      title: "Mutate workflow state",
      requirement_ids: ["R-001"],
      scenario_ids: ["S-001"],
      acceptance_criteria: ["Workflow state changes"],
      allowed_paths: [".rockspec/change.yaml"],
    }).success).toBe(false);
    expect(PlanDefinitionSchema.safeParse({
      schema_version: 1,
      verification_only_scenario_ids: ["S-002"],
    }).success).toBe(true);
    expect(DesignDefinitionSchema.safeParse({
      schema_version: 1,
      inputs: { spec_hash: hash },
      decisions: [{ id: "D-001", requirement_ids: ["R-001"], scenario_ids: ["S-001"] }],
    }).success).toBe(true);
    expect(ReviewDocumentSchema.safeParse({
      schema_version: 1,
      verdict: "CHANGES_REQUIRED",
      reviewer_execution_id: "reviewer-1",
      subject: { base_commit: commit, head_commit: "abcdef2", diff_hash: hash },
      round: 0,
      findings: [],
    }).success).toBe(false);
  });

  it("rejects PASS with an open important finding", () => {
    const result = validateReview({
      verdict: "PASS",
      path: "reviews/delivery-review.md",
      content_hash: hash,
      reviewed_at: now,
      findings: [
        {
          id: "F-001",
          severity: "important",
          category: "spec-compliance",
          evidence: "specs/profile/spec.md#R-001",
          description: "Required behavior is missing",
          owner_domain: "implementation",
          route_to: "task.execute",
          status: "open",
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("requires structured Open Findings for a non-PASS Stage Review", () => {
    expect(StageReviewDocumentSchema.safeParse({
      schema_version: 1,
      verdict: "CHANGES_REQUIRED",
      reviewer_execution_id: "readiness-reviewer",
      findings: [],
    }).success).toBe(false);
    expect(StageReviewDocumentSchema.safeParse({
      schema_version: 1,
      verdict: "CHANGES_REQUIRED",
      reviewer_execution_id: "readiness-reviewer",
      findings: [{
        id: "F-001",
        severity: "critical",
        category: "design-compliance",
        evidence: "design.md:20",
        description: "A required technical decision is missing.",
        owner_domain: "design",
        route_to: "design.technical",
        status: "open",
        classification: "decision_change",
        authority_impact: "changed",
      }],
    }).success).toBe(true);
  });

  it("binds Finding routes, Recovery Revisions, and Acceptance reports", () => {
    expect(FindingSchema.safeParse({
      id: "F-001",
      severity: "important",
      category: "design-compliance",
      evidence: "design.md:1",
      description: "The Design boundary is incomplete.",
      owner_domain: "design",
      route_to: "task.execute",
      status: "open",
    }).success).toBe(false);
    expect(AcceptanceDocumentSchema.safeParse({
      schema_version: 1,
      verdict: "CHANGES_REQUIRED",
      reviewer_execution_id: "acceptance-reviewer",
      commit,
      findings: [{
        id: "F-001",
        severity: "important",
        category: "behavior",
        evidence: "test:e2e",
        description: "The implementation fails an acceptance edge case.",
        owner_domain: "implementation",
        route_to: "task.execute",
        status: "open",
      }],
    }).success).toBe(true);
    expect(RevisionSchema.safeParse({
      id: "RV-001",
      source: "acceptance.validate",
      target: "plan",
      mode: "implementation_recovery",
      kind: "remediation",
      status: "open",
      reason: "Acceptance requires remediation.",
      affected_ids: [],
      before_hashes: {},
      after_hashes: {},
      invalidated_approvals: ["implementation"],
      invalidated_reviews: ["acceptance"],
      invalidated_actions: ["plan.create"],
      started_at: now,
    }).success).toBe(false);
    expect(RevisionSchema.safeParse({
      id: "RV-001",
      source: "acceptance.validate",
      target: "plan",
      mode: "implementation_recovery",
      kind: "remediation",
      status: "open",
      reason: "Acceptance requires remediation.",
      affected_ids: [],
      trigger: { review_id: "acceptance", finding_ids: ["F-001"], review_hash: hash },
      before_hashes: {},
      after_hashes: {},
      invalidated_approvals: ["implementation"],
      invalidated_reviews: ["acceptance"],
      invalidated_actions: ["plan.create"],
      started_at: now,
    }).success).toBe(true);
    expect(RevisionSchema.safeParse({
      id: "RV-004",
      source: "acceptance.validate",
      target: "requirements",
      mode: "feedback_reopen",
      interaction_mode: "compact",
      kind: "upstream",
      status: "open",
      reason: "Apply explicit acceptance feedback.",
      affected_ids: ["R-001"],
      classifications: ["decision_change"],
      approval_policy: "human",
      authority_delta: "changed",
      before_hashes: {},
      started_at: now,
    }).success).toBe(true);
    expect(RevisionSchema.safeParse({
      id: "RV-005",
      source: "acceptance.validate",
      target: "requirements",
      mode: "feedback_reopen",
      interaction_mode: "reconcile",
      kind: "upstream",
      status: "open",
      reason: "Restore an already approved behavior.",
      affected_ids: ["R-001"],
      classifications: ["consistency_fix"],
      approval_policy: "auto",
      authority_delta: "unchanged",
      author_execution_id: "feedback-author",
      before_hashes: {},
      started_at: now,
    }).success).toBe(true);
    expect(RevisionSchema.safeParse({
      id: "RV-003",
      source: "task.review",
      target: "design",
      mode: "implementation_recovery",
      kind: "upstream",
      status: "open",
      reason: "Recover an implementation-stage Design gap.",
      affected_ids: ["D-001"],
      trigger: { review_id: "task:T-001", finding_ids: ["F-001"], review_hash: hash },
      amendments: [{
        id: "AM-001",
        source: "readiness.review",
        target: "design",
        reason: "Readiness exposed another Design gap.",
        affected_ids: ["D-002"],
        classifications: ["decision_change"],
        approval_policy: "human",
        authority_delta: "changed",
        trigger: { review_id: "readiness", finding_ids: ["F-002"], review_hash: hash },
        before_hashes: { "design.md": hash },
        invalidated_approvals: ["design"],
        invalidated_reviews: ["readiness"],
        invalidated_actions: ["design.technical", "plan.create", "readiness.review"],
        amended_at: now,
      }],
      before_hashes: {},
      invalidated_approvals: ["design", "implementation"],
      invalidated_reviews: ["readiness"],
      invalidated_actions: ["design.technical", "plan.create", "readiness.review"],
      started_at: now,
    }).success).toBe(true);

    const autoFinding = {
      id: "F-002",
      severity: "important",
      category: "design-compliance",
      evidence: "design.md:1",
      description: "An approved Scenario lacks a derived Design detail.",
      owner_domain: "design",
      route_to: "design.technical",
      status: "open",
      classification: "derived_gap",
      authority_impact: "unchanged",
    };
    expect(FindingSchema.safeParse(autoFinding).success).toBe(true);
    expect(FindingSchema.safeParse({
      ...autoFinding,
      classification: "intent_change",
    }).success).toBe(false);
    expect(RevisionSchema.safeParse({
      id: "RV-002",
      source: "task.review",
      target: "design",
      mode: "implementation_recovery",
      kind: "upstream",
      status: "open",
      reason: "Restore a derived Design detail.",
      affected_ids: ["D-001"],
      classifications: ["derived_gap"],
      approval_policy: "auto",
      authority_delta: "unchanged",
      author_execution_id: "revision-author",
      authority_baselines: { design: hash },
      trigger: { review_id: "task:T-001", finding_ids: ["F-002"], review_hash: hash },
      before_hashes: {},
      after_hashes: {},
      invalidated_approvals: ["design"],
      invalidated_reviews: ["readiness"],
      invalidated_actions: ["design.technical"],
      started_at: now,
    }).success).toBe(true);
    expect(ReconciliationReviewDocumentSchema.safeParse({
      schema_version: 1,
      revision_id: "RV-002",
      gate: "design",
      round: 1,
      verdict: "PASS",
      reviewer_execution_id: "independent-reviewer",
      classifications: ["derived_gap"],
      authority_delta: "unchanged",
      finding_ids: ["F-002"],
      subject: { artifact_hashes: { "design.md": hash }, aggregate_hash: hash },
      findings: [],
    }).success).toBe(true);
  });

  it("validates evidence freshness and result consistency", () => {
    const base = {
      id: "EV-001",
      kind: "test",
      command: "pnpm test",
      cwd: ".",
      started_at: now,
      finished_at: later,
      exit_code: 0,
      passed: 12,
      failed: 0,
      skipped: 1,
      commit,
    };
    expect(validateEvidence(base).valid).toBe(true);
    expect(validateEvidence({ ...base, finished_at: "2026-08-10T09:59:00Z" }).valid).toBe(false);
    expect(validateEvidence({ ...base, failed: 1 }).valid).toBe(false);
  });

  it("validates knowledge evolution authority, review, and no-change receipts", () => {
    const normative = {
      schema_version: 1,
      change_id: "standardize-form-feedback",
      author_execution_id: "knowledge-author",
      outcome: "proposed",
      updates: [{
        target: "experience/form-feedback.md",
        operation: "new",
        authority: "normative",
        summary: "Establish the shared form feedback rule.",
        sources: ["design.md#D-001"],
      }],
    };
    expect(KnowledgeDeltaDocumentSchema.safeParse(normative).success).toBe(false);
    expect(KnowledgeDeltaDocumentSchema.safeParse({
      ...normative,
      approval: { approved_by: "product-owner", approved_at: now },
    }).success).toBe(true);
    expect(KnowledgeReviewDocumentSchema.safeParse({
      schema_version: 1,
      verdict: "PASS",
      reviewer_execution_id: "knowledge-reviewer",
      subject: {
        source_digest: hash,
        delta_hash: hash,
        baseline_hashes: { "experience/form-feedback.md": null },
        candidate_hashes: { "experience/form-feedback.md": hash },
      },
      findings: [],
    }).success).toBe(true);
    expect(KnowledgeEvolutionSchema.safeParse({
      schema_version: 1,
      change_id: "standardize-form-feedback",
      status: "no_change",
      protocol_version: 1,
      source_digest: hash,
      delta_path: "knowledge-delta.md",
      delta_hash: hash,
      updates: [],
      recorded_at: now,
    }).success).toBe(true);
  });

  it("requires one final commit whose message names the task", () => {
    const task = {
      id: "T-001",
      status: "completed",
      commit_sha: commit,
      completed_at: later,
      started_at: now,
    };
    expect(validateTaskCommit(task, "feat(profile): [T-001] save profile").valid).toBe(true);
    expect(validateTaskCommit(task, "feat(profile): save profile").valid).toBe(false);
  });

  it("prevents a commit from belonging to multiple tasks", () => {
    const tasks: TaskRecord[] = [
      {
        id: "T-001",
        status: "completed",
        dependencies: [],
        requirement_ids: [],
        scenario_ids: [],
        acceptance_criteria: [],
        consumes: [],
        produces: [],
        allowed_paths: ["src/one.ts"],
        review_attempts: 0,
        commit_sha: commit,
      },
      {
        id: "T-002",
        status: "completed",
        dependencies: [],
        requirement_ids: [],
        scenario_ids: [],
        acceptance_criteria: [],
        consumes: [],
        produces: [],
        allowed_paths: ["src/two.ts"],
        review_attempts: 0,
        commit_sha: commit,
      },
    ];
    expect(validateUniqueTaskCommits(tasks).valid).toBe(false);
  });
});
