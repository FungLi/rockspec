import type {
  ActionId,
  AlternativeAction,
  BlockReason,
  ChangeSnapshot,
  EntrySkill,
  Recommendation,
  WorkflowProfile,
} from "./types.js";

export const WORKFLOW_PRIMARY_ACTIONS_BY_PROFILE: Readonly<Record<WorkflowProfile, readonly ActionId[]>> = {
  lite: ["change.triage", "task.execute", "change.verify", "change.archive"],
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
  "requirements.clarify": "rockspec-requirements",
  "requirements.review": "rockspec-requirements",
  "approve.spec": "rockspec-requirements",
  "design.technical": "rockspec-design",
  "approve.design": "rockspec-design",
  "design.prototype": "rockspec-prototype",
  "plan.create": "rockspec-plan",
  "readiness.review": "rockspec-plan",
  "approve.implementation": "rockspec-plan",
  apply: "rockspec-implement",
  "task.execute": "rockspec-implement",
  "task.review": "rockspec-review",
  "acceptance.validate": "rockspec-acceptance",
  "delivery.review": "rockspec-review",
  "change.verify": "rockspec-finish",
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

export function workflowAdvice(change: ChangeSnapshot, blocked: BlockReason[]): WorkflowAdvice {
  if (change.state === "ARCHIVED") return { recommended: null, alternatives: [], allowed: [] };

  if (blocked.length > 0) {
    const stale = blocked.find((item) => item.code === "STALE_APPROVAL");
    if (stale) {
      const gate = typeof stale.paths?.[0] === "string" ? stale.paths[0] : "spec";
      return {
        recommended: recommendation(`approve.${gate}`, `The ${gate} approval is stale and must be renewed`),
        alternatives: [],
        allowed: [`approve.${gate}`, "validate"],
      };
    }
    return {
      recommended: recommendation("validate", "Resolve the reported blockers before continuing"),
      alternatives: [],
      allowed: ["validate"],
    };
  }

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
      if (change.prototype.required && change.prototype.status !== "completed") {
        return {
          recommended: recommendation("design.prototype", "The UI change requires an approved prototype"),
          alternatives: [{ action: "design.technical" }],
          allowed: ["design.technical", "design.prototype", "validate"],
        };
      }
      return {
        recommended: recommendation("approve.design", "Review and approve the Design and Prototype content"),
        alternatives: [{ action: "design.technical" }],
        allowed: ["approve.design", "design.technical", "validate"],
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
    "change.archive": ["READY_TO_FINISH"],
  };
  if (!legal[action]?.includes(change.state)) {
    throw new Error(`ILLEGAL_ACTION:${action}:${change.state}`);
  }
}
