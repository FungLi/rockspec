import type {
  ActionId,
  AlternativeAction,
  BlockReason,
  ChangeSnapshot,
  EntrySkill,
  Recommendation,
  RecoveryDirective,
  WorkflowProfile,
} from "./types.js";

export const WORKFLOW_PRIMARY_ACTIONS_BY_PROFILE: Readonly<Record<WorkflowProfile, readonly ActionId[]>> = {
  lite: ["change.triage", "task.execute", "change.verify", "knowledge.evolve", "change.archive"],
  standard: [
    "change.triage",
    "requirements.clarify",
    "requirements.review",
    "design.technical",
    "design.prototype",
    "plan.create",
    "readiness.review",
    "task.execute",
    "task.review",
    "acceptance.validate",
    "delivery.review",
    "change.verify",
    "knowledge.evolve",
    "change.archive",
  ],
  strict: [
    "change.triage",
    "requirements.clarify",
    "requirements.review",
    "design.technical",
    "design.prototype",
    "plan.create",
    "readiness.review",
    "task.execute",
    "task.review",
    "acceptance.validate",
    "delivery.review",
    "change.verify",
    "knowledge.evolve",
    "change.archive",
  ],
};

export const ACTION_PROFILES: Readonly<Record<ActionId, readonly WorkflowProfile[]>> = {
  "change.triage": ["lite", "standard", "strict"],
  "change.promote": ["lite", "standard"],
  "requirements.clarify": ["standard", "strict"],
  "requirements.review": ["standard", "strict"],
  "design.technical": ["standard", "strict"],
  "design.prototype": ["standard", "strict"],
  "plan.create": ["standard", "strict"],
  "readiness.review": ["standard", "strict"],
  "task.execute": ["lite", "standard", "strict"],
  "task.review": ["standard", "strict"],
  "acceptance.validate": ["standard", "strict"],
  "delivery.review": ["standard", "strict"],
  "change.verify": ["lite", "standard", "strict"],
  "knowledge.evolve": ["lite", "standard", "strict"],
  "change.archive": ["lite", "standard", "strict"],
};

export const WORKFLOW_APPROVAL_GATES = {
  spec: { after_actions: ["requirements.review"] },
  design: { after_actions: ["design.technical", "design.prototype"] },
  implementation: { after_actions: ["readiness.review"] },
} as const;

interface WorkflowAdvice {
  recommended: Recommendation | null;
  alternatives: AlternativeAction[];
  allowed: string[];
}

const ENTRY_SKILL_BY_ACTION: Readonly<Record<string, EntrySkill>> = {
  "change.triage": "rockspec-triage",
  "change.promote": "rockspec-triage",
  revise: "rockspec-change",
  "revise.amend": "rockspec-change",
  "requirements.clarify": "rockspec-requirements",
  "requirements.review": "rockspec-requirements",
  "approve.spec": "rockspec-requirements",
  "design.technical": "rockspec-design",
  "approve.design": "rockspec-design",
  "design.prototype": "rockspec-prototype",
  "plan.create": "rockspec-plan",
  "readiness.review": "rockspec-plan",
  "approve.implementation": "rockspec-plan",
  "reconcile.spec": "rockspec-review",
  "reconcile.design": "rockspec-review",
  "reconcile.implementation": "rockspec-review",
  apply: "rockspec-implement",
  "task.execute": "rockspec-implement",
  "task.review": "rockspec-review",
  "acceptance.validate": "rockspec-acceptance",
  "delivery.review": "rockspec-review",
  "change.verify": "rockspec-finish",
  "knowledge.evolve": "rockspec-evolve",
  finish: "rockspec-finish",
  "change.archive": "rockspec-finish",
  validate: "rockspec-change",
};

function recommendation(action: string, reason: string): Recommendation {
  return {
    action,
    entry_skill: ENTRY_SKILL_BY_ACTION[action] ?? "rockspec-change",
    reason,
  };
}

