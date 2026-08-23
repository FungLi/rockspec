import { z } from "zod";
import {
  ACTION_IDS,
  APPROVAL_MODES,
  AUTHORITY_IMPACTS,
  FEEDBACK_INTERACTION_MODES,
  FINDING_SEVERITIES,
  PROFILES,
  REVISION_CLASSIFICATIONS,
  REVISION_KINDS,
  REVISION_MODES,
  REVISION_STATUSES,
  REVISION_TARGETS,
  REVIEW_VERDICTS,
  TASK_STATUSES,
  WORKFLOW_STATES,
} from "./constants.js";
import { ChangeIdSchema } from "./change-id.js";
import { parseProtocol, safeParseProtocol, type ValidationResult } from "./validation.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i;

export const TimestampSchema = z.iso.datetime({ offset: true });
export const Sha256Schema = z.string().regex(SHA256_PATTERN, "Expected a sha256:<64 lowercase hex> hash");
export const GitCommitSchema = z.string().regex(COMMIT_PATTERN, "Expected a 7-64 character Git commit SHA");
export const WorkflowProfileSchema = z.enum(PROFILES);
export const ChangeStateSchema = z.enum(WORKFLOW_STATES);
export const ActionIdSchema = z.enum(ACTION_IDS);
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);

export const ArtifactRecordSchema = z
  .object({
    path: z.string().min(1),
    hash: Sha256Schema,
    updated_at: TimestampSchema,
  })
  .strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const ApprovalGateSchema = z.enum(["spec", "design", "implementation"]);
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export const RevisionGatePolicySchema = z.enum(["preserve", "auto", "human"]);
export const AuthorityImpactSchema = z.enum(AUTHORITY_IMPACTS);
export const RevisionClassificationSchema = z.enum(REVISION_CLASSIFICATIONS);
export const FeedbackInteractionModeSchema = z.enum(FEEDBACK_INTERACTION_MODES);

const RevisionTriggerSchema = z.object({
  review_id: z.string().min(1),
  finding_ids: z.array(z.string().regex(/^F-\d{3,}$/)).min(1),
  review_hash: Sha256Schema,
}).strict();

export const RevisionAmendmentSchema = z
  .object({
    id: z.string().regex(/^AM-\d{3,}$/),
    source: ActionIdSchema,
    target: z.enum(REVISION_TARGETS),
    reason: z.string().trim().min(1),
    affected_ids: z.array(z.string().regex(/^[RSD]-\d{3,}$/)).default([]),
    classifications: z.array(RevisionClassificationSchema).min(1),
    approval_policy: ApprovalModeSchema,
    gate_policies: z.object({
      spec: RevisionGatePolicySchema.optional(),
      design: RevisionGatePolicySchema.optional(),
      implementation: RevisionGatePolicySchema.optional(),
    }).strict().default({}),
    authority_delta: AuthorityImpactSchema,
    trigger: RevisionTriggerSchema,
    before_hashes: z.record(z.string().min(1), Sha256Schema),
    invalidated_approvals: z.array(ApprovalGateSchema).default([]),
    invalidated_reviews: z.array(z.string().min(1)).default([]),
    invalidated_actions: z.array(ActionIdSchema).default([]),
    amended_at: TimestampSchema,
  })
  .strict()
  .superRefine((amendment, context) => {
    for (const field of ["affected_ids", "classifications", "invalidated_approvals", "invalidated_reviews", "invalidated_actions"] as const) {
      if (new Set(amendment[field]).size !== amendment[field].length) {
        context.addIssue({ code: "custom", path: [field], message: `Revision Amendment ${field} values must be unique` });
      }
    }
    if (amendment.trigger.finding_ids.length !== new Set(amendment.trigger.finding_ids).size) {
      context.addIssue({ code: "custom", path: ["trigger", "finding_ids"], message: "Amendment Finding IDs must be unique" });
    }
  });

export type RevisionAmendment = z.infer<typeof RevisionAmendmentSchema>;

export const ApprovalSchema = z
  .object({
    gate: ApprovalGateSchema,
    artifact_hashes: z.record(z.string().min(1), Sha256Schema).refine(
      (hashes) => Object.keys(hashes).length > 0,
      "Approval must bind at least one artifact hash",
    ),
    aggregate_hash: Sha256Schema,
    approved_by: z.string().min(1),
    approved_at: TimestampSchema,
    mode: ApprovalModeSchema.default("human"),
    revision_id: z.string().regex(/^RV-\d{3,}$/).optional(),
    authority_basis_hash: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.mode === "auto" && (!approval.revision_id || !approval.authority_basis_hash)) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "Auto approval must identify its Revision and authority baseline",
      });
    }
  });

export type Approval = z.infer<typeof ApprovalSchema>;

