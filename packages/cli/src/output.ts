import type { StatusResult } from "@rockspec/engine";

export const CLI_SCHEMA_VERSION = 1 as const;

export const STATUS_VIEWS = ["summary", "resume", "tasks", "recovery", "hashes", "full"] as const;
export type StatusView = (typeof STATUS_VIEWS)[number];

export interface CliSuccess<T> {
  schema_version: typeof CLI_SCHEMA_VERSION;
  ok: true;
  command: string;
  data: T;
}

export interface CliFailure {
  schema_version: typeof CLI_SCHEMA_VERSION;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details: unknown;
    retryable: boolean;
    state_changed: boolean;
    recovery_command: string | null;
    recommended_next: unknown;
  };
}

export function successEnvelope<T>(command: string, data: T): CliSuccess<T> {
  return { schema_version: CLI_SCHEMA_VERSION, ok: true, command, data };
}

export function failureEnvelope(command: string, error: unknown): CliFailure {
  const candidate = asErrorRecord(error);
  const code = typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
  const details = candidate.details ?? candidate.issues ?? null;
  const detailRecord = isRecord(details) ? details : {};
  const changeId = typeof detailRecord.change_id === "string" ? detailRecord.change_id : undefined;
  const recoverApplyCodes = new Set([
    "RECOVERY_TRIGGER_MISMATCH",
    "RECOVERY_SOURCE_MISMATCH",
    "RECOVERY_TARGET_MISMATCH",
    "REVISION_AMENDMENT_FINDING_REQUIRED",
    "REVISION_AUTHOR_REQUIRED",
  ]);
  const changeIdForRecovery = changeId ?? "[change-id]";
  const recommendedCommandByCode: Record<string, string> = {
    EXECUTION_ALREADY_ACTIVE: `rockspec execution complete ${String(detailRecord.execution_id ?? "[execution-id]")} ${changeIdForRecovery} --outcome success`,
    ENVIRONMENT_PREFLIGHT_FAILED: `rockspec preflight environment ${changeIdForRecovery}`,
    ACCEPTANCE_PREFLIGHT_REQUIRED: `rockspec preflight acceptance ${changeIdForRecovery}`,
    COMPLETED_TASK_IMMUTABLE: `rockspec action complete plan.create ${changeIdForRecovery}  # append a new Remediation Task; keep completed Tasks unchanged`,
    SUSPENDED_TASK_IMMUTABLE: `rockspec action complete plan.create ${changeIdForRecovery}  # append a new Replacement Task; keep suspended Tasks unchanged`,
    RECOVERY_PLAN_APPEND_ONLY: `rockspec action complete plan.create ${changeIdForRecovery}  # restore immutable Tasks and append a new Finding-bound Task`,
    UNASSIGNED_PRODUCT_COMMIT: `rockspec action complete plan.create ${changeIdForRecovery}  # attach the repair to a Remediation Task`,
    UNASSIGNED_PRODUCT_COMMIT_REVIEW_REQUIRED: `rockspec action complete delivery.review ${changeIdForRecovery} --verdict CHANGES_REQUIRED`,
  };
  const recoveryCommand = typeof candidate.recovery_command === "string"
    ? candidate.recovery_command
    : recommendedCommandByCode[code]
      ? recommendedCommandByCode[code]
    : recoverApplyCodes.has(code)
      ? `rockspec recover apply${changeId ? ` ${changeId}` : " [change-id]"}`
      : null;
  return {
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code,
      message:
        typeof candidate.message === "string" ? candidate.message : "An unexpected error occurred",
      details,
      retryable: candidate.retryable === true || code === "LOCK_TIMEOUT",
      state_changed: candidate.state_changed === true,
      recovery_command: recoveryCommand,
      recommended_next: candidate.recommended_next ?? detailRecord.recommended_next ?? null,
    },
  };
}