function revisionGatePolicy(
  revision: NonNullable<ChangeSnapshot["revisions"][number]>,
  gate: "spec" | "design" | "implementation",
): "preserve" | "auto" | "human" {
  const explicit = revision.gate_policies[gate];
  if (explicit) return explicit;
  if (!revision.invalidated_approvals.includes(gate)) return "preserve";
  if (revision.approval_policy === "auto") return "auto";
  return gate === "implementation" && revision.target !== "plan" ? "auto" : "human";
}

function activeRevisionContinuation(
  change: ChangeSnapshot,
  target: NonNullable<RecoveryDirective["target"]>,
): string {
  if (change.state === "SCOPING") return "requirements.clarify";
  if (change.state === "SPEC_REVIEW") return "requirements.review";
  if (change.state === "SPEC_APPROVED") return "design.technical";
  if (change.state === "DESIGNING") {
    return change.prototype.required && change.prototype.status === "pending"
      ? "design.prototype"
      : "design.technical";
  }
  if (change.state === "DESIGN_APPROVED" || change.state === "PLANNING") return "plan.create";
  if (change.state === "READINESS_REVIEW") return "readiness.review";
  return target === "requirements"
    ? "requirements.clarify"
    : target === "plan"
      ? "plan.create"
      : target === "prototype"
        ? "design.prototype"
        : "design.technical";
}

const REVISION_TARGET_BY_ROUTE = {
  "requirements.clarify": "requirements",
  "design.technical": "design",
  "design.prototype": "prototype",
  "plan.create": "plan",
} as const;

const REVISION_TARGET_RANK = {
  requirements: 0,
  design: 1,
  prototype: 2,
  plan: 3,
} as const;

export function recoveryDirective(change: ChangeSnapshot): RecoveryDirective | null {
  let reviewId: string | null = null;
  let source: ActionId | null = null;
  if (change.state === "SPEC_REVIEW") {
    reviewId = "requirements";
    source = "requirements.review";
  } else if (change.state === "READINESS_REVIEW") {
    reviewId = "readiness";
    source = "readiness.review";
  } else if (change.state === "IMPLEMENTING" && change.execution.active_task) {
    reviewId = `task:${change.execution.active_task}`;
    source = "task.review";
  } else if (change.state === "ACCEPTANCE_VALIDATING") {
    reviewId = "acceptance";
    source = "acceptance.validate";
  } else if (change.state === "FINAL_REVIEW") {
    reviewId = "delivery";
    source = "delivery.review";
  }
  if (!reviewId || !source) return null;

  const review = change.reviews[reviewId];
  if (!review || review.verdict === "PASS") return null;
  const open = review.findings.filter((finding) => finding.status === "open");
  if (open.length === 0) return null;
  const activeRevision = change.revisions.some((revision) => revision.status === "open");
  if (!activeRevision && source === "requirements.review") {
    return {
      kind: "action",
      review_id: reviewId,
      source,
      finding_ids: [...new Set(open.map((finding) => finding.id))].sort(),
      route_to: ["requirements.clarify"],
    };
  }
  if (!activeRevision && source === "readiness.review" &&
      open.every((finding) => finding.route_to === "plan.create")) {
    return {
      kind: "action",
      review_id: reviewId,
      source,
      finding_ids: [...new Set(open.map((finding) => finding.id))].sort(),
      route_to: ["plan.create"],
    };
  }

  type RecoveryTarget = keyof typeof REVISION_TARGET_RANK;
  const revisionFindings: Array<{
    finding: (typeof open)[number];
    target: RecoveryTarget;
    revisionKind: "upstream" | "remediation";
  }> = [];
  for (const finding of open) {
    const directTarget = REVISION_TARGET_BY_ROUTE[
      finding.route_to as keyof typeof REVISION_TARGET_BY_ROUTE
    ];
    if (directTarget) {
      revisionFindings.push({ finding, target: directTarget, revisionKind: "upstream" });
      continue;
    }
    if (source !== "task.review" && finding.route_to === "task.execute") {
      revisionFindings.push({ finding, target: "plan", revisionKind: "remediation" });
    }
  }
  if (revisionFindings.length > 0) {
    const earliest = revisionFindings.reduce((left, right) =>
      REVISION_TARGET_RANK[right.target] < REVISION_TARGET_RANK[left.target] ? right : left);
    const classifications = [...new Set(open.map((finding) => finding.classification))].sort();
    const authorityDelta = open.some((finding) => finding.authority_impact === "changed")
      ? "changed"
      : open.some((finding) => finding.authority_impact === "unknown")
        ? "unknown"
        : "unchanged";
    const autoClassifications = new Set(["consistency_fix", "derived_gap", "implementation_fix"]);
    const approvalPolicy = authorityDelta === "unchanged" &&
        open.every((finding) => finding.severity !== "critical" && autoClassifications.has(finding.classification))
      ? "auto"
      : "human";
    return {
      kind: "revision",
      review_id: reviewId,
      source,
      finding_ids: [...new Set(open.map((finding) => finding.id))].sort(),
      route_to: [...new Set(open.map((finding) => finding.route_to))].sort(),
      target: earliest.target,
      revision_kind: revisionFindings.some(({ revisionKind }) => revisionKind === "upstream")
        ? "upstream"
        : "remediation",
      classifications,
      authority_delta: authorityDelta,
      approval_policy: approvalPolicy,
    };
  }

  if (source === "delivery.review" && open.every((finding) => finding.route_to === "acceptance.validate")) {
    return {
      kind: "action",
      review_id: reviewId,
      source,
      finding_ids: [...new Set(open.map((finding) => finding.id))].sort(),
      route_to: ["acceptance.validate"],
    };
  }
  return null;
}