export const RevisionSchema = z
  .object({
    id: z.string().regex(/^RV-\d{3,}$/),
    source: ActionIdSchema,
    target: z.enum(REVISION_TARGETS),
    mode: z.enum(REVISION_MODES).default("pre_implementation"),
    interaction_mode: FeedbackInteractionModeSchema.optional(),
    kind: z.enum(REVISION_KINDS).default("upstream"),
    status: z.enum(REVISION_STATUSES),
    reason: z.string().trim().min(1),
    affected_ids: z.array(z.string().regex(/^[RSD]-\d{3,}$/)).default([]),
    classifications: z.array(RevisionClassificationSchema).min(1).default(["decision_change"]),
    approval_policy: ApprovalModeSchema.default("human"),
    gate_policies: z.object({
      spec: RevisionGatePolicySchema.optional(),
      design: RevisionGatePolicySchema.optional(),
      implementation: RevisionGatePolicySchema.optional(),
    }).strict().default({}),
    authority_delta: AuthorityImpactSchema.default("unknown"),
    author_execution_id: z.string().min(1).optional(),
    authority_baselines: z.object({
      spec: Sha256Schema.optional(),
      design: Sha256Schema.optional(),
      implementation: Sha256Schema.optional(),
    }).strict().default({}),
    convergence_round: z.number().int().min(1).default(1),
    last_reconciliation: z.object({
      gate: ApprovalGateSchema,
      verdict: z.enum(REVIEW_VERDICTS),
      reviewer_execution_id: z.string().min(1),
      authority_delta: AuthorityImpactSchema,
      report_path: z.string().min(1),
      report_hash: Sha256Schema,
      aggregate_hash: Sha256Schema,
      round: z.number().int().min(1),
      reviewed_at: TimestampSchema,
    }).strict().optional(),
    auto_approvals: z.array(z.object({
      gate: ApprovalGateSchema,
      reviewer_execution_id: z.string().min(1),
      report_path: z.string().min(1),
      report_hash: Sha256Schema,
      aggregate_hash: Sha256Schema,
      authority_basis_hash: Sha256Schema,
      approved_at: TimestampSchema,
    }).strict()).default([]),
    escalation_reason: z.string().min(1).optional(),
    trigger: RevisionTriggerSchema.optional(),
    amendments: z.array(RevisionAmendmentSchema).default([]),
    before_hashes: z.record(z.string().min(1), Sha256Schema),
    after_hashes: z.record(z.string().min(1), Sha256Schema).default({}),
    invalidated_approvals: z.array(ApprovalGateSchema).default([]),
    invalidated_reviews: z.array(z.string().min(1)).default([]),
    invalidated_actions: z.array(ActionIdSchema).default([]),
    started_at: TimestampSchema,
    reconciled_at: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((revision, context) => {
    for (const field of ["affected_ids", "classifications", "invalidated_approvals", "invalidated_reviews", "invalidated_actions"] as const) {
      if (new Set(revision[field]).size !== revision[field].length) {
        context.addIssue({ code: "custom", path: [field], message: `Revision ${field} values must be unique` });
      }
    }
    if (revision.status === "reconciled" && revision.reconciled_at === undefined) {
      context.addIssue({ code: "custom", path: ["reconciled_at"], message: "A reconciled Revision must record reconciled_at" });
    }
    if (revision.mode === "implementation_recovery" && revision.trigger === undefined) {
      context.addIssue({ code: "custom", path: ["trigger"], message: "Implementation recovery must bind its triggering Review Findings" });
    }
    if (revision.mode !== "feedback_reopen" && revision.interaction_mode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["interaction_mode"],
        message: "Only feedback_reopen Revisions may declare a feedback interaction mode",
      });
    }
    if (revision.interaction_mode === "reconcile" &&
        (revision.approval_policy !== "auto" || revision.authority_delta !== "unchanged" ||
          !revision.classifications.every((classification) => classification === "consistency_fix"))) {
      context.addIssue({
        code: "custom",
        path: ["interaction_mode"],
        message: "Reconcile feedback must be an automatic unchanged-authority consistency fix",
      });
    }
    if ((revision.interaction_mode === "compact" || revision.interaction_mode === "full") &&
        (revision.approval_policy !== "human" || revision.authority_delta !== "changed")) {
      context.addIssue({
        code: "custom",
        path: ["interaction_mode"],
        message: "Compact and full feedback require human approval of changed authority",
      });
    }
    if (revision.kind === "upstream" && revision.affected_ids.length === 0) {
      context.addIssue({ code: "custom", path: ["affected_ids"], message: "Upstream Revision must identify affected R-/S-/D- IDs" });
    }
    if (revision.trigger && new Set(revision.trigger.finding_ids).size !== revision.trigger.finding_ids.length) {
      context.addIssue({ code: "custom", path: ["trigger", "finding_ids"], message: "Revision trigger Finding IDs must be unique" });
    }
    if (new Set(revision.amendments.map((amendment) => amendment.id)).size !== revision.amendments.length) {
      context.addIssue({ code: "custom", path: ["amendments"], message: "Revision Amendment IDs must be unique" });
    }
    if (revision.approval_policy === "auto" &&
        (revision.authority_delta !== "unchanged" || !revision.author_execution_id)) {
      context.addIssue({
        code: "custom",
        path: ["approval_policy"],
        message: "Auto Revision requires unchanged authority and an author execution ID",
      });
    }
    if (revision.auto_approvals.some((approval) => revision.author_execution_id === approval.reviewer_execution_id)) {
      context.addIssue({
        code: "custom",
        path: ["auto_approvals"],
        message: "Reconciliation Reviewer must be independent from the Revision Author",
      });
    }
  });

export type Revision = z.infer<typeof RevisionSchema>;

