import { describe, expect, it } from "vitest";
import {
  ChangeSnapshotSchema,
  DesignDefinitionSchema,
  InstallLockSchema,
  InstallManifestSchema,
  PlanDefinitionSchema,
  ProtocolValidationError,
  ReviewDocumentSchema,
  TaskDefinitionSchema,
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