export function workflowAdvice(
  change: ChangeSnapshot,
  blocked: BlockReason[],
  recovery: RecoveryDirective | null = null,
): WorkflowAdvice {
  if (change.state === "ARCHIVED") return { recommended: null, alternatives: [], allowed: [] };
  const activeRevision = change.revisions.find((revision) => revision.status === "open");

  if (recovery?.kind === "revision") {
    const action = activeRevision ? "revise.amend" : "revise";
    return {
      recommended: recommendation(
        action,
        activeRevision
          ? `Amend ${activeRevision.id} with ${recovery.finding_ids.join(", ")}`
          : `Open a ${recovery.target} Recovery Revision for ${recovery.finding_ids.join(", ")}`,
      ),
      alternatives: [],
      allowed: [action, "validate"],
    };
  }
  if (recovery?.kind === "action") {
    const action = recovery.route_to[0] ?? "validate";
    return {
      recommended: recommendation(action, `Resolve ${recovery.finding_ids.join(", ")} from ${recovery.review_id}`),
      alternatives: [],
      allowed: [action, "validate"],
    };
  }

  if (blocked.length > 0) {
    const stale = blocked.find((item) => item.code === "STALE_APPROVAL");
    if (stale) {
      if (activeRevision) {
        const action = activeRevisionContinuation(change, activeRevision.target);
        return {
          recommended: recommendation(action, `Continue ${activeRevision.id}; do not open a second Revision for stale content`),
          alternatives: [],
          allowed: [action, "validate"],
        };
      }
      const gate = typeof stale.paths?.[0] === "string" ? stale.paths[0] : "spec";
      return {
        recommended: recommendation("revise", `The ${gate} content changed; open a controlled Revision before renewing approval`),
        alternatives: [],
        allowed: ["revise", "validate"],
      };
    }
    return {
      recommended: recommendation("validate", "Resolve the reported blockers before continuing"),
      alternatives: [],
      allowed: ["validate"],
    };
  }

  const pendingReconciliation = activeRevision?.last_reconciliation &&
      revisionGatePolicy(activeRevision, activeRevision.last_reconciliation.gate) === "auto"
    ? activeRevision.last_reconciliation
    : undefined;
  if (pendingReconciliation && pendingReconciliation.verdict !== "PASS") {
    const repairAction = pendingReconciliation.gate === "spec"
      ? "requirements.clarify"
      : pendingReconciliation.gate === "design"
        ? "design.technical"
        : "plan.create";
    return {
      recommended: recommendation(repairAction, `Address Reconciliation round ${pendingReconciliation.round} Findings`),
      alternatives: [],
      allowed: [repairAction, "validate"],
    };
  }

  const autoReconciliationAction = (gate: "spec" | "design" | "implementation"): string | null => {
    if (!activeRevision || revisionGatePolicy(activeRevision, gate) !== "auto") return null;
    if (!activeRevision.invalidated_approvals.includes(gate) || !activeRevision.authority_baselines[gate]) return null;
    return `reconcile.${gate}`;
  };

  switch (change.state) {
    case "SCOPING":
      if (change.profile === "lite") {
        return {
          recommended: recommendation("change.triage", "Confirm that the change still meets Lite criteria"),
          alternatives: [
            { action: "apply", reason: "Begin the narrow implementation after triage" },
            { action: "change.promote", reason: "Promote if risk or scope has expanded" },
          ],
          allowed: ["change.triage", "apply", "change.promote", "validate"],
        };
      }
      return {
        recommended: recommendation("requirements.clarify", "Clarify observable requirements and scope"),
        alternatives: [],
        allowed: ["requirements.clarify", "validate"],
      };
    case "SPEC_REVIEW":
      if (change.reviews.requirements?.verdict === "PASS") {
        const autoAction = autoReconciliationAction("spec");
        if (autoAction) {
          return {
            recommended: recommendation(autoAction, "Requirements are within the approved Intent Envelope; run independent reconciliation"),
            alternatives: [],
            allowed: [autoAction, "requirements.clarify", "validate"],
          };
        }
        return {
          recommended: recommendation("approve.spec", "Requirements review passed; user approval is required"),
          alternatives: [{ action: "requirements.clarify" }],
          allowed: ["approve.spec", "requirements.clarify", "requirements.review", "validate"],
        };
      }
      return {
        recommended: recommendation("requirements.review", "Run the independent requirements review"),
        alternatives: [{ action: "requirements.clarify" }],
        allowed: ["requirements.clarify", "requirements.review", "validate"],
      };
    case "SPEC_APPROVED":
      return {
        recommended: recommendation("design.technical", "Create the technical design against the approved Spec"),
        alternatives: [],
        allowed: ["design.technical", "validate"],
      };
    case "DESIGNING":
      if (change.prototype.required && change.prototype.status === "pending") {
        return {
          recommended: recommendation("design.prototype", "The UI change requires an approved prototype"),
          alternatives: [{ action: "design.technical" }],
          allowed: ["design.technical", "design.prototype", "validate"],
        };
      }
      if (change.prototype.required && change.prototype.status === "completed") {
        return {
          recommended: recommendation("design.technical", "Reconcile the completed Prototype into Technical Design"),
          alternatives: [{ action: "design.prototype" }],
          allowed: ["design.technical", "design.prototype", "validate"],
        };
      }
      return {
        recommended: recommendation(
          autoReconciliationAction("design") ?? "approve.design",
          autoReconciliationAction("design")
            ? "Design remains within the approved Decision Envelope; run independent reconciliation"
            : "Review and approve the Design and Prototype content",
        ),
        alternatives: [{ action: "design.technical" }],
        allowed: [autoReconciliationAction("design") ?? "approve.design", "design.technical", "validate"],
      };
    case "DESIGN_APPROVED":
    case "PLANNING":
      return {
        recommended: recommendation("plan.create", "Create the implementation plan and task DAG"),
        alternatives: [],
        allowed: ["plan.create", "validate"],
      };
    case "READINESS_REVIEW":
      if (change.reviews.readiness?.verdict === "PASS") {
        const autoAction = autoReconciliationAction("implementation");
        if (autoAction) {
          return {
            recommended: recommendation(autoAction, "The recovered Plan remains inside the approved execution envelope"),
            alternatives: [{ action: "plan.create" }],
            allowed: [autoAction, "plan.create", "readiness.review", "validate"],
          };
        }
        return {
          recommended: recommendation("approve.implementation", "Readiness review passed; approve implementation"),
          alternatives: [{ action: "plan.create" }],
          allowed: ["approve.implementation", "plan.create", "readiness.review", "validate"],
        };
      }
      return {
        recommended: recommendation("readiness.review", "Review the Design, Plan, and Tasks for readiness"),
        alternatives: [{ action: "plan.create" }],
        allowed: ["plan.create", "readiness.review", "validate"],
      };
    case "READY":
      return {
        recommended: recommendation("task.execute", "Start the next ready implementation task"),
        alternatives: [],
        allowed: ["apply", "task.execute", "validate"],
      };
    case "IMPLEMENTING":
      return {
        recommended: recommendation("task.execute", "Complete the active task or start the next pending task"),
        alternatives: [{ action: "task.review" }],
        allowed: ["task.execute", "task.review", "validate"],
      };
    case "ACCEPTANCE_VALIDATING":
      return {
        recommended: recommendation("acceptance.validate", "Run independent acceptance testing before Final CR"),
        alternatives: [],
        allowed: ["acceptance.validate", "validate"],
      };
    case "FINAL_REVIEW":
      return {
        recommended: recommendation("delivery.review", "Review the final code and all TE assets"),
        alternatives: [],
        allowed: ["delivery.review", "validate"],
      };
    case "VERIFYING":
      return {
        recommended: recommendation("change.verify", "Run the complete final verification suite"),
        alternatives: [],
        allowed: ["change.verify", "validate"],
      };
    case "READY_TO_FINISH":
      if (change.knowledge_evolution.status === "pending") {
        return {
          recommended: recommendation("knowledge.evolve", "Reconcile reusable knowledge before archiving"),
          alternatives: [],
          allowed: ["knowledge.evolve", "validate"],
        };
      }
      if (!change.finished_at) {
        return {
          recommended: recommendation("finish", "Choose a platform-independent branch disposition"),
          alternatives: [],
          allowed: ["finish", "validate"],
        };
      }
      return {
        recommended: recommendation("change.archive", "Merge Spec deltas and archive the completed Change"),
        alternatives: [],
        allowed: ["change.archive", "validate"],
      };
    default:
      return {
        recommended: recommendation("validate", `Resolve the ${change.state} state before continuing`),
        alternatives: [],
        allowed: ["validate"],
      };
  }
}

