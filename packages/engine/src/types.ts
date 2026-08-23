import type {
  ActionId,
  Approval,
  AuthorityImpact,
  ArtifactRecord,
  ChangeSnapshot,
  ChangeState,
  Evidence,
  FeedbackBatch,
  FeedbackInteractionMode,
  Finding,
  KnowledgeEvolution,
  Prototype,
  Review,
  ReviewSubject,
  ReviewVerdict,
  Revision,
  RevisionAmendment,
  RevisionClassification,
  RevisionKind,
  RevisionTarget,
  TaskRecord,
  TaskStatus,
  WorkflowProfile,
} from "@rockspec/protocol";

export type {
  ActionId,
  ArtifactRecord,
  ChangeSnapshot,
  ChangeState,
  ReviewVerdict,
  TaskRecord,
  TaskStatus,
  WorkflowProfile,
};

export type ApprovalGate = Approval["gate"];
export type ApprovalRecord = Approval;
export type PrototypeRecord = Prototype;
export type EvidenceRecord = Evidence;
export type FeedbackBatchRecord = FeedbackBatch;
export type ReviewRecord = Review;
export type ReviewSubjectRecord = ReviewSubject;
export type RevisionRecord = Revision;
export type RevisionAmendmentRecord = RevisionAmendment;
export type FindingRecord = Finding;

export type EntrySkill =
  | "rockspec-change"
  | "rockspec-triage"
  | "rockspec-requirements"
  | "rockspec-design"
  | "rockspec-prototype"
  | "rockspec-plan"
  | "rockspec-implement"
  | "rockspec-review"
  | "rockspec-acceptance"
  | "rockspec-evolve"
  | "rockspec-finish";

export interface Recommendation {
  action: string;
  entry_skill: EntrySkill;
  reason: string;
}

export interface RecoveryDirective {
  kind: "revision" | "action";
  review_id: string;
  source: ActionId;
  finding_ids: string[];
  route_to: ActionId[];
  target?: RevisionTarget;
  revision_kind?: RevisionKind;
  classifications?: RevisionClassification[];
  authority_delta?: AuthorityImpact;
  approval_policy?: "human" | "auto";
}

export interface AlternativeAction {
  action: string;
  reason?: string;
}

export interface BlockReason {
  code: string;
  message: string;
  paths?: string[];
}

export interface StatusResult {
  schema_version: 1;
  current_state: ChangeState;
  change: ChangeSnapshot;
  recommended_next: Recommendation | null;
  alternatives: AlternativeAction[];
  blocked_by: BlockReason[];
  allowed_actions: string[];
  recovery: RecoveryDirective | null;
}

export interface ValidationResult {
  valid: boolean;
  gate?: string;
  errors: BlockReason[];
  warnings: BlockReason[];
  status: StatusResult;
}

export interface ImplementationPreflightResult {
  schema_version: 1;
  valid: true;
  change_id: string;
  current_state: ChangeState;
  checked_at: string;
  task_count: number;
  ready_task_ids: string[];
  checks: Array<{
    id: "workspace" | "approvals" | "readiness" | "task_graph" | "recovery" | "review_modes";
    status: "passed";
    detail: string;
  }>;
  review_modes: ["product", "scope_blocked"];
}

export interface ValidateInput extends ChangeInput {
  gate?: string;
  strict?: boolean;
}

export interface GateInput extends ChangeInput {
  gate: string;
}

export interface InitResult {
  schema_version: 1;
  repository_root: string;
  rocks_root: string;
  created: boolean;
}