export const FeedbackBatchItemSchema = z
  .object({
    id: z.string().regex(/^FB-ITEM-\d{3,}$/),
    description: z.string().trim().min(1),
  })
  .strict();

export const FeedbackBatchSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^FB-\d{3,}$/),
    source: z.literal("user_acceptance"),
    route: z.enum(["same_change", "new_change"]),
    interaction_mode: FeedbackInteractionModeSchema.default("compact"),
    status: z.enum(["submitted", "routed", "resolved"]),
    reason: z.string().trim().min(1),
    items: z.array(FeedbackBatchItemSchema).min(1),
    target: z.enum(REVISION_TARGETS).optional(),
    affected_ids: z.array(z.string().regex(/^[RSD]-\d{3,}$/)).default([]),
    revision_id: z.string().regex(/^RV-\d{3,}$/).optional(),
    related_change_id: ChangeIdSchema.optional(),
    submitted_by: z.string().min(1).default("user"),
    submitted_at: TimestampSchema,
    resolved_at: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((batch, context) => {
    if (new Set(batch.items.map((item) => item.id)).size !== batch.items.length) {
      context.addIssue({ code: "custom", path: ["items"], message: "Feedback item IDs must be unique" });
    }
    if (new Set(batch.affected_ids).size !== batch.affected_ids.length) {
      context.addIssue({ code: "custom", path: ["affected_ids"], message: "Feedback affected IDs must be unique" });
    }
    if (batch.route === "same_change" && !batch.target) {
      context.addIssue({ code: "custom", path: ["target"], message: "Same-Change feedback must identify its earliest affected target" });
    }
  });

export type FeedbackBatch = z.infer<typeof FeedbackBatchSchema>;

export const ApprovalMapSchema = z
  .partialRecord(ApprovalGateSchema, ApprovalSchema)
  .superRefine((approvals, context) => {
    for (const [key, approval] of Object.entries(approvals)) {
      if (approval !== undefined && approval.gate !== key) {
        context.addIssue({
          code: "custom",
          path: [key, "gate"],
          message: `Approval map key ${key} does not match gate ${approval.gate}`,
        });
      }
    }
  });

export const PrototypeStatusSchema = z.enum(["not_required", "pending", "completed", "reconciled"]);

export const PrototypeSchema = z
  .object({
    required: z.boolean(),
    capability: z.string().min(1).default("ui.prototype"),
    provider: z.string().min(1).nullable(),
    status: PrototypeStatusSchema,
  })
  .strict()
  .superRefine((prototype, context) => {
    if (prototype.required && prototype.status === "not_required") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A required prototype cannot have not_required status",
      });
    }
    if (!prototype.required && prototype.status !== "not_required") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A non-required prototype must have not_required status",
      });
    }
    if (["completed", "reconciled"].includes(prototype.status) && prototype.provider === null) {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "A completed or reconciled prototype must identify its provider",
      });
    }
  });

export type Prototype = z.infer<typeof PrototypeSchema>;

export const ExecutionSchema = z
  .object({
    active_task: z.string().regex(/^T-\d{3,}$/).nullable(),
    active_execution: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((execution, context) => {
    if ((execution.active_task === null) !== (execution.active_execution === null)) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "active_task and active_execution must both be set or both be null",
      });
    }
  });

export type Execution = z.infer<typeof ExecutionSchema>;

const RepositoryRelativePathSchema = z.string().min(1).refine(
  (value) =>
    !pathLikeAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    value !== ".rockspec" &&
    !value.startsWith(".rockspec/"),
  "Expected a normalized repository-relative product path outside .rockspec",
);

export const ReviewSubjectSchema = z
  .object({
    base_commit: GitCommitSchema,
    head_commit: GitCommitSchema,
    diff_hash: Sha256Schema,
  })
  .strict();

export type ReviewSubject = z.infer<typeof ReviewSubjectSchema>;

const InterfaceContractSchema = z.string().trim().min(1).max(500);

export const PlanDefinitionSchema = z
  .object({
    schema_version: z.literal(1),
    verification_only_scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).default([]),
  })
  .strict()
  .superRefine((plan, context) => {
    if (new Set(plan.verification_only_scenario_ids).size !== plan.verification_only_scenario_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["verification_only_scenario_ids"],
        message: "Verification-only Scenario IDs must be unique",
      });
    }
  });

export type PlanDefinition = z.infer<typeof PlanDefinitionSchema>;