export function projectStatus(status: StatusResult, view: StatusView): unknown {
  if (view === "full") return status;
  const common = {
    schema_version: status.schema_version,
    view,
    current_state: status.current_state,
    change_id: status.change.id,
    recommended_next: status.recommended_next,
    blocked_by: status.blocked_by,
    recovery: status.recovery,
  };
  if (view === "resume") {
    const openExecutions = status.change.execution.registry
      .filter((execution) => !execution.completed_at)
      .map((execution) => ({
        id: execution.id,
        role: execution.role,
        action: execution.action,
        started_at: execution.started_at,
        context_package_path: execution.context_package_path,
      }));
    const openFindings = Object.entries(status.change.reviews).flatMap(([reviewId, review]) =>
      review.findings
        .filter((finding) => finding.status === "open")
        .map((finding) => ({
          review_id: reviewId,
          id: finding.id,
          severity: finding.severity,
          owner_domain: finding.owner_domain,
          route_to: finding.route_to,
          description: finding.description,
        })),
    );
    return {
      ...common,
      workspace: status.change.workspace,
      commits: {
        base: status.change.base_commit,
        delivery: status.change.delivery_head,
        verified: status.change.verification.commit,
      },
      approvals: Object.fromEntries(Object.entries(status.change.approvals).map(([gate, approval]) => [
        gate,
        approval ? { approved_at: approval.approved_at, mode: approval.mode } : null,
      ])),
      active_task: status.change.execution.active_task,
      remaining_tasks: Object.values(status.change.tasks)
        .filter((task) => !["completed", "superseded"].includes(task.status))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => ({ id: task.id, title: task.title, status: task.status, dependencies: task.dependencies })),
      open_executions: openExecutions,
      open_findings: openFindings,
      artifacts: Object.fromEntries(Object.entries(status.change.artifacts).map(([name, artifact]) => [name, artifact.path])),
      finish_disposition: status.change.finish_disposition ?? null,
      resume_note: "以本快照恢复 Engine 已持久化状态；只需额外补充未写入产物的用户口头约束和决策意图。",
    };
  }
  if (view === "tasks") {
    return {
      ...common,
      active_task: status.change.execution.active_task,
      tasks: Object.values(status.change.tasks)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          dependencies: task.dependencies,
          supersedes: task.supersedes,
          finding_ids: task.finding_ids,
          adopted_commit: task.adopted_commit,
          base_commit: task.base_commit,
          commit_sha: task.commit_sha,
        })),
    };
  }
  if (view === "recovery") {
    const openRevision = status.change.revisions.find((revision) => revision.status === "open");
    const feedbackBatch = openRevision?.mode === "feedback_reopen"
      ? status.change.feedback_batches.find((batch) => batch.revision_id === openRevision.id)
      : undefined;
    const review = status.recovery ? status.change.reviews[status.recovery.review_id] : undefined;
    return {
      ...common,
      open_revision: openRevision ? {
        id: openRevision.id,
        source: openRevision.source,
        target: openRevision.target,
        kind: openRevision.kind,
        mode: openRevision.mode,
        interaction_mode: openRevision.interaction_mode ?? feedbackBatch?.interaction_mode ??
          (openRevision.mode === "feedback_reopen" ? "compact" : undefined),
        classifications: openRevision.classifications,
        authority_delta: openRevision.authority_delta,
        approval_policy: openRevision.approval_policy,
        gate_policies: openRevision.gate_policies,
        convergence_round: openRevision.convergence_round,
      } : null,
      open_findings: review?.findings
        .filter((finding) => finding.status === "open")
        .map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          category: finding.category,
          owner_domain: finding.owner_domain,
          route_to: finding.route_to,
          classification: finding.classification,
          authority_impact: finding.authority_impact,
        })) ?? [],
    };
  }
  if (view === "hashes") {
    return {
      ...common,
      artifacts: Object.fromEntries(Object.entries(status.change.artifacts).map(([name, artifact]) => [
        name,
        { path: artifact.path, hash: artifact.hash, updated_at: artifact.updated_at },
      ])),
      approvals: Object.fromEntries(Object.entries(status.change.approvals).map(([gate, approval]) => [
        gate,
        approval ? {
          aggregate_hash: approval.aggregate_hash,
          authority_basis_hash: approval.authority_basis_hash,
          approved_at: approval.approved_at,
          mode: approval.mode,
        } : null,
      ])),
      reviews: Object.fromEntries(Object.entries(status.change.reviews).map(([id, review]) => [
        id,
        {
          verdict: review.verdict,
          content_hash: review.content_hash,
          report_hash: review.report_hash,
          subject: review.subject,
          reviewed_at: review.reviewed_at,
        },
      ])),
    };
  }
  return {
    ...common,
    change: {
      id: status.change.id,
      title: status.change.title,
      profile: status.change.profile,
      state: status.change.state,
      base_ref: status.change.base_ref,
      base_commit: status.change.base_commit,
      workspace: status.change.workspace,
      updated_at: status.change.updated_at,
      execution: status.change.execution,
      prototype: {
        required: status.change.prototype.required,
        provider: status.change.prototype.provider,
        status: status.change.prototype.status,
      },
      verification: status.change.verification,
      knowledge_evolution: { status: status.change.knowledge_evolution.status },
      task_counts: Object.values(status.change.tasks).reduce<Record<string, number>>((counts, task) => {
        counts[task.status] = (counts[task.status] ?? 0) + 1;
        return counts;
      }, {}),
    },
    allowed_actions: status.allowed_actions,
  };
}