export interface EngineOptions {
  cwd?: string;
  now?: () => Date;
  availableProviders?: ReadonlySet<string>;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

export interface NewChangeInput {
  id: string;
  title?: string;
  profile?: WorkflowProfile;
  baseRef?: string;
  prototypeRequired?: boolean;
  workspaceManaged?: boolean;
  basedOnChange?: string;
  reuseWorkspace?: boolean;
  confirmBoundary?: boolean;
  changeId?: never;
}

export interface ChangeInput {
  changeId?: string;
}

export interface CompleteActionInput extends ChangeInput {
  action: ActionId;
  verdict?: ReviewVerdict;
}

export interface ApproveInput extends ChangeInput {
  gate: ApprovalGate;
  approvedBy?: string;
}

export interface PromoteInput extends ChangeInput {
  profile: Exclude<WorkflowProfile, "lite">;
}

export interface ReviseInput extends ChangeInput {
  source?: ActionId;
  target?: RevisionTarget;
  reason: string;
  affectedIds: string[];
  reviewId?: string;
  findingIds?: string[];
  classification?: RevisionClassification;
  authorityDelta?: AuthorityImpact;
  authorExecutionId?: string;
  feedbackBatchId?: string;
}

export interface FeedbackSubmitInput extends ChangeInput {
  route: "same_change" | "new_change";
  interactionMode?: FeedbackInteractionMode;
  reason: string;
  items: string[];
  target?: RevisionTarget;
  affectedIds?: string[];
  submittedBy?: string;
  relatedChangeId?: string;
  authorExecutionId?: string;
}

export type AmendRevisionInput = ReviseInput;

export interface ReconciliationInput extends ChangeInput {
  gate: ApprovalGate;
}

export interface CompleteReconciliationInput extends ReconciliationInput {
  verdict?: ReviewVerdict;
}

export interface ReconciliationPackageResult {
  revision_id: string;
  gate: ApprovalGate;
  round: number;
  author_execution_id: string;
  classifications: RevisionClassification[];
  finding_ids: string[];
  authority_basis_hash: string;
  report_path: string;
  subject: {
    artifact_hashes: Record<string, string>;
    aggregate_hash: string;
  };
}

export interface RecordEvidenceInput extends ChangeInput {
  kind?: string;
  command: string;
  cwd?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode: number;
  commit?: string;
  taskId?: string;
  actionId?: ActionId;
  reportPath?: string;
  outputHash?: string;
  source?: "recorded" | "executed";
}

export interface TaskInput extends ChangeInput {
  taskId: string;
}

export interface CompleteTaskInput extends TaskInput {
  commitSha?: string;
}

export interface TaskBriefResult {
  change_id: string;
  task_id: string;
  content: string;
  references: string[];
  path?: string;
  hash?: string;
  base_commit?: string;
}

export interface ReviewPackageInput extends ChangeInput {
  kind: "task" | "delivery";
  taskId?: string;
  mode?: "product" | "scope_blocked";
  scopeBlocked?: boolean;
}

export interface ReviewPackageResult {
  kind: "task" | "delivery";
  task_id?: string;
  mode?: "product" | "scope_blocked";
  scope?: {
    planned_paths: string[];
    changed_paths: string[];
    expanded_paths: string[];
  };
  path: string;
  subject: ReviewSubjectRecord;
}

export interface KnowledgePackageResult {
  change_id: string;
  already_evolved: boolean;
  status: KnowledgeEvolution["status"];
  source_digest: string;
  delta_path?: string;
  delta_hash?: string;
  baseline_hashes: Record<string, string | null>;
  candidate_hashes: Record<string, string>;
  review_path?: string;
  requires_human_approval: boolean;
}

export interface RunCheckInput extends ChangeInput {
  executable: string;
  args?: string[];
  kind?: string;
  taskId?: string;
  actionId?: ActionId;
}

export interface RunCheckResult extends StatusResult {
  check: {
    evidence_id: string;
    command: string;
    exit_code: number;
    output_hash: string;
    report_path: string;
  };
}

export interface FinishInput extends ChangeInput {
  disposition?: "local_merge" | "push" | "keep";
}

export interface ArchiveResult extends StatusResult {
  archive_path: string;
}

export interface EventRecord {
  schema_version: 1;
  sequence: number;
  event: string;
  change_id: string;
  occurred_at: string;
  previous_state: ChangeState;
  current_state: ChangeState;
  data: Record<string, unknown>;
}