const DesignDecisionCoverageSchema = z
  .object({
    id: z.string().regex(/^D-\d{3,}$/),
    requirement_ids: z.array(z.string().regex(/^R-\d{3,}$/)).min(1),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).default([]),
  })
  .strict()
  .superRefine((decision, context) => {
    for (const field of ["requirement_ids", "scenario_ids"] as const) {
      if (new Set(decision[field]).size !== decision[field].length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Design Decision ${field} values must be unique`,
        });
      }
    }
  });

export const DesignDefinitionSchema = z
  .object({
    schema_version: z.literal(1),
    inputs: z.object({ spec_hash: Sha256Schema }).strict(),
    decisions: z.array(DesignDecisionCoverageSchema).min(1),
  })
  .strict()
  .superRefine((design, context) => {
    const ids = design.decisions.map((decision) => decision.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "Design Decision IDs must be unique",
      });
    }
  });

export type DesignDefinition = z.infer<typeof DesignDefinitionSchema>;

export const PrototypeBriefDefinitionSchema = z
  .object({
    schema_version: z.literal(1),
    inputs: z.object({ spec_hash: Sha256Schema, design_hash: Sha256Schema }).strict(),
    requirement_ids: z.array(z.string().regex(/^R-\d{3,}$/)).min(1),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).min(1),
    decision_ids: z.array(z.string().regex(/^D-\d{3,}$/)).min(1),
  })
  .strict()
  .superRefine((brief, context) => {
    for (const field of ["requirement_ids", "scenario_ids", "decision_ids"] as const) {
      if (new Set(brief[field]).size !== brief[field].length) {
        context.addIssue({ code: "custom", path: [field], message: `Prototype ${field} values must be unique` });
      }
    }
  });

export type PrototypeBriefDefinition = z.infer<typeof PrototypeBriefDefinitionSchema>;

export const TaskDefinitionSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^T-\d{3,}$/),
    title: z.string().min(1),
    dependencies: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    supersedes: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    requirement_ids: z.array(z.string().regex(/^R-\d{3,}$/)).min(1),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).min(1),
    finding_ids: z.array(z.string().regex(/^F-\d{3,}$/)).default([]),
    acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
    consumes: z.array(InterfaceContractSchema).default([]),
    produces: z.array(InterfaceContractSchema).default([]),
    allowed_paths: z.array(RepositoryRelativePathSchema).min(1),
  })
  .strict()
  .superRefine((task, context) => {
    if (new Set(task.allowed_paths).size !== task.allowed_paths.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed_paths"],
        message: "Task allowed_paths must be unique",
      });
    }
    if (task.dependencies.includes(task.id)) {
      context.addIssue({
        code: "custom",
        path: ["dependencies"],
        message: "A Task cannot depend on itself",
      });
    }
    if (task.supersedes.includes(task.id)) {
      context.addIssue({
        code: "custom",
        path: ["supersedes"],
        message: "A Task cannot supersede itself",
      });
    }
    for (const field of ["dependencies", "supersedes", "requirement_ids", "scenario_ids", "finding_ids", "acceptance_criteria", "consumes", "produces"] as const) {
      if (new Set(task[field]).size !== task[field].length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Task ${field} values must be unique`,
        });
      }
    }
  });

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

export const TaskAttemptSchema = z
  .object({
    execution_id: z.string().min(1),
    status: z.enum(["suspended", "superseded"]),
    revision_id: z.string().regex(/^RV-\d{3,}$/),
    base_commit: GitCommitSchema,
    head_commit: GitCommitSchema,
    brief_path: z.string().min(1),
    brief_hash: Sha256Schema,
    report_path: z.string().min(1).optional(),
    report_hash: Sha256Schema.optional(),
    review_path: z.string().min(1).optional(),
    review_hash: Sha256Schema.optional(),
    review_subject: ReviewSubjectSchema.optional(),
    review_package_mode: z.enum(["product", "scope_blocked"]).optional(),
    review_attempts: z.number().int().nonnegative(),
    started_at: TimestampSchema.optional(),
    suspended_at: TimestampSchema,
  })
  .strict();

export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;

export const TaskRecordSchema = z
  .object({
    id: z.string().regex(/^T-\d{3,}$/, "Task ID must use T-001 format"),
    title: z.string().min(1).optional(),
    status: z.enum(TASK_STATUSES),
    dependencies: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    supersedes: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    requirement_ids: z.array(z.string().regex(/^R-\d{3,}$/)).default([]),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).default([]),
    finding_ids: z.array(z.string().regex(/^F-\d{3,}$/)).default([]),
    acceptance_criteria: z.array(z.string().min(1)).default([]),
    consumes: z.array(InterfaceContractSchema).default([]),
    produces: z.array(InterfaceContractSchema).default([]),
    allowed_paths: z.array(RepositoryRelativePathSchema).default([]),
    base_commit: GitCommitSchema.optional(),
    commit_sha: GitCommitSchema.optional(),
    execution_id: z.string().min(1).optional(),
    brief_path: z.string().min(1).optional(),
    brief_hash: Sha256Schema.optional(),
    report_path: z.string().min(1).optional(),
    report_hash: Sha256Schema.optional(),
    review_subject: ReviewSubjectSchema.optional(),
    review_package_mode: z.enum(["product", "scope_blocked"]).optional(),
    review_attempts: z.number().int().nonnegative().default(0),
    attempts: z.array(TaskAttemptSchema).default([]),
    started_at: TimestampSchema.optional(),
    completed_at: TimestampSchema.optional(),
    superseded_by: z.string().regex(/^T-\d{3,}$/).optional(),
    superseded_in_revision: z.string().regex(/^RV-\d{3,}$/).optional(),
    superseded_at: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.status === "completed" && task.commit_sha === undefined) {
      context.addIssue({
        code: "custom",
        path: ["commit_sha"],
        message: "A completed task must record its final commit",
      });
    }
    if (task.completed_at !== undefined && task.status !== "completed") {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "Only a completed task may have completed_at",
      });
    }
    const supersedeMetadata = [task.superseded_by, task.superseded_in_revision, task.superseded_at];
    if (task.status === "superseded" && supersedeMetadata.some((value) => value === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["superseded_by"],
        message: "A superseded Task must record replacement Task, Revision, and timestamp",
      });
    }
    if (task.status !== "superseded" && supersedeMetadata.some((value) => value !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["superseded_by"],
        message: "Only a superseded Task may record supersession metadata",
      });
    }
    if (
      task.started_at !== undefined &&
      task.completed_at !== undefined &&
      Date.parse(task.completed_at) < Date.parse(task.started_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "Task completion cannot precede its start",
      });
    }
  });