export function isFullStatusResult(value: unknown): value is StatusResult {
  if (!isRecord(value) || value.view !== undefined || !isRecord(value.change)) return false;
  return value.schema_version === 1 &&
    typeof value.current_state === "string" &&
    Array.isArray(value.alternatives) &&
    Array.isArray(value.blocked_by) &&
    Array.isArray(value.allowed_actions) &&
    "recommended_next" in value &&
    "recovery" in value;
}

export function errorExitCode(error: unknown): number {
  const value = asErrorRecord(error).exitCode;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

export function formatHuman(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (!isRecord(data)) {
    return JSON.stringify(data, null, 2);
  }

  const approvalSummary = isRecord(data.review_summary) ? data.review_summary : undefined;
  if (approvalSummary) {
    const zh = stringValue(approvalSummary.language) !== "en-US";
    const lines: string[] = [];
    lines.push(`【${stringValue(approvalSummary.title) ?? (zh ? "审批" : "Approval")}】`);
    const sections = Array.isArray(approvalSummary.sections) ? approvalSummary.sections : [];
    for (const section of sections) {
      if (!isRecord(section)) continue;
      lines.push("", `${stringValue(section.title) ?? (zh ? "摘要" : "Summary")}${zh ? "：" : ":"}`);
      for (const item of Array.isArray(section.items) ? section.items : []) {
        if (typeof item !== "string") continue;
        const itemLines = item.split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (itemLines.length === 0) continue;
        lines.push(`- ${itemLines[0]}`);
        for (const line of itemLines.slice(1)) lines.push(`  ${line}`);
      }
    }
    lines.push("", zh ? "正式评审材料" : "Formal Review Materials");
    const artifactRoot = stringValue(approvalSummary.artifact_root);
    if (artifactRoot) {
      lines.push(`${zh ? "目录" : "Directory"}${zh ? "：" : ":"}`, `  ${artifactRoot}/`);
    }
    const artifacts = Array.isArray(approvalSummary.artifacts) ? approvalSummary.artifacts : [];
    for (const [index, artifact] of artifacts.entries()) {
      if (!isRecord(artifact)) continue;
      const label = stringValue(artifact.label);
      const artifactPath = stringValue(artifact.relative_path) ?? stringValue(artifact.path);
      const description = stringValue(artifact.description);
      if (!label || !artifactPath) continue;
      lines.push("", `${index + 1}. ${label}`);
      lines.push(`   ${zh ? "文件" : "File"}${zh ? "：" : ":"}${artifactPath}`);
      if (description) lines.push(`   ${zh ? "说明" : "Description"}${zh ? "：" : ":"}${description}`);
    }
    const prompt = stringValue(approvalSummary.approval_prompt);
    if (prompt) lines.push("", prompt);
    const hash = stringValue(data.hash);
    const receiptNote = stringValue(approvalSummary.machine_receipt_note);
    if (hash) lines.push("", `${zh ? "机器凭证" : "Machine Receipt"}${zh ? "：" : ":"}${hash}${receiptNote ? `（${receiptNote}）` : ""}`);
    const packagePath = stringValue(data.path);
    if (packagePath) lines.push(`${zh ? "凭证包" : "Receipt Package"}${zh ? "：" : ":"}${packagePath}`);
    return lines.join("\n");
  }

  if (data.view === "resume") {
    const lines = [
      `Change：${stringValue(data.change_id) ?? "-"}`,
      `状态：${stringValue(data.current_state) ?? "-"}`,
    ];
    const next = isRecord(data.recommended_next) ? data.recommended_next : undefined;
    if (next) {
      const action = stringValue(next.action);
      const reason = stringValue(next.reason);
      if (action) lines.push(`下一步：${action}${reason ? `（${reason}）` : ""}`);
    }
    const workspace = isRecord(data.workspace) ? data.workspace : undefined;
    if (workspace) lines.push(`工作区：${stringValue(workspace.mode) ?? "-"} / ${stringValue(workspace.branch) ?? "detached"}`);
    const commits = isRecord(data.commits) ? data.commits : undefined;
    if (commits) {
      lines.push(`提交：base=${stringValue(commits.base) ?? "-"} delivery=${stringValue(commits.delivery) ?? "-"} verified=${stringValue(commits.verified) ?? "-"}`);
    }
    appendResumeItems(lines, "剩余 Task", data.remaining_tasks, (item) => {
      const id = stringValue(item.id) ?? "-";
      return `${id} ${stringValue(item.title) ?? ""} [${stringValue(item.status) ?? "unknown"}]`.trim();
    });
    appendResumeItems(lines, "开放 Finding", data.open_findings, (item) =>
      `${stringValue(item.id) ?? "-"} ${stringValue(item.description) ?? ""} -> ${stringValue(item.route_to) ?? "-"}`.trim());
    appendResumeItems(lines, "未完成 Execution", data.open_executions, (item) =>
      `${stringValue(item.id) ?? "-"} ${stringValue(item.role) ?? "-"} / ${stringValue(item.action) ?? "-"}`);
    const disposition = isRecord(data.finish_disposition) ? data.finish_disposition : undefined;
    if (disposition) {
      lines.push("", "收尾处置：", `- ${stringValue(disposition.choice) ?? "-"} / ${stringValue(disposition.status) ?? "-"}`);
      const pending = stringValue(disposition.pending_action);
      if (pending) lines.push(`  ${pending}`);
    }
    const note = stringValue(data.resume_note);
    if (note) lines.push("", note);
    return lines.join("\n");
  }

  if (typeof data.artifact === "string" && data.valid === true) {
    return `${data.artifact} 校验通过`;
  }

  const lines: string[] = [];
  const change = isRecord(data.change) ? data.change : data;
  const id = stringValue(change.id) ?? stringValue(data.change_id);
  const state = stringValue(data.current_state) ?? stringValue(change.state);
  const profile = stringValue(change.profile);

  if (id) lines.push(`Change: ${id}`);
  if (profile) lines.push(`Profile: ${profile}`);
  if (state) lines.push(`State: ${state}`);

  const next = isRecord(data.recommended_next) ? data.recommended_next : undefined;
  if (next) {
    const action = stringValue(next.action);
    const reason = stringValue(next.reason);
    if (action) lines.push(`Next: ${action}${reason ? ` - ${reason}` : ""}`);
  }

  const recovery = isRecord(data.recovery) ? data.recovery : undefined;
  if (recovery) {
    const kind = stringValue(recovery.kind);
    const reviewId = stringValue(recovery.review_id);
    const target = stringValue(recovery.target);
    const approvalPolicy = stringValue(recovery.approval_policy);
    const authorityDelta = stringValue(recovery.authority_delta);
    const findingIds = Array.isArray(recovery.finding_ids)
      ? recovery.finding_ids.filter((value): value is string => typeof value === "string")
      : [];
    lines.push(
      `Recovery: ${kind ?? "required"}${target ? ` -> ${target}` : ""}` +
      `${reviewId ? ` from ${reviewId}` : ""}${findingIds.length > 0 ? ` [${findingIds.join(", ")}]` : ""}`,
    );
    if (approvalPolicy) {
      lines.push(`Approval: ${approvalPolicy}${authorityDelta ? ` (${authorityDelta})` : ""}`);
    }
  }

  const blocked = Array.isArray(data.blocked_by) ? data.blocked_by : [];
  for (const item of blocked) {
    if (typeof item === "string") lines.push(`Blocked: ${item}`);
    else if (isRecord(item)) lines.push(`Blocked: ${stringValue(item.message) ?? JSON.stringify(item)}`);
  }

  const semanticWarnings = Array.isArray(data.semantic_warnings) ? data.semantic_warnings : [];
  if (semanticWarnings.length > 0) {
    lines.push("", "语义提示（不阻断）：");
    for (const item of semanticWarnings) {
      if (!isRecord(item)) continue;
      lines.push(`- ${stringValue(item.target) ?? "知识候选"}：${stringValue(item.message) ?? "可能改变义务强度，请核对 Authority 分类"}`);
    }
  }

  const disposition = isRecord(change.finish_disposition) ? change.finish_disposition : undefined;
  if (disposition) {
    const choice = stringValue(disposition.choice);
    const dispositionStatus = stringValue(disposition.status);
    if (choice) lines.push(`处置选择：${choice}`);
    if (dispositionStatus) lines.push(`处置状态：${dispositionStatus}`);
    const pendingAction = stringValue(disposition.pending_action);
    if (pendingAction) lines.push(`待执行：${pendingAction}`);
  }

  if (lines.length > 0) return lines.join("\n");
  if (typeof data.message === "string") return data.message;
  return JSON.stringify(data, null, 2);
}

export function formatHumanFailure(failure: CliFailure): string {
  const lines = [`RockSpec ${failure.error.code}: ${failure.error.message}`];
  const details = isRecord(failure.error.details) ? failure.error.details : undefined;
  const renderable = collectValidationItems(details);
  if (renderable.length > 0) {
    lines.push("");
    for (const item of renderable) {
      const location = item.paths.length > 0 ? item.paths.join(" -> ") : "产物";
      lines.push(`- ${location}`);
      lines.push(`  问题：${validationMessage(item.code, item.message)}`);
      if (item.expected) lines.push(`  期望：${item.expected}`);
      if (item.received) lines.push(`  当前值：${item.received}`);
      if (item.allowed.length > 0) lines.push(`  可选值：${item.allowed.join("、")}`);
    }
  } else if (failure.error.details !== null) {
    lines.push(JSON.stringify(failure.error.details, null, 2));
  }
  if (failure.error.recovery_command) lines.push(`恢复命令：${failure.error.recovery_command}`);
  return lines.join("\n");
}

interface RenderableValidationItem {
  code: string | undefined;
  message: string | undefined;
  paths: string[];
  expected: string | undefined;
  received: string | undefined;
  allowed: string[];
}

// 归一化两种校验错误形态：dry-run 走 details.errors（已是 BlockReason），
// 提交路径走 details.issues（原始 zod issue）。后者需按 engine 的 validationIssue
// 同构提取候选值，才能渲染出「可选值」而非原样 dump。
function collectValidationItems(details: Record<string, unknown> | undefined): RenderableValidationItem[] {
  if (!details) return [];
  if (Array.isArray(details.errors)) {
    return details.errors
      .filter(isRecord)
      .map((item) => ({
        code: stringValue(item.code),
        message: stringValue(item.message),
        paths: Array.isArray(item.paths)
          ? item.paths.filter((value): value is string => typeof value === "string")
          : [],
        expected: stringValue(item.expected),
        received: stringValue(item.received),
        allowed: Array.isArray(item.allowed)
          ? item.allowed.filter((value): value is string => typeof value === "string")
          : [],
      }));
  }
  if (Array.isArray(details.issues)) {
    const basePath = stringValue(details.path);
    return details.issues.filter(isRecord).map((issue) => normalizeZodIssue(issue, basePath));
  }
  return [];
}

function normalizeZodIssue(issue: Record<string, unknown>, basePath?: string): RenderableValidationItem {
  const issuePath = Array.isArray(issue.path) ? issue.path.map(String) : [];
  const allowed = Array.isArray(issue.values)
    ? issue.values.filter((value): value is string => typeof value === "string")
    : [];
  const input = issue.input;
  const received = input === undefined
    ? undefined
    : typeof input === "string"
      ? input
      : JSON.stringify(input);
  return {
    code: stringValue(issue.code),
    message: stringValue(issue.message),
    paths: [...(basePath ? [basePath] : []), ...issuePath],
    expected: stringValue(issue.expected),
    received,
    allowed,
  };
}

function validationMessage(code?: string, fallback?: string): string {
  if (code === "invalid_type") return "字段类型不正确";
  if (code === "invalid_value") return "字段值不在允许范围内";
  if (code === "too_small") return "内容数量或长度不足";
  if (code === "unrecognized_keys") return "包含未定义字段";
  return fallback ?? "产物字段不符合 Schema";
}

function appendResumeItems(
  lines: string[],
  title: string,
  value: unknown,
  render: (item: Record<string, unknown>) => string,
): void {
  if (!Array.isArray(value) || value.length === 0) return;
  lines.push("", `${title}：`);
  for (const item of value) {
    if (isRecord(item)) lines.push(`- ${render(item)}`);
  }
}

function asErrorRecord(error: unknown): Record<string, unknown> {
  if (isRecord(error)) return error;
  return { message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
