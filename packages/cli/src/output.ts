import type { StatusResult } from "@rockspec/engine";

export const CLI_SCHEMA_VERSION = 1 as const;

export const STATUS_VIEWS = ["summary", "tasks", "recovery", "hashes", "full"] as const;
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

  if (lines.length > 0) return lines.join("\n");
  if (typeof data.message === "string") return data.message;
  return JSON.stringify(data, null, 2);
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