export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type Task = TaskRecord;

export const FindingSchema = z
  .object({
    id: z.string().regex(/^F-\d{3,}$/, "Finding ID must use F-001 format"),
    severity: z.enum(FINDING_SEVERITIES),
    category: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    evidence: z.string().min(1),
    description: z.string().min(1),
    owner_domain: z.enum([
      "requirements",
      "design",
      "planning",
      "implementation",
      "testing",
      "workflow",
    ]),
    route_to: ActionIdSchema,
    status: z.enum(["open", "resolved", "accepted"]),
    classification: RevisionClassificationSchema.default("decision_change"),
    authority_impact: AuthorityImpactSchema.default("unknown"),
  })
  .strict()
  .superRefine((finding, context) => {
    const allowed: Record<typeof finding.owner_domain, readonly (typeof ACTION_IDS)[number][]> = {
      requirements: ["requirements.clarify"],
      design: ["design.technical", "design.prototype"],
      planning: ["plan.create"],
      implementation: ["task.execute"],
      testing: ["task.execute", "acceptance.validate"],
      workflow: ACTION_IDS,
    };
    if (!allowed[finding.owner_domain].includes(finding.route_to)) {
      context.addIssue({
        code: "custom",
        path: ["route_to"],
        message: `Finding route_to ${finding.route_to} is incompatible with owner_domain ${finding.owner_domain}`,
      });
    }
    if ((finding.classification === "intent_change" || finding.classification === "decision_change" ||
        finding.classification === "risk_acceptance") && finding.authority_impact === "unchanged") {
      context.addIssue({
        code: "custom",
        path: ["authority_impact"],
        message: `${finding.classification} cannot declare unchanged authority`,
      });
    }
  });

export type Finding = z.infer<typeof FindingSchema>;

export const ReconciliationReviewDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    revision_id: z.string().regex(/^RV-\d{3,}$/),
    gate: ApprovalGateSchema,
    round: z.number().int().min(1),
    verdict: ReviewVerdictSchema,
    reviewer_execution_id: z.string().min(1).refine(
      (value) => !/^(?:TODO|UNKNOWN)$/i.test(value),
      "Reconciliation Review must identify the actual reviewer execution",
    ),
    classifications: z.array(RevisionClassificationSchema).min(1),
    authority_delta: AuthorityImpactSchema,
    finding_ids: z.array(z.string().regex(/^F-\d{3,}$/)).default([]),
    subject: z.object({
      artifact_hashes: z.record(z.string().min(1), Sha256Schema),
      aggregate_hash: Sha256Schema,
    }).strict(),
    findings: z.array(FindingSchema).default([]),
  })
  .strict()
  .superRefine((review, context) => {
    for (const field of ["classifications", "finding_ids"] as const) {
      if (new Set(review[field]).size !== review[field].length) {
        context.addIssue({ code: "custom", path: [field], message: `${field} values must be unique` });
      }
    }
    if (review.verdict === "PASS" && review.authority_delta !== "unchanged") {
      context.addIssue({ code: "custom", path: ["authority_delta"], message: "PASS requires unchanged authority" });
    }
    if (review.verdict === "PASS" && review.findings.some((finding) => finding.status === "open")) {
      context.addIssue({ code: "custom", path: ["findings"], message: "PASS cannot contain Open Findings" });
    }
    if (review.verdict !== "PASS" && !review.findings.some((finding) => finding.status === "open")) {
      context.addIssue({ code: "custom", path: ["findings"], message: "A non-PASS reconciliation must contain an Open Finding" });
    }
  });

export type ReconciliationReviewDocument = z.infer<typeof ReconciliationReviewDocumentSchema>;

export const ReviewSourceSchema = z
  .object({
    path: z.string().min(1),
    content_hash: Sha256Schema,
    reviewer_execution_id: z.string().min(1),
    verdict: ReviewVerdictSchema,
    findings: z.array(FindingSchema).default([]),
  })
  .strict();

export type ReviewSource = z.infer<typeof ReviewSourceSchema>;

export const ReviewDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    verdict: ReviewVerdictSchema,
    reviewer_execution_id: z.string().min(1).refine(
      (value) => !/^(?:TODO|UNKNOWN)$/i.test(value),
      "Review must identify the actual reviewer execution",
    ),
    subject: ReviewSubjectSchema,
    round: z.number().int().nonnegative().default(0),
    findings: z.array(FindingSchema).default([]),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.verdict === "PASS" &&
      review.findings.some(
        (finding) =>
          finding.status === "open" &&
          (finding.severity === "critical" || finding.severity === "important"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "PASS cannot contain open critical or important findings",
      });
    }
    if (
      review.verdict !== "PASS" &&
      !review.findings.some((finding) => finding.status === "open")
    ) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "A non-PASS Review must contain at least one open Finding",
      });
    }
  });

