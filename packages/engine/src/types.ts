import type {
  ActionId,
  Approval,
  AuthorityImpact,
  ArtifactRecord,
  ChangeSnapshot,
  ChangeState,
  ChangeKind,
  Evidence,
  EnvironmentPreflightCheck,
  FeedbackBatch,
  FeedbackInteractionMode,
  ExecutionRole,
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
  UatPolicy,
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
export type EnvironmentCheck = EnvironmentPreflightCheck;
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
  expected?: string;
  received?: string;
  allowed?: string[];
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
  artifact?: string;
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
    id: "workspace" | "approvals" | "readiness" | "task_graph" | "recovery" | "review_modes" | "environment";
    status: "passed";
    detail: string;
  }>;
  review_modes: ["product", "scope_blocked", "historical_attribution"];
}

export interface ValidateInput extends ChangeInput {
  gate?: string;
  artifactPath?: string;
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
  kind?: ChangeKind;
  riskTags?: string[];
  baseRef?: string;
  prototypeRequired?: boolean;
  uatPolicy?: UatPolicy;
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
  packageHash: string;
}

export interface PrepareApprovalInput extends ChangeInput {
  gate: ApprovalGate;
}

export interface ApprovalPackageResult {
  schema_version: 1;
  gate: ApprovalGate;
  path: string;
  hash: string;
  artifact_hashes: Record<string, string>;
  aggregate_hash: string;
  summary: {
    non_goals: string[];
    assumptions: Array<{ id: string; description: string; basis: string; impact_if_wrong: string }>;
    open_questions: Array<{ id: string; question: string; impact: string; status: "blocking" | "non_blocking" | "resolved" }>;
    requirement_ids: string[];
    scenario_ids: string[];
    decision_ids: string[];
    task_ids: string[];
  };
  review_summary: {
    language: "zh-CN" | "en-US";
    title: string;
    approval_prompt: string;
    machine_receipt_note: string;
    artifact_root: string;
    artifacts: Array<{ label: string; path: string; relative_path: string; description: string }>;
    sections: Array<{ title: string; items: string[] }>;
  };
}

export interface StartExecutionInput extends ChangeInput {
  action: string;
  role: ExecutionRole;
  modelTier?: "fast" | "balanced" | "deep";
  hostModel?: string;
  parentExecutionId?: string;
  contextPackagePath?: string;
  contextPackageHash?: string;
}

export interface ExecutionStartResult extends StatusResult {
  started_execution: {
    id: string;
    action: string;
    role: ExecutionRole;
  };
}

export interface CompleteExecutionInput extends ChangeInput {
  executionId: string;
  outcome?: "success" | "error" | "cancelled";
  usage?: ExecutionUsage;
}

export interface ExecutionUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
}

export interface ExecutionCompleteResult extends StatusResult {
  completed_execution: {
    id: string;
    outcome: "success" | "error" | "cancelled";
    duration_ms: number;
    already_completed: boolean;
  };
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
  /** @internal Consume the current Engine recovery without caller-supplied Review bindings. */
  consumeCurrentRecovery?: boolean;
}

export interface ApplyRecoveryInput extends ChangeInput {
  affectedIds?: string[];
  reason?: string;
  authorExecutionId?: string;
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
  scenarioIds?: string[];
  findingIds?: string[];
  artifactPaths?: string[];
}

export interface CompleteUatInput extends ChangeInput {
  reportPath?: string;
}

export interface TaskInput extends ChangeInput {
  taskId: string;
}

export interface StartTaskInput extends TaskInput {
  modelTier?: "fast" | "balanced" | "deep";
  hostModel?: string;
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
  mode?: "product" | "scope_blocked" | "historical_attribution";
  scope?: {
    planned_paths: string[];
    changed_paths: string[];
    expanded_paths: string[];
  };
  path: string;
  hash: string;
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
  review_required: boolean;
  review_path?: string;
  requires_human_approval: boolean;
  semantic_warnings: Array<{
    code: "POSSIBLE_NORMATIVE_MODAL_CHANGE";
    target: string;
    message: string;
    before_markers: string[];
    after_markers: string[];
  }>;
}

export interface RunCheckInput extends ChangeInput {
  executable: string;
  args?: string[];
  kind?: string;
  taskId?: string;
  actionId?: ActionId;
  scenarioIds?: string[];
  findingIds?: string[];
  artifactPaths?: string[];
  reuseCachedEvidence?: boolean;
}

export interface RunCheckResult extends StatusResult {
  check: {
    evidence_id: string;
    command: string;
    exit_code: number;
    output_hash: string;
    report_path: string;
    cached: boolean;
  };
}

export interface FinishInput extends ChangeInput {
  disposition?: "local_merge" | "push" | "keep";
  executed?: boolean;
  resultRef?: string;
  resultCommit?: string;
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

export interface RuntimeTelemetryRecord {
  schema_version: 1;
  invocation_id: string;
  command: string;
  change_id?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  result: "success" | "error";
  error_code?: string;
  internal_error: boolean;
  response_bytes: number;
}

export interface RuntimeTelemetrySummary {
  schema_version: 1;
  source_path: string;
  change_id?: string;
  record_count: number;
  success_count: number;
  error_count: number;
  internal_error_count: number;
  total_duration_ms: number;
  first_started_at: string | null;
  last_finished_at: string | null;
  by_command: Record<string, {
    count: number;
    success_count: number;
    error_count: number;
    duration_ms: number;
    response_bytes: number;
  }>;
  by_error_code: Record<string, number>;
  agent_executions: {
    total_count: number;
    completed_count: number;
    incomplete_count: number;
    total_duration_ms: number;
    by_role: Record<string, {
      count: number;
      completed_count: number;
      success_count: number;
      error_count: number;
      cancelled_count: number;
      unknown_count: number;
      duration_ms: number;
    }>;
  };
  human_approval_wait: {
    count: number;
    total_duration_ms: number;
    by_gate: Record<string, { count: number; duration_ms: number }>;
  };
  token_usage: {
    execution_count: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    by_role: Record<string, {
      execution_count: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
    }>;
  };
}

export interface AcceptancePreflightResult extends StatusResult {
  valid: true;
  checks: Array<{ id: "state" | "execution" | "report" | "scenarios" | "evidence"; status: "passed"; detail: string }>;
}

export interface EnvironmentPreflightResult extends StatusResult {
  valid: boolean;
  checks: Array<{
    id: string;
    kind: "database" | "browser" | "credential" | "custom";
    required: boolean;
    status: "passed" | "failed" | "skipped";
    duration_ms: number;
    detail: string;
  }>;
}
