import { ChangeSnapshotSchema, type Finding } from "@rockspec/protocol";
import { describe, expect, it } from "vitest";
import { recoveryDirective } from "../src/workflow.js";

const hash = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-08-14T00:00:00.000Z";

function changeWithFinding(finding: Finding) {
  return ChangeSnapshotSchema.parse({
    schema_version: 1,
    id: "reconcile-policy",
    title: "Reconcile policy",
    profile: "standard",
    state: "FINAL_REVIEW",
    base_ref: "main",
    base_commit: "abcdef1",
    workspace: null,
    created_at: timestamp,
    updated_at: timestamp,
    external_refs: [],
    artifacts: {},
    approvals: {},
    revisions: [],
    prototype: {
      required: false,
      capability: "ui.prototype",
      provider: null,
      status: "not_required",
    },
    execution: { active_task: null, active_execution: null },
    tasks: {},
    evidence: [],
    reviews: {
      delivery: {
        id: "delivery",
        kind: "delivery",
        verdict: "CHANGES_REQUIRED",
        path: "reviews/delivery-review.md",
        content_hash: hash,
        reviewer_execution_ids: ["delivery-reviewer"],
        round: 0,
        sources: [],
        reviewed_at: timestamp,
        findings: [finding],
      },
    },
    verification: { status: "pending" },
    completed_actions: [],
  });
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "important",
    category: "implementation-quality",
    evidence: "src/feature.ts:10",
    description: "The implementation does not satisfy an approved behavior.",
    owner_domain: "implementation",
    route_to: "task.execute",
    status: "open",
    classification: "implementation_fix",
    authority_impact: "unchanged",
    ...overrides,
  };
}

describe("recovery policy", () => {
  it("routes first-pass Requirements and plan-only Readiness Findings without opening a Revision", () => {
    const requirements = changeWithFinding(finding({
      owner_domain: "requirements",
      route_to: "requirements.clarify",
    }));
    requirements.state = "SPEC_REVIEW";
    requirements.reviews = {
      requirements: { ...requirements.reviews.delivery!, kind: "requirements" },
    };
    expect(recoveryDirective(requirements)).toMatchObject({
      kind: "action",
      source: "requirements.review",
      route_to: ["requirements.clarify"],
    });

    const readiness = changeWithFinding(finding({
      owner_domain: "planning",
      route_to: "plan.create",
      classification: "derived_gap",
    }));
    readiness.state = "READINESS_REVIEW";
    readiness.reviews = {
      readiness: { ...readiness.reviews.delivery!, kind: "readiness" },
    };
    expect(recoveryDirective(readiness)).toMatchObject({
      kind: "action",
      source: "readiness.review",
      route_to: ["plan.create"],
    });
  });

  it("allows only non-critical unchanged-authority repair classifications to reconcile automatically", () => {
    expect(recoveryDirective(changeWithFinding(finding()))).toMatchObject({
      kind: "revision",
      target: "plan",
      classifications: ["implementation_fix"],
      authority_delta: "unchanged",
      approval_policy: "auto",
    });
  });

  it("escalates Critical Findings even when their declared authority impact is unchanged", () => {
    expect(recoveryDirective(changeWithFinding(finding({ severity: "critical" })))).toMatchObject({
      kind: "revision",
      authority_delta: "unchanged",
      approval_policy: "human",
    });
  });

  it("escalates changed or unknown authority and human-only classifications", () => {
    expect(recoveryDirective(changeWithFinding(finding({
      classification: "decision_change",
      authority_impact: "changed",
    })))).toMatchObject({
      kind: "revision",
      classifications: ["decision_change"],
      authority_delta: "changed",
      approval_policy: "human",
    });
  });
});