export type ReviewDocument = z.infer<typeof ReviewDocumentSchema>;

export const StageReviewDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    verdict: ReviewVerdictSchema,
    reviewer_execution_id: z.string().min(1).refine(
      (value) => !/^(?:TODO|UNKNOWN)$/i.test(value),
      "Stage Review must identify the actual reviewer execution",
    ),
    findings: z.array(FindingSchema).default([]),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.verdict === "PASS" &&
      review.findings.some(
        (finding) => finding.status === "open" &&
          (finding.severity === "critical" || finding.severity === "important"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "PASS cannot contain open critical or important Findings",
      });
    }
    if (review.verdict !== "PASS" && !review.findings.some((finding) => finding.status === "open")) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "A non-PASS Stage Review must contain at least one open Finding",
      });
    }
  });

export type StageReviewDocument = z.infer<typeof StageReviewDocumentSchema>;

export const AcceptanceDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    verdict: ReviewVerdictSchema,
    reviewer_execution_id: z.string().min(1).refine(
      (value) => !/^(?:TODO|UNKNOWN)$/i.test(value),
      "Acceptance must identify the actual reviewer execution",
    ),
    commit: GitCommitSchema,
    findings: z.array(FindingSchema).default([]),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.verdict === "PASS" && report.findings.some((finding) => finding.status === "open")) {
      context.addIssue({ code: "custom", path: ["verdict"], message: "PASS cannot contain Open Findings" });
    }
    if (report.verdict !== "PASS" && !report.findings.some((finding) => finding.status === "open")) {
      context.addIssue({ code: "custom", path: ["findings"], message: "A non-PASS Acceptance must contain an Open Finding" });
    }
  });

export type AcceptanceDocument = z.infer<typeof AcceptanceDocumentSchema>;

export const ReviewSchema = z
  .object({
    id: z.string().min(1).optional(),
    kind: z.enum(["requirements", "readiness", "task", "acceptance", "delivery"]).optional(),
    verdict: ReviewVerdictSchema,
    path: z.string().min(1),
    content_hash: Sha256Schema,
    report_hash: Sha256Schema.optional(),
    reviewer: z.string().min(1).optional(),
    reviewer_execution_ids: z.array(z.string().min(1)).default([]),
    subject: ReviewSubjectSchema.optional(),
    round: z.number().int().nonnegative().default(0),
    sources: z.array(ReviewSourceSchema).default([]),
    reviewed_at: TimestampSchema,
    findings: z.array(FindingSchema).default([]),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.verdict === "PASS" &&
      review.findings.some(
        (finding) =>
          finding.status === "open" &&
          (finding.severity === "critical" || finding.severity === "important"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "PASS cannot contain open critical or important findings",
      });
    }
  });

export type Review = z.infer<typeof ReviewSchema>;

export const EvidenceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    command: z.string().min(1),
    cwd: z.string().min(1),
    started_at: TimestampSchema,
    finished_at: TimestampSchema,
    exit_code: z.number().int(),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    commit: GitCommitSchema,
    task_id: z.string().regex(/^T-\d{3,}$/).optional(),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).default([]),
    finding_ids: z.array(z.string().regex(/^F-\d{3,}$/)).default([]),
    action_id: ActionIdSchema.optional(),
    report_path: z.string().min(1).optional(),
    output_hash: Sha256Schema.optional(),
    source: z.enum(["recorded", "executed"]).default("recorded"),
    artifact_paths: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (Date.parse(evidence.finished_at) < Date.parse(evidence.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["finished_at"],
        message: "Evidence finish time cannot precede its start time",
      });
    }
    if (evidence.exit_code === 0 && (evidence.failed ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["failed"],
        message: "Successful evidence cannot report failed checks",
      });
    }
  });

export type Evidence = z.infer<typeof EvidenceSchema>;

function pathLikeAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:\//.test(value);
}

export const VerificationSchema = z
  .object({
    status: z.enum(["pending", "passed", "failed"]),
    commit: GitCommitSchema.optional(),
    verified_at: TimestampSchema.optional(),
  })
  .strict();

export type Verification = z.infer<typeof VerificationSchema>;

