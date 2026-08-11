import { z } from "zod";
import {
  ACTION_IDS,
  FINDING_SEVERITIES,
  PROFILES,
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
  })
  .strict();

export type Approval = z.infer<typeof ApprovalSchema>;

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

export const PrototypeStatusSchema = z.enum(["not_required", "pending", "completed"]);

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
    if (prototype.status === "completed" && prototype.provider === null) {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "A completed prototype must identify its provider",
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

export const TaskDefinitionSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^T-\d{3,}$/),
    title: z.string().min(1),
    dependencies: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    requirement_ids: z.array(z.string().regex(/^R-\d{3,}$/)).min(1),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).min(1),
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
    for (const field of ["dependencies", "requirement_ids", "scenario_ids", "acceptance_criteria", "consumes", "produces"] as const) {
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

export const TaskRecordSchema = z
  .object({
    id: z.string().regex(/^T-\d{3,}$/, "Task ID must use T-001 format"),
    title: z.string().min(1).optional(),
    status: z.enum(TASK_STATUSES),
    dependencies: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    requirement_ids: z.array(z.string().regex(/^R-\d{3,}$/)).default([]),
    scenario_ids: z.array(z.string().regex(/^S-\d{3,}$/)).default([]),
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
    review_attempts: z.number().int().nonnegative().default(0),
    started_at: TimestampSchema.optional(),
    completed_at: TimestampSchema.optional(),
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
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

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

export const ReviewSchema = z
  .object({
    id: z.string().min(1).optional(),
    kind: z.enum(["requirements", "readiness", "task", "delivery"]).optional(),
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
    prototype: PrototypeSchema,
    execution: ExecutionSchema,
    tasks: z.record(z.string().regex(/^T-\d{3,}$/), TaskRecordSchema),
    evidence: z.array(EvidenceSchema).default([]),
    reviews: z.record(z.string().min(1), ReviewSchema).default({}),
    verification: VerificationSchema.default({ status: "pending" }),
    completed_actions: z.array(ActionIdSchema).default([]),
    finished_at: TimestampSchema.optional(),
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
