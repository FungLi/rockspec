// 结论协议校验（P2）+ Finish 不变式（P4）。
import { z } from "zod";
import { isSha256 } from "./util.js";
import {
  CHECKER_ROLES,
  MAKER_ROLES,
  PROBLEM_OWNERS,
  VERDICTS,
  type CheckerConclusion,
  type Conclusion,
  type HookMark,
  type MakerConclusion,
  type WorklistProjection,
} from "./types.js";

const BlockerSchema = z.object({
  summary: z.string().min(1),
  detail: z.string().optional(),
});

const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["critical", "important", "minor"]),
  evidence: z.string().min(1),
  route_to: z.enum(MAKER_ROLES),
  description: z.string().optional(),
});

const TaskSpecSchema = z.object({
  artifact_id: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
});

export const MakerConclusionSchema = z.object({
  kind: z.literal("maker"),
  role: z.enum(MAKER_ROLES),
  artifact_id: z.string().min(1),
  output_path: z.string().min(1),
  output_hash: z.string().refine(isSha256, "output_hash 必须是 sha256:<64hex>"),
  self_report: z.string().min(1),
  blockers: z.array(BlockerSchema).default([]),
  registers: z.array(TaskSpecSchema).optional(),
});

export const CheckerConclusionSchema = z
  .object({
    kind: z.literal("checker"),
    role: z.enum(CHECKER_ROLES),
    artifact_id: z.string().min(1),
    subject_hash: z.string().refine(isSha256, "subject_hash 必须是 sha256:<64hex>"),
    hook_marks_seen: z.enum(["clean", "dirty", "absent"]),
    verdict: z.enum(VERDICTS),
    problem_owner: z.enum(PROBLEM_OWNERS).optional(),
    findings: z.array(FindingSchema).default([]),
  })
  .refine(
    (c) => c.verdict === "PASS" || c.findings.length > 0,
    "非 PASS 裁决必须至少包含一条 finding",
  )
  .refine(
    (c) => c.verdict !== "PASS" || !c.findings.some((f) => f.severity !== "minor"),
    "PASS 裁决不得包含 critical/important 的 open finding",
  );

export function parseMakerConclusion(raw: unknown): MakerConclusion {
  return MakerConclusionSchema.parse(raw) as MakerConclusion;
}

export function parseCheckerConclusion(raw: unknown): CheckerConclusion {
  return CheckerConclusionSchema.parse(raw) as CheckerConclusion;
}

export function parseConclusion(raw: unknown): Conclusion {
  if (typeof raw === "object" && raw !== null && (raw as { kind?: string }).kind === "checker") {
    return parseCheckerConclusion(raw);
  }
  return parseMakerConclusion(raw);
}

// ---------------------------------------------------------------------------
// subject_hash 绑定校验：制衡者看的产物必须是当前产物（根治「评审了旧版本 / 假 PASS」）
// ---------------------------------------------------------------------------

export interface HashBindingResult {
  ok: boolean;
  reason?: string;
}

export function verifyCheckerBinding(
  conclusion: CheckerConclusion,
  currentOutputHash: string | undefined,
): HashBindingResult {
  if (!currentOutputHash) {
    return { ok: false, reason: "产物尚无 output_hash，制衡者无可绑定对象" };
  }
  if (conclusion.subject_hash !== currentOutputHash) {
    return {
      ok: false,
      reason: `subject_hash(${conclusion.subject_hash.slice(0, 16)}…) 与当前产物(${currentOutputHash.slice(0, 16)}…)不匹配——拒绝登记，防评审旧版本`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Finish 不变式（唯一硬门，P4）
// ---------------------------------------------------------------------------

export interface FinishCheckItem {
  artifact_id: string;
  passed: boolean;
  reasons: string[];
}

export interface FinishCheckResult {
  ok: boolean;
  items: FinishCheckItem[];
}

/**
 * Finish 不变式：每个产物都必须
 *   制衡 PASS + hook mark clean + 制衡 subject_hash == 当前 output_hash。
 * 放漂级别 L3 下无语义制衡者，则只要求 hook clean（见 rigor 参数）。
 */
export function checkFinishInvariant(
  projection: WorklistProjection,
  getHookMark: (artifactId: string) => HookMark | undefined,
  getCheckerConclusion: (artifactId: string) => CheckerConclusion | undefined,
): FinishCheckResult {
  const rigor = projection.config.rigor;
  const items: FinishCheckItem[] = [];

  for (const item of projection.items) {
    const reasons: string[] = [];

    // 1. hook mark 必须 clean（所有档位都要求）
    const mark = getHookMark(item.artifact_id);
    if (!mark) reasons.push("缺少 hook mark");
    else if (!mark.clean) {
      const failed = mark.checks.filter((c) => c.status === "fail").map((c) => c.id);
      reasons.push(`hook 检测未通过：${failed.join(", ")}`);
    }

    // 2/3. 语义制衡（L1/L2 要求；L3 放漂不要求语义制衡者）
    const requiresChecker = rigor !== "L3" && checkerRequiredForItem(item, rigor);
    if (requiresChecker) {
      const conclusion = getCheckerConclusion(item.artifact_id);
      if (!conclusion) reasons.push("缺少制衡者 PASS 裁决");
      else {
        if (conclusion.verdict !== "PASS") reasons.push(`制衡裁决为 ${conclusion.verdict}`);
        if (item.output_hash && conclusion.subject_hash !== item.output_hash) {
          reasons.push("制衡 subject_hash 与当前产物不匹配");
        }
      }
    }

    items.push({ artifact_id: item.artifact_id, passed: reasons.length === 0, reasons });
  }

  return { ok: items.every((i) => i.passed), items };
}

/** L2 只对 APPLY 期（code）要求语义制衡；L1 全部要求。 */
function checkerRequiredForItem(
  item: WorklistProjection["items"][number],
  rigor: WorklistProjection["config"]["rigor"],
): boolean {
  if (rigor === "L1") return true;
  if (rigor === "L2") return item.phase === "apply";
  return false;
}