export const KnowledgeUpdateSchema = z
  .object({
    target: z.string().min(1).refine(
      (value) =>
        /^(?:product|architecture|experience)\/.+\.md$/.test(value) &&
        !value.includes("\\") &&
        !value.split("/").includes(".."),
      "Knowledge targets must be normalized Markdown paths under product/, architecture/, or experience/",
    ),
    operation: z.enum(["new", "refine", "supersede"]),
    authority: z.enum(["derived", "normative"]),
    summary: z.string().trim().min(1),
    sources: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .superRefine((update, context) => {
    if (new Set(update.sources).size !== update.sources.length) {
      context.addIssue({ code: "custom", path: ["sources"], message: "Knowledge update sources must be unique" });
    }
  });

export type KnowledgeUpdate = z.infer<typeof KnowledgeUpdateSchema>;

export const KnowledgeDeltaDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    change_id: ChangeIdSchema,
    author_execution_id: z.string().min(1).refine(
      (value) => !/^(?:TODO|UNKNOWN)$/i.test(value),
      "Knowledge Delta must identify the actual author execution",
    ),
    outcome: z.enum(["no_change", "proposed"]),
    updates: z.array(KnowledgeUpdateSchema).default([]),
    approval: z.object({
      approved_by: z.string().min(1),
      approved_at: TimestampSchema,
    }).strict().optional(),
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.outcome === "no_change" && delta.updates.length !== 0) {
      context.addIssue({ code: "custom", path: ["updates"], message: "no_change cannot contain updates" });
    }
    if (delta.outcome === "proposed" && delta.updates.length === 0) {
      context.addIssue({ code: "custom", path: ["updates"], message: "proposed must contain at least one update" });
    }
    if (new Set(delta.updates.map((update) => update.target)).size !== delta.updates.length) {
      context.addIssue({ code: "custom", path: ["updates"], message: "Knowledge update targets must be unique" });
    }
    if (delta.updates.some((update) => update.authority === "normative") && !delta.approval) {
      context.addIssue({ code: "custom", path: ["approval"], message: "Normative knowledge updates require human approval" });
    }
  });

export type KnowledgeDeltaDocument = z.infer<typeof KnowledgeDeltaDocumentSchema>;

export const KnowledgeReviewSubjectSchema = z
  .object({
    source_digest: Sha256Schema,
    delta_hash: Sha256Schema,
    baseline_hashes: z.record(z.string().min(1), Sha256Schema.nullable()),
    candidate_hashes: z.record(z.string().min(1), Sha256Schema),
  })
  .strict();

export const KnowledgeReviewDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    verdict: ReviewVerdictSchema,
    reviewer_execution_id: z.string().min(1).refine(
      (value) => !/^(?:TODO|UNKNOWN)$/i.test(value),
      "Knowledge Review must identify the actual reviewer execution",
    ),
    subject: KnowledgeReviewSubjectSchema,
    findings: z.array(FindingSchema).default([]),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.verdict === "PASS" && review.findings.some((finding) => finding.status === "open")) {
      context.addIssue({ code: "custom", path: ["verdict"], message: "PASS cannot contain Open Findings" });
    }
    if (review.verdict !== "PASS" && !review.findings.some((finding) => finding.status === "open")) {
      context.addIssue({ code: "custom", path: ["findings"], message: "A non-PASS Knowledge Review requires an Open Finding" });
    }
  });

export type KnowledgeReviewDocument = z.infer<typeof KnowledgeReviewDocumentSchema>;

export const KnowledgeEvolutionUpdateSchema = KnowledgeUpdateSchema.extend({
  before_digest: Sha256Schema.nullable(),
  after_digest: Sha256Schema,
}).strict();

export const KnowledgeEvolutionSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    change_id: ChangeIdSchema.optional(),
    status: z.enum(["pending", "no_change", "approved", "applied"]),
    protocol_version: z.literal(1).default(1),
    source_digest: Sha256Schema.optional(),
    delta_path: z.string().min(1).optional(),
    delta_hash: Sha256Schema.optional(),
    updates: z.array(KnowledgeEvolutionUpdateSchema).default([]),
    review: z.object({
      reviewer_execution_id: z.string().min(1),
      report_path: z.string().min(1),
      report_hash: Sha256Schema,
    }).strict().optional(),
    approval: z.object({
      approved_by: z.string().min(1),
      approved_at: TimestampSchema,
    }).strict().optional(),
    recorded_at: TimestampSchema.optional(),
    applied_at: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((evolution, context) => {
    if (evolution.status === "pending") {
      const populated = [
        evolution.change_id,
        evolution.source_digest,
        evolution.delta_path,
        evolution.delta_hash,
        evolution.review,
        evolution.approval,
        evolution.recorded_at,
        evolution.applied_at,
      ].some((value) => value !== undefined) || evolution.updates.length > 0;
      if (populated) context.addIssue({ code: "custom", path: ["status"], message: "Pending evolution cannot contain a receipt" });
      return;
    }
    for (const field of ["change_id", "source_digest", "delta_path", "delta_hash", "recorded_at"] as const) {
      if (evolution[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `${field} is required after knowledge evolution` });
      }
    }
    if (evolution.status === "no_change" && evolution.updates.length !== 0) {
      context.addIssue({ code: "custom", path: ["updates"], message: "no_change receipt cannot contain updates" });
    }
    if (["approved", "applied"].includes(evolution.status) && evolution.updates.length === 0) {
      context.addIssue({ code: "custom", path: ["updates"], message: "Knowledge updates are required" });
    }
    if (["approved", "applied"].includes(evolution.status) && !evolution.review) {
      context.addIssue({ code: "custom", path: ["review"], message: "Knowledge updates require independent review" });
    }
    if (evolution.updates.some((update) => update.authority === "normative") && !evolution.approval) {
      context.addIssue({ code: "custom", path: ["approval"], message: "Normative knowledge updates require human approval" });
    }
    if (evolution.status === "applied" && !evolution.applied_at) {
      context.addIssue({ code: "custom", path: ["applied_at"], message: "Applied knowledge must record applied_at" });
    }
    if (evolution.status !== "applied" && evolution.applied_at) {
      context.addIssue({ code: "custom", path: ["applied_at"], message: "Only applied knowledge may record applied_at" });
    }
  });

