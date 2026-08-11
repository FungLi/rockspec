export const PROFILES = ["lite", "standard", "strict"] as const;

export type WorkflowProfile = (typeof PROFILES)[number];

export const WORKFLOW_STATES = [
  "SCOPING",
  "SPEC_REVIEW",
  "SPEC_APPROVED",
  "DESIGNING",
  "DESIGN_APPROVED",
  "PLANNING",
  "READINESS_REVIEW",
  "READY",
  "IMPLEMENTING",
  "ACCEPTANCE_VALIDATING",
  "FINAL_REVIEW",
  "VERIFYING",
  "READY_TO_FINISH",
  "ARCHIVED",
  "BLOCKED",
  "PAUSED",
  "SUPERSEDED",
] as const;

export type ChangeState = (typeof WORKFLOW_STATES)[number];

export const ACTION_IDS = [
  "change.triage",
  "change.promote",
  "requirements.clarify",
  "requirements.review",
  "design.technical",
  "design.prototype",
  "plan.create",
  "readiness.review",
  "task.execute",
  "task.review",
  "acceptance.validate",
  "delivery.review",
  "change.verify",
  "change.archive",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export const REVIEW_VERDICTS = ["PASS", "CHANGES_REQUIRED", "BLOCKED"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const RESERVED_CHANGE_IDS = [
  "archive",
  "changes",
  "specs",
  "config",
  "current",
  "new",
] as const;

export const SPEC_OPERATIONS = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"] as const;

export type SpecOperation = (typeof SPEC_OPERATIONS)[number];

export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FINDING_SEVERITIES = ["critical", "important", "minor"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
