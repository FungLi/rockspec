// RockSpec Ledger 数据模型
// 依据 docs/proposals/pm-orchestration-rearchitecture.md
// 核心原则：仅追加事件日志 + 投影，无状态机推进。

/** 7 个真实角色（张乐老师 Harness Engineering 模型） */
export const ROLES = ["pm", "ba", "sa", "rr", "dev", "cr", "te"] as const;
export type Role = (typeof ROLES)[number];

/** 生产者角色：产出工作产物 */
export const MAKER_ROLES = ["ba", "sa", "dev"] as const;
export type MakerRole = (typeof MAKER_ROLES)[number];

/** 制衡者角色：独立评审/测试 */
export const CHECKER_ROLES = ["rr", "cr", "te"] as const;
export type CheckerRole = (typeof CHECKER_ROLES)[number];

/** 两阶段边界 */
export const PHASES = ["propose", "apply"] as const;
export type Phase = (typeof PHASES)[number];

/** 产物类型 */
export const ARTIFACT_KINDS = [
  "requirements", // BA 产出
  "design", // SA 产出
  "code", // Dev 产出
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Worklist 项状态 */
export const ITEM_STATUSES = [
  "pending", // 待生产
  "making", // 生产中（inline 共创或隔离子 agent）
  "made", // 已产出，待制衡
  "checking", // 制衡中
  "passed", // 制衡 PASS
  "blocked", // 被制衡驳回，待返工
  "escalated", // 冲突升级人裁决
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** 制衡裁决 */
export const VERDICTS = ["PASS", "REJECT"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 问题归属（PM 据此路由打回） */
export const PROBLEM_OWNERS = [
  "ba",
  "sa",
  "dev",
  "te",
  "upstream-contract", // 需求/契约层问题 → 升级或回 SA/BA
] as const;
export type ProblemOwner = (typeof PROBLEM_OWNERS)[number];

/** 模型档位 */
export const MODEL_TIERS = ["fast", "balanced", "deep"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** 放漂级别 */
export const RIGOR_LEVELS = ["L1", "L2", "L3"] as const;
export type RigorLevel = (typeof RIGOR_LEVELS)[number];

// ---------------------------------------------------------------------------
// Hook mark：确定性检测结果
// ---------------------------------------------------------------------------

export interface HookCheck {
  id: string; // 检测规则 ID，如 "schema"、"design-sections"
  status: "pass" | "fail";
  detail?: string; // 失败原因
}

export interface HookMark {
  artifact_id: string;
  artifact_hash: string; // 检测时的产物 hash
  checks: HookCheck[];
  clean: boolean; // 全部 pass 为 true
  marked_at: string; // ISO 时间戳
}

// ---------------------------------------------------------------------------
// 结论协议
// ---------------------------------------------------------------------------

export interface Blocker {
  summary: string; // 无法自决的冲突描述
  detail?: string;
}

/** 生产者结论 */
export interface MakerConclusion {
  kind: "maker";
  role: MakerRole;
  artifact_id: string;
  output_path: string;
  output_hash: string;
  self_report: string;
  blockers: Blocker[]; // 非空 → PM 升级人裁决
}

export interface Finding {
  id: string;
  severity: "critical" | "important" | "minor";
  evidence: string;
  route_to: MakerRole; // 打回给谁
  description?: string;
}

/** 制衡者结论 */
export interface CheckerConclusion {
  kind: "checker";
  role: CheckerRole;
  artifact_id: string;
  subject_hash: string; // 必须 == 生产者 output_hash
  hook_marks_seen: "clean" | "dirty" | "absent";
  verdict: Verdict;
  problem_owner?: ProblemOwner;
  findings: Finding[]; // 非 PASS 必须非空
}

export type Conclusion = MakerConclusion | CheckerConclusion;

// ---------------------------------------------------------------------------
// Worklist 项
// ---------------------------------------------------------------------------

export interface WorklistItem {
  artifact_id: string;
  kind: ArtifactKind;
  phase: Phase;
  maker_role: MakerRole;
  checker_role: CheckerRole;
  status: ItemStatus;
  depends_on: string[]; // 依赖的其他 artifact_id
  output_hash?: string; // 最新产出 hash
  last_verdict?: Verdict;
  attempts: number; // 生产轮次（首次=0，返工递增）
}

// ---------------------------------------------------------------------------
// 事件（仅追加日志）
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "change.created",
  "item.registered",
  "item.making", // 进入生产（记录 inline|subagent 模式）
  "maker.concluded", // 生产者交结论
  "hook.marked", // hook 检测完成
  "item.checking",
  "checker.concluded", // 制衡者交结论
  "item.blocked",
  "item.escalated",
  "item.passed",
  "change.finished",
  "change.archived",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface LedgerEvent {
  seq: number; // 单调递增
  type: EventType;
  at: string; // ISO 时间戳
  artifact_id?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Change 元数据 + 投影
// ---------------------------------------------------------------------------

export interface ChangeConfig {
  rigor: RigorLevel; // 放漂级别
}

export interface ChangeMeta {
  id: string;
  created_at: string;
  config: ChangeConfig;
  finished_at?: string;
  archived_at?: string;
}

/** 从事件日志投影出的当前全景 */
export interface WorklistProjection {
  change_id: string;
  config: ChangeConfig;
  items: WorklistItem[];
  finished: boolean;
  archived: boolean;
}