export type KnowledgeEvolution = z.infer<typeof KnowledgeEvolutionSchema>;

export const ExternalRefSchema = z
  .object({
    system: z.string().min(1),
    type: z.string().min(1),
    id: z.string().min(1),
    url: z.url().optional(),
  })
  .strict();

export type ExternalRef = z.infer<typeof ExternalRefSchema>;

export const WorkspaceBindingSchema = z
  .object({
    mode: z.enum(["current", "worktree"]),
    branch: z.string().min(1).nullable(),
    managed: z.boolean(),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.mode === "current" && workspace.managed) {
      context.addIssue({
        code: "custom",
        path: ["managed"],
        message: "Only a linked Worktree may be managed by RockSpec",
      });
    }
  });

export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>;

export const ChangeSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    id: ChangeIdSchema,
    title: z.string().min(1),
    profile: WorkflowProfileSchema,
    state: ChangeStateSchema,
    base_ref: z.string().min(1).nullable(),
    base_commit: GitCommitSchema.nullable(),
    workspace: WorkspaceBindingSchema.nullable().default(null),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    external_refs: z.array(ExternalRefSchema).default([]),
    artifacts: z.record(z.string().min(1), ArtifactRecordSchema),
    approvals: ApprovalMapSchema,
    revisions: z.array(RevisionSchema).default([]),
    feedback_batches: z.array(FeedbackBatchSchema).default([]),
    prototype: PrototypeSchema,
    execution: ExecutionSchema,
    tasks: z.record(z.string().regex(/^T-\d{3,}$/), TaskRecordSchema),
    evidence: z.array(EvidenceSchema).default([]),
    reviews: z.record(z.string().min(1), ReviewSchema).default({}),
    verification: VerificationSchema.default({ status: "pending" }),
    knowledge_evolution: KnowledgeEvolutionSchema.default({
      schema_version: 1,
      status: "pending",
      protocol_version: 1,
      updates: [],
    }),
    completed_actions: z.array(ActionIdSchema).default([]),
    finished_at: TimestampSchema.optional(),
    delivery_head: GitCommitSchema.optional(),
    based_on_change: ChangeIdSchema.optional(),
    parent_delivery_head: GitCommitSchema.optional(),
    archived_at: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (Date.parse(snapshot.updated_at) < Date.parse(snapshot.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "Change update time cannot precede creation time",
      });
    }
    for (const [key, task] of Object.entries(snapshot.tasks)) {
      if (task.id !== key) {
        context.addIssue({
          code: "custom",
          path: ["tasks", key, "id"],
          message: `Task map key ${key} does not match task ID ${task.id}`,
        });
      }
    }
    if (
      snapshot.execution.active_task !== null &&
      snapshot.tasks[snapshot.execution.active_task] === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution", "active_task"],
        message: "Active task does not exist in the task map",
      });
    }
    if (snapshot.state === "ARCHIVED" && snapshot.archived_at === undefined) {
      context.addIssue({
        code: "custom",
        path: ["archived_at"],
        message: "An archived change must record archived_at",
      });
    }
    if (snapshot.revisions.filter((revision) => revision.status === "open").length > 1) {
      context.addIssue({ code: "custom", path: ["revisions"], message: "Only one Revision may be open at a time" });
    }
  });

export type ChangeSnapshot = z.infer<typeof ChangeSnapshotSchema>;

export const CapabilityBindingSchema = z
  .object({
    provider: z.string().min(1),
    distribution: z.enum(["bundled", "installed", "host"]).default("installed"),
  })
  .strict();

export const WorkspaceConfigSchema = z
  .object({
    mode: z.enum(["auto", "current", "worktree"]).default("auto"),
    directory: z.string().min(1).refine(
      (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
      "Workspace directory must be a normalized project-relative path",
    ).default(".worktrees"),
    branch_prefix: z.string().regex(/^[a-z][a-z0-9._/-]*\/$/).refine(
      (value) => !value.includes("..") && !value.includes("//"),
      "Workspace branch prefix must be normalized",
    ).default("rockspec/"),
    auto_create: z.boolean().default(false),
  })
  .strict();

export const ConfigSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    default_profile: WorkflowProfileSchema.default("standard"),
    capabilities: z.record(z.string().min(1), CapabilityBindingSchema).default({}),
    workspace: WorkspaceConfigSchema.default({
      mode: "auto",
      directory: ".worktrees",
      branch_prefix: "rockspec/",
      auto_create: false,
    }),
    max_review_rounds: z.number().int().min(1).max(10).optional(),
    max_reconciliation_rounds: z.number().int().min(1).max(5).default(2),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function parseChangeSnapshot(input: unknown): ChangeSnapshot {
  return parseProtocol(ChangeSnapshotSchema, input, "change snapshot");
}

export function safeParseChangeSnapshot(input: unknown): ValidationResult<ChangeSnapshot> {
  return safeParseProtocol(ChangeSnapshotSchema, input);
}

export function parseConfig(input: unknown): Config {
  return parseProtocol(ConfigSchema, input, "RockSpec config");
}

export function safeParseConfig(input: unknown): ValidationResult<Config> {
  return safeParseProtocol(ConfigSchema, input);
}
