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
  "knowledge.evolve",
  "change.archive",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export const REVISION_TARGETS = ["requirements", "design", "prototype", "plan"] as const;

export type RevisionTarget = (typeof REVISION_TARGETS)[number];

export const REVISION_STATUSES = ["open", "reconciled"] as const;

export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const REVISION_MODES = ["pre_implementation", "implementation_recovery", "feedback_reopen"] as const;

export type RevisionMode = (typeof REVISION_MODES)[number];

export const FEEDBACK_INTERACTION_MODES = ["reconcile", "compact", "full"] as const;

export type FeedbackInteractionMode = (typeof FEEDBACK_INTERACTION_MODES)[number];

export const REVISION_KINDS = ["upstream", "remediation"] as const;

export type RevisionKind = (typeof REVISION_KINDS)[number];

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

export const TASK_STATUSES = ["pending", "in_progress", "suspended", "superseded", "completed", "blocked"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FINDING_SEVERITIES = ["critical", "important", "minor"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const REVISION_CLASSIFICATIONS = [
  "consistency_fix",
  "derived_gap",
  "implementation_fix",
  "decision_change",
  "intent_change",
  "risk_acceptance",
] as const;

export type RevisionClassification = (typeof REVISION_CLASSIFICATIONS)[number];

export const AUTHORITY_IMPACTS = ["unchanged", "changed", "unknown"] as const;

export type AuthorityImpact = (typeof AUTHORITY_IMPACTS)[number];

export const APPROVAL_MODES = ["human", "auto"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];