export function assertActionAllowed(change: ChangeSnapshot, action: ActionId): void {
  if (!ACTION_PROFILES[action].includes(change.profile)) {
    throw new Error(`ILLEGAL_ACTION:${action}:${change.profile}`);
  }
  const legal: Partial<Record<ActionId, ChangeSnapshot["state"][]>> = {
    "change.triage": ["SCOPING"],
    "change.promote": ["SCOPING", "IMPLEMENTING", "VERIFYING"],
    "requirements.clarify": ["SCOPING", "SPEC_REVIEW"],
    "requirements.review": ["SPEC_REVIEW"],
    "design.technical": ["SPEC_APPROVED", "DESIGNING"],
    "design.prototype": ["DESIGNING"],
    "plan.create": ["DESIGN_APPROVED", "PLANNING", "READINESS_REVIEW"],
    "readiness.review": ["READINESS_REVIEW"],
    "task.execute": ["READY", "IMPLEMENTING"],
    "task.review": ["IMPLEMENTING"],
    "acceptance.validate": ["ACCEPTANCE_VALIDATING"],
    "delivery.review": ["FINAL_REVIEW"],
    "change.verify": ["IMPLEMENTING", "VERIFYING"],
    "knowledge.evolve": ["READY_TO_FINISH"],
    "change.archive": ["READY_TO_FINISH"],
  };
  if (!legal[action]?.includes(change.state)) {
    throw new Error(`ILLEGAL_ACTION:${action}:${change.state}`);
  }
}
