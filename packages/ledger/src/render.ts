// 人类可读渲染：worklist / resume 视图。
import type { FinishCheckResult, HookMark, WorklistProjection } from "./index.js";

export function renderWorklist(wl: WorklistProjection): string {
  const lines = [`Change: ${wl.change_id}  放漂: ${wl.config.rigor}${wl.finished ? "  [已完成]" : ""}${wl.archived ? "  [已归档]" : ""}`, ""];
  for (const item of wl.items) {
    const dep = item.depends_on.length ? `  依赖:${item.depends_on.join(",")}` : "";
    const v = item.last_verdict ? `  裁决:${item.last_verdict}` : "";
    lines.push(`- [${item.status}] ${item.artifact_id} (${item.phase}/${item.maker_role}→${item.checker_role})${dep}${v}  轮次:${item.attempts}`);
  }
  return lines.join("\n");
}

/** resume 视图：PM 跨压缩续接用——只给可操作的下一步骨架。 */
export function renderResume(wl: WorklistProjection): string {
  const lines = [`Change: ${wl.change_id}  放漂: ${wl.config.rigor}`, ""];
  const actionable = wl.items.filter((i) => !["passed"].includes(i.status));
  if (wl.finished) {
    lines.push("状态：已完成，待归档。");
  } else if (actionable.length === 0) {
    lines.push("状态：全部产物已 PASS，可执行 finish。");
  } else {
    lines.push("待处理项：");
    for (const item of actionable) {
      const hint = nextHint(item.status);
      lines.push(`- ${item.artifact_id} [${item.status}] → ${hint}`);
    }
  }
  const escalated = wl.items.filter((i) => i.status === "escalated");
  if (escalated.length) {
    lines.push("", "⚠ 待人裁决：", ...escalated.map((i) => `- ${i.artifact_id}`));
  }
  return lines.join("\n");
}

function nextHint(status: string): string {
  switch (status) {
    case "pending": return "dispatch 生产者（首次 BA/SA 走 inline）";
    case "making": return "等待生产者交结论";
    case "made": return "dispatch 制衡者评审";
    case "checking": return "等待制衡者交结论";
    case "blocked": return "隔离子 agent 返工（附 findings）";
    case "escalated": return "升级用户裁决";
    default: return "—";
  }
}

export function renderMark(mark: HookMark): string {
  const lines = [`Hook 检测：${mark.artifact_id}  ${mark.clean ? "✓ clean" : "✗ dirty"}`];
  for (const c of mark.checks) {
    lines.push(`  ${c.status === "pass" ? "✓" : "✗"} ${c.id}${c.detail ? `：${c.detail}` : ""}`);
  }
  return lines.join("\n");
}

export function renderFinishCheck(result: FinishCheckResult): string {
  const lines = [`Finish 不变式：${result.ok ? "✓ 通过" : "✗ 未通过"}`, ""];
  for (const item of result.items) {
    lines.push(`  ${item.passed ? "✓" : "✗"} ${item.artifact_id}${item.reasons.length ? `：${item.reasons.join("；")}` : ""}`);
  }
  return lines.join("\n");
}
