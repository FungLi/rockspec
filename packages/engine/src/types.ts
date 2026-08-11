import type {
  ActionId,
  Approval,
  ArtifactRecord,
  ChangeSnapshot,
  ChangeState,
  Evidence,
  Prototype,
  Review,
  ReviewSubject,
  ReviewVerdict,
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
export type ReviewRecord = Review;
export type ReviewSubjectRecord = ReviewSubject;

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
  | "rockspec-finish";

export interface Recommendation {
  action: string;
  entry_skill: EntrySkill;
  reason: string;
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
}

export interface ValidationResult {
  valid: boolean;
  gate?: string;
  errors: BlockReason[];
  warnings: BlockReason[];
  status: StatusResult;
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
}

export interface NewChangeInput {
  id: string;
  title?: string;
  profile?: WorkflowProfile;
  baseRef?: string;
  prototypeRequired?: boolean;
  workspaceManaged?: boolean;
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
}

export interface ReviewPackageResult {
  kind: "task" | "delivery";
  task_id?: string;
  path: string;
  subject: ReviewSubjectRecord;
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
