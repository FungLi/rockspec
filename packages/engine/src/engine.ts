import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import {
  AcceptanceDocumentSchema,
  ApprovalPackageSchema,
  DesignDefinitionSchema,
  InstallLockSchema,
  KnowledgeDeltaDocumentSchema,
  KnowledgeEvolutionSchema,
  KnowledgeReviewDocumentSchema,
  PlanDefinitionSchema,
  ProposalDefinitionSchema,
  PrototypeBriefDefinitionSchema,
  ReconciliationReviewDocumentSchema,
  ReviewDocumentSchema,
  StageReviewDocumentSchema,
  TaskDefinitionSchema,
  TaskCommitSchema,
  UatDocumentSchema,
  assertChangeId as assertProtocolChangeId,
  validateSpec,
  triageProfile,
} from "@rockspec/protocol";
import { RockSpecError } from "./error.js";
import { approvalPaths, hashPaths, sha256 } from "./hashing.js";
import {
  DEFAULT_CONFIG,
  activeChangeIds,
  appendEvent,
  atomicWrite,
  changeLocationsAcrossWorktrees,
  commitChangeMutation,
  eventCount,
  exists,
  findArchivedChange,
  git,
  inspectGitWorkspace,
  readChange,
  readConfig,
  resolveRepository,
  walkFiles,
  withFileLock,
  writeChange,
  type RockSpecConfig,
} from "./storage.js";
import type {
  ApprovalGate,
  ApprovalPackageResult,
  ApprovalRecord,
  ApplyRecoveryInput,
  AmendRevisionInput,
  ArchiveResult,
  BlockReason,
  ChangeInput,
  ChangeSnapshot,
  CompleteActionInput,
  CompleteExecutionInput,
  CompleteUatInput,
  CompleteReconciliationInput,
  CompleteTaskInput,
  EngineOptions,
  ExecutionStartResult,
  ExecutionCompleteResult,
  EventRecord,
  FeedbackSubmitInput,
  FinishInput,
  GateInput,
  InitResult,
  NewChangeInput,
  PrepareApprovalInput,
  KnowledgePackageResult,
  ImplementationPreflightResult,
  PromoteInput,
  ReviseInput,
  RecordEvidenceInput,
  ReconciliationInput,
  ReconciliationPackageResult,
  ReviewPackageInput,
  ReviewPackageResult,
  ReviewRecord,
  ReviewVerdict,
  RevisionRecord,
  RevisionAmendmentRecord,
  StatusResult,
  StartExecutionInput,
  StartTaskInput,
  RunCheckInput,
  RunCheckResult,
  TaskBriefResult,
  TaskInput,
  TaskRecord,
  ValidationResult,
  ValidateInput,
  WorkflowProfile,
  ApproveInput,
  AcceptancePreflightResult,
  EnvironmentPreflightResult,
} from "./types.js";
import { assertActionAllowed, recoveryDirective, workflowAdvice } from "./workflow.js";

const execFileAsync = promisify(execFile);

interface Context {
  root: string;
  rocksRoot: string;
  config: RockSpecConfig;
}

interface LocatedChange {
  changeDir: string;
  change: ChangeSnapshot;
}

interface MutationResult extends LocatedChange {
  context: Context;
}

interface SpecTraceability {
  requirementScenarios: Map<string, Set<string>>;
  scenarioRequirement: Map<string, string>;
}

export class RockSpecEngine {
  readonly cwd: string;
  readonly availableProviders: ReadonlySet<string>;
  readonly lockTimeoutMs: number;
  readonly lockStaleMs: number;
  private readonly clock: () => Date;

  constructor(options: EngineOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.clock = options.now ?? (() => new Date());
    this.availableProviders = options.availableProviders ?? new Set<string>();
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
  }

  async init(): Promise<InitResult> {
    const { root, rocksRoot } = await resolveRepository(this.cwd);
    const configPath = path.join(rocksRoot, "config.yaml");
    let created = false;
    await mkdir(rocksRoot, { recursive: true });
    await withFileLock(
      rocksRoot,
      async () => {
        if (!(await exists(configPath))) {
          await atomicWrite(configPath, stringify(DEFAULT_CONFIG, { lineWidth: 0 }));
          created = true;
        } else {
          await readConfig(rocksRoot);
        }
        await Promise.all([
          mkdir(path.join(rocksRoot, "changes"), { recursive: true }),
          mkdir(path.join(rocksRoot, "archive"), { recursive: true }),
          mkdir(path.join(rocksRoot, "specs"), { recursive: true }),
          mkdir(path.join(rocksRoot, "knowledge", ".evolution"), { recursive: true }),
        ]);
      },
      this.lockTimeoutMs,
      this.lockStaleMs,
    );
    return { schema_version: 1, repository_root: root, rocks_root: rocksRoot, created };
  }

  async newChange(input: NewChangeInput): Promise<StatusResult> {
    validateChangeId(input.id);
    const context = await this.context();
    const kind = input.kind ?? "feature";
    const triage = triageProfile({
      kind,
      requestedProfile: input.profile ?? context.config.default_profile,
      riskTags: input.riskTags ?? [],
    });
    const profile = triage.profile;
    const changeDir = path.join(context.rocksRoot, "changes", input.id);
    const now = this.timestamp();
    let snapshot: ChangeSnapshot | undefined;

    await withFileLock(
      context.rocksRoot,
      async () => {
        const activeChanges = await activeChangeIds(context.rocksRoot);
        const reuseParent = input.basedOnChange && input.reuseWorkspace
          ? activeChanges.find((id) => id === input.basedOnChange)
          : undefined;
        if (activeChanges.length > 0 && !reuseParent) {
          throw new RockSpecError(
            "WORKSPACE_ALREADY_BOUND",
            "This workspace already contains an active Change; use an isolated Worktree",
            { active_changes: activeChanges },
          );
        }
        let parent: ChangeSnapshot | undefined;
        if (input.basedOnChange) {
          if (!input.confirmBoundary && !input.reuseWorkspace) {
            throw new RockSpecError("CONFIRMATION_REQUIRED", "Creating a dependent Change requires explicit boundary confirmation", {
              change_id: input.basedOnChange,
            });
          }
          const parentLocations = await changeLocationsAcrossWorktrees(context.root, input.basedOnChange);
          const parentDir = parentLocations[0];
          if (!parentDir) {
            throw new RockSpecError("CHANGE_NOT_FOUND", `Parent Change ${input.basedOnChange} does not exist`, {
              change_id: input.basedOnChange,
            });
          }
          parent = await readChange(parentDir);
          if (parent.state === "ARCHIVED") {
            throw new RockSpecError("CHANGE_ARCHIVED", "An archived Change cannot be used as an active feedback parent", {
              change_id: parent.id,
            });
          }
          if (!parent.delivery_head) {
            throw new RockSpecError("DELIVERY_HEAD_REQUIRED", "Parent Change must have a frozen delivery_head before creating a dependent Change", {
              change_id: parent.id,
            });
          }
          if (!input.reuseWorkspace && activeChanges.length > 0) {
            throw new RockSpecError("WORKSPACE_ALREADY_BOUND", "Create the dependent Change in an isolated Worktree or explicitly confirm Worktree reuse", {
              active_changes: activeChanges,
            });
          }
        }
        const existingLocations = await changeLocationsAcrossWorktrees(context.root, input.id);
        if (existingLocations.length > 0) {
          throw new RockSpecError("CHANGE_ID_CONFLICT", `Change ID ${input.id} is already in use`, {
            change_id: input.id,
            locations: existingLocations,
          });
        }
        const workspace = await inspectGitWorkspace(context.root);
        if (workspace.mode === "worktree" && workspace.branch === null) {
          throw new RockSpecError(
            "DETACHED_WORKTREE",
            "A new governed Change requires a branch in its Worktree",
            { workspace: context.root },
          );
        }
        if (input.workspaceManaged && workspace.mode !== "worktree") {
          throw new RockSpecError(
            "WORKSPACE_MODE_MISMATCH",
            "--managed-worktree requires a linked Git Worktree",
            { workspace: context.root, actual_mode: workspace.mode },
          );
        }
        if (input.workspaceManaged && !input.baseRef) {
          throw new RockSpecError(
            "BASE_REF_REQUIRED",
            "A managed Worktree Change requires its target base ref",
            { workspace: context.root },
          );
        }
        const expectedManagedBranch = `${context.config.workspace.branch_prefix}${input.id}`;
        if (input.workspaceManaged && workspace.branch !== expectedManagedBranch) {
          throw new RockSpecError(
            "WORKSPACE_BRANCH_MISMATCH",
            `Managed Worktree branch must be ${expectedManagedBranch}`,
            { expected_branch: expectedManagedBranch, actual_branch: workspace.branch },
          );
        }
        const baseCommit = parent?.delivery_head ?? await git(context.root, ["rev-parse", "HEAD"]);
        const baseRef = input.baseRef ?? (await git(context.root, ["rev-parse", "--abbrev-ref", "HEAD"]));
        const binding = context.config.capabilities["ui.prototype"];
        if (!binding || !binding.provider) {
          throw new RockSpecError("CAPABILITY_NOT_CONFIGURED", "ui.prototype has no configured provider", {
            capability: "ui.prototype",
          });
        }
        const createdSnapshot: ChangeSnapshot = {
          schema_version: 1,
          id: input.id as ChangeSnapshot["id"],
          title: input.title ?? titleFromId(input.id),
          profile,
          triage: {
            kind,
            risk_tags: [...new Set(input.riskTags ?? [])].sort(),
            minimum_profile: triage.minimumProfile,
            reasons: triage.reasons,
          },
          state: "SCOPING",
          base_ref: baseRef,
          base_commit: baseCommit,
          workspace: {
            mode: workspace.mode,
            branch: workspace.branch,
            managed: input.workspaceManaged ?? false,
          },
          created_at: now,
          updated_at: now,
          external_refs: [],
          artifacts: {},
          approvals: {},
          revisions: [],
          feedback_batches: [],
          prototype: {
            required: input.prototypeRequired ?? false,
            capability: "ui.prototype",
            provider: binding.provider,
            status: input.prototypeRequired ? "pending" : "not_required",
          },
          uat: {
            policy: input.uatPolicy ?? (input.prototypeRequired ? "required" : "optional"),
            status: input.uatPolicy === "required" || (!input.uatPolicy && input.prototypeRequired)
              ? "pending"
              : "not_required",
          },
          execution: { active_task: null, active_execution: null, registry: [] },
          tasks: {},
          evidence: [],
          reviews: {},
          verification: { status: "pending" },
          knowledge_evolution: { schema_version: 1, status: "pending", protocol_version: 1, updates: [] },
          completed_actions: [],
          ...(parent ? { based_on_change: parent.id, parent_delivery_head: parent.delivery_head } : {}),
        };
        snapshot = createdSnapshot;
        try {
          await mkdir(path.dirname(changeDir), { recursive: true });
          await mkdir(changeDir, { recursive: false });
          await this.ensureTemplates(changeDir, createdSnapshot);
          await this.refreshArtifacts(changeDir, createdSnapshot);
          await commitChangeMutation(changeDir, null, createdSnapshot, {
            schema_version: 1,
            sequence: 1,
            event: "change.created",
            change_id: createdSnapshot.id,
            occurred_at: now,
            previous_state: "SCOPING",
            current_state: "SCOPING",
            data: {
              profile,
              kind,
              risk_tags: input.riskTags ?? [],
              prototype_required: createdSnapshot.prototype.required,
              uat_policy: createdSnapshot.uat.policy,
              workspace: createdSnapshot.workspace,
            },
          });
        } catch (error) {
          await rm(changeDir, { recursive: true, force: true });
          throw error;
        }
      },
      this.lockTimeoutMs,
      this.lockStaleMs,
    );

    if (!snapshot) throw new RockSpecError("INTERNAL_ERROR", "Change creation produced no snapshot");
    return this.statusFor(context, changeDir, snapshot);
  }

  async getStatus(input: ChangeInput = {}): Promise<StatusResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId, true);
    return this.statusFor(context, located.changeDir, located.change);
  }

  async preflightImplementation(input: ChangeInput = {}): Promise<ImplementationPreflightResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    const { change, changeDir } = located;
    if (!["READINESS_REVIEW", "READY", "IMPLEMENTING"].includes(change.state)) {
      throw new RockSpecError(
        "IMPLEMENTATION_PREFLIGHT_STATE",
        `Implementation preflight is not legal while the Change is ${change.state}`,
        { state: change.state, expected_states: ["READINESS_REVIEW", "READY", "IMPLEMENTING"] },
      );
    }
    await this.assertWorkspaceBinding(context, change);
    const environment = await this.runEnvironmentPreflight(context, change.id);
    if (!environment.valid) {
      throw new RockSpecError("ENVIRONMENT_PREFLIGHT_FAILED", "Required environment preflight checks did not pass", {
        change_id: change.id,
        checks: environment.checks,
        recommended_next: { action: "preflight.environment", entry_skill: "rockspec-change" },
      });
    }
    if (change.state === "READINESS_REVIEW") {
      await this.assertApprovalPrerequisites(changeDir, change, "implementation");
    } else {
      await this.assertApprovalClosure(changeDir, change, ["spec", "design", "implementation"]);
      await this.assertMaterialized(changeDir, ["plan.md", "tasks.md", "tasks"]);
      this.assertReviewPassed(change, "readiness");
      await this.assertReviewFresh(changeDir, change, "readiness");
      assertTaskExecutionViable(change.tasks);
    }
    const recovery = recoveryDirective(change);
    if (recovery) {
      throw new RockSpecError("FINDING_RECOVERY_REQUIRED", "Resolve the active Finding recovery before implementation", {
        recovery,
      });
    }
    const tasks = Object.values(change.tasks).sort((left, right) => left.id.localeCompare(right.id));
    return {
      schema_version: 1,
      valid: true,
      change_id: change.id,
      current_state: change.state,
      checked_at: this.timestamp(),
      task_count: tasks.length,
      ready_task_ids: tasks
        .filter((task) => ["pending", "suspended", "in_progress"].includes(task.status) && taskDependenciesComplete(task, tasks))
        .map((task) => task.id),
      checks: [
        { id: "workspace", status: "passed", detail: "Workspace binding matches the active repository" },
        { id: "approvals", status: "passed", detail: "Required approval baselines are present and fresh" },
        { id: "readiness", status: "passed", detail: "Readiness Review is PASS and covers the current Plan" },
        { id: "task_graph", status: "passed", detail: "Task dependencies and supersession form a runnable graph" },
        { id: "recovery", status: "passed", detail: "No unresolved Finding recovery blocks implementation" },
        { id: "review_modes", status: "passed", detail: "Product and zero-Diff scope-blocked Task Review paths are available" },
        ...(environment.checks.length > 0
          ? [{ id: "environment" as const, status: "passed" as const, detail: "Configured database, browser, credential, and custom probes passed" }]
          : []),
      ],
      review_modes: ["product", "scope_blocked"],
    };
  }

  async preflightAcceptance(input: ChangeInput = {}): Promise<AcceptancePreflightResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    const { change, changeDir } = located;
    if (!(["ACCEPTANCE_VALIDATING", "FINAL_REVIEW"] as ChangeSnapshot["state"][]).includes(change.state)) {
      throw new RockSpecError("ACCEPTANCE_PREFLIGHT_STATE", `Acceptance preflight is not legal while the Change is ${change.state}`, {
        state: change.state,
      });
    }
    await this.assertWorkspaceBinding(context, change);
    await this.assertNoUncommittedProductChanges(context.root);
    const currentCommit = await git(context.root, ["rev-parse", "HEAD"]);
    const acceptanceExecution = [...change.execution.registry].reverse().find((execution) =>
      execution.role === "acceptance_engineer" && execution.action === "acceptance.validate",
    );
    if (!acceptanceExecution) {
      throw new RockSpecError("ACCEPTANCE_PREFLIGHT_EXECUTION_MISSING", "Register an Acceptance execution before preparing the report", {
        recommended_next: { action: "execution.start", role: "acceptance_engineer", command: `rockspec execution start acceptance.validate ${change.id} --role acceptance_engineer --model-tier balanced` },
      });
    }
    await requireArtifacts(changeDir, ["testing/test-plan.md", "testing/test-report.md"]);
    const review = await this.loadAcceptanceReview(
      changeDir,
      change,
      currentCommit,
      Object.values(change.tasks).map((task) => task.execution_id).filter((execution): execution is string => Boolean(execution)),
    );
    return {
      ...await this.statusFor(context, changeDir, change),
      valid: true,
      checks: [
        { id: "state", status: "passed", detail: `Change is ${change.state}` },
        { id: "execution", status: "passed", detail: `Acceptance execution ${acceptanceExecution.id} is registered` },
        { id: "report", status: "passed", detail: `Acceptance report binds commit ${currentCommit}` },
        { id: "scenarios", status: "passed", detail: `Acceptance verdict ${review.verdict} has valid Scenario coverage` },
        { id: "evidence", status: "passed", detail: "All referenced executed evidence and artifacts are present and fresh" },
      ],
    };
  }

  async preflightEnvironment(input: ChangeInput = {}): Promise<EnvironmentPreflightResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    const checks = await this.runEnvironmentPreflight(context, located.change.id);
    return { ...await this.statusFor(context, located.changeDir, located.change), ...checks };
  }

  async continue(input: ChangeInput = {}): Promise<StatusResult> {
    return this.getStatus(input);
  }

  async startExecution(input: StartExecutionInput): Promise<ExecutionStartResult> {
    assertExecutionRoleAction(input.role, input.action);
    let started: ExecutionStartResult["started_execution"] | undefined;
    const result = await this.mutate(input.changeId, "execution.started", async (change) => {
      const active = input.role === "acceptance_engineer"
        ? change.execution.registry.find((record) =>
          record.role === input.role && record.action === input.action && !record.completed_at,
        )
        : undefined;
      if (active) {
        throw new RockSpecError(
          "EXECUTION_ALREADY_ACTIVE",
          `An active ${input.role} execution already exists for ${input.action}`,
          {
            change_id: change.id,
            execution_id: active.id,
            role: active.role,
            action: active.action,
            recommended_next: {
              action: "execution.complete",
              command: `rockspec execution complete ${active.id} ${change.id} --outcome success`,
            },
          },
        );
      }
      if (input.parentExecutionId && !change.execution.registry.some((record) => record.id === input.parentExecutionId)) {
        throw new RockSpecError("EXECUTION_PARENT_NOT_FOUND", "Parent execution is not registered in this Change", {
          parent_execution_id: input.parentExecutionId,
        });
      }
      const id = randomUUID();
      change.execution.registry.push({
        id,
        role: input.role,
        action: input.action,
        started_at: this.timestamp(),
        ...(input.modelTier ? { model_tier: input.modelTier } : {}),
        ...(input.hostModel ? { host_model: input.hostModel } : {}),
        ...(input.parentExecutionId ? { parent_execution_id: input.parentExecutionId } : {}),
        ...(input.contextPackagePath ? { context_package_path: input.contextPackagePath } : {}),
        ...(input.contextPackageHash ? { context_package_hash: input.contextPackageHash } : {}),
      });
      started = { id, role: input.role, action: input.action };
      return { execution_id: id, role: input.role, action: input.action };
    });
    if (!started) throw new RockSpecError("INTERNAL_ERROR", "Execution was not registered");
    return { ...await this.statusFor(result.context, result.changeDir, result.change), started_execution: started };
  }

  async completeExecution(input: CompleteExecutionInput): Promise<ExecutionCompleteResult> {
    const usage = normalizeExecutionUsage(input.usage);
    let completed: ExecutionCompleteResult["completed_execution"] | undefined;
    const result = await this.mutate(input.changeId, "execution.completed", async (change) => {
      const execution = change.execution.registry.find((record) => record.id === input.executionId);
      if (!execution) {
        throw new RockSpecError("EXECUTION_NOT_REGISTERED", "Execution is not registered in this Change", {
          change_id: change.id,
          execution_id: input.executionId,
        });
      }
      const outcome = input.outcome ?? "success";
      if (execution.completed_at) {
        if (execution.outcome && execution.outcome !== outcome) {
          throw new RockSpecError("EXECUTION_OUTCOME_MISMATCH", "Completed execution cannot be assigned a different outcome", {
            change_id: change.id,
            execution_id: execution.id,
            recorded_outcome: execution.outcome,
            supplied_outcome: outcome,
          });
        }
        if (usage && execution.usage && JSON.stringify(execution.usage) !== JSON.stringify(usage)) {
          throw new RockSpecError("EXECUTION_USAGE_MISMATCH", "Completed execution cannot be assigned different token usage", {
            execution_id: execution.id,
            recorded_usage: execution.usage,
            supplied_usage: usage,
          });
        }
        if (usage && !execution.usage) execution.usage = usage;
        execution.outcome ??= outcome;
        completed = {
          id: execution.id,
          outcome,
          duration_ms: Math.max(0, Date.parse(execution.completed_at) - Date.parse(execution.started_at)),
          already_completed: true,
        };
        return completed;
      }
      execution.completed_at = this.timestamp();
      execution.outcome = outcome;
      if (usage) execution.usage = usage;
      completed = {
        id: execution.id,
        outcome,
        duration_ms: Math.max(0, Date.parse(execution.completed_at) - Date.parse(execution.started_at)),
        already_completed: false,
      };
      return completed;
    });
    if (!completed) throw new RockSpecError("INTERNAL_ERROR", "Execution completion was not recorded");
    return { ...await this.statusFor(result.context, result.changeDir, result.change), completed_execution: completed };
  }

  async completeAction(input: CompleteActionInput): Promise<StatusResult> {
    if (input.action === "change.promote") {
      return this.promote({
        ...(input.changeId ? { changeId: input.changeId } : {}),
        profile: "standard",
      });
    }
    if (input.action === "change.verify") return this.verify(input);
    if (input.action === "change.archive") return this.archive(input);
    if (input.action === "acceptance.uat") return this.completeUat(input);

    const result = await this.mutate(input.changeId, `action.${input.action}.completed`, async (change, changeDir, context) => {
      try {
        assertActionAllowed(change, input.action);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("ILLEGAL_ACTION:")) {
          throw new RockSpecError(
            "ILLEGAL_ACTION",
            `Action ${input.action} is not legal while the Change is ${change.state}`,
            { action: input.action, state: change.state },
          );
        }
        throw error;
      }
      const ingestingAmendmentFindings = input.verdict !== undefined && input.verdict !== "PASS" &&
        (input.action === "requirements.review" || input.action === "readiness.review") &&
        change.revisions.some((revision) => revision.status === "open");
      if (!ingestingAmendmentFindings) {
        await this.assertNoStalePrerequisites(changeDir, change, input.action);
      }
      let actionPassed = true;

      switch (input.action) {
        case "change.triage":
          await this.assertMaterialized(changeDir, ["brief.md"]);
          if (change.profile === "lite") change.state = "IMPLEMENTING";
          break;
        case "requirements.clarify":
          await requireArtifacts(changeDir, ["proposal.md", "specs"]);
          await this.assertMaterialized(changeDir, ["proposal.md", "specs"], true);
          await this.assertProposalReady(changeDir);
          change.state = "SPEC_REVIEW";
          break;
        case "requirements.review":
          change.reviews.requirements = await this.loadStageReview(
            changeDir,
            change,
            change.profile,
            "reviews/requirements-review.md",
            "requirements",
            input.verdict,
          );
          change.reviews.requirements.content_hash = (
            await hashPaths(changeDir, ["proposal.md", "specs"])
          ).aggregate_hash;
          actionPassed = change.reviews.requirements.verdict === "PASS";
          break;
        case "design.technical":
          await requireArtifacts(changeDir, ["design.md"]);
          await this.assertMaterialized(changeDir, ["design.md"]);
          await this.assertDesignCoverage(changeDir);
          if (change.prototype.required && change.prototype.status === "completed") {
            change.prototype.status = "reconciled";
          }
          change.state = "DESIGNING";
          break;
        case "design.prototype":
          if (!change.prototype.required) {
            throw new RockSpecError("PROTOTYPE_NOT_REQUIRED", "This Change does not require a UI prototype");
          }
          if (!change.prototype.provider) {
            throw new RockSpecError("CAPABILITY_NOT_CONFIGURED", "The Change has no UI prototype provider");
          }
          this.assertProviderAvailable(context.config, change.prototype.provider);
          await requireArtifacts(changeDir, [
            "prototype/brief.md",
            "prototype/design-system.md",
            "prototype/prototype.md",
          ]);
          await this.assertMaterialized(changeDir, [
            "prototype/brief.md",
            "prototype/design-system.md",
            "prototype/prototype.md",
          ]);
          await this.assertPrototypeTraceability(changeDir);
          change.prototype.status = "completed";
          break;
        case "plan.create":
          await requireArtifacts(changeDir, ["plan.md", "tasks.md", "tasks"]);
          await this.assertMaterialized(changeDir, ["plan.md", "tasks.md", "tasks"]);
          await this.syncTasks(changeDir, change);
          change.state = "READINESS_REVIEW";
          break;
        case "readiness.review":
          change.reviews.readiness = await this.loadStageReview(
            changeDir,
            change,
            change.profile,
            "reviews/readiness-review.md",
            "readiness",
            input.verdict,
          );
          change.reviews.readiness.content_hash = (
            await hashPaths(changeDir, ["design.md", "plan.md", "tasks.md", "tasks"])
          ).aggregate_hash;
          actionPassed = change.reviews.readiness.verdict === "PASS";
          break;
        case "task.execute":
          if (change.state === "READY") change.state = "IMPLEMENTING";
          break;
        case "task.review": {
          const taskId = change.execution.active_task;
          if (!taskId) throw new RockSpecError("NO_ACTIVE_TASK", "No active Task is available for review");
          const task = change.tasks[taskId];
          if (!task?.base_commit || !task.execution_id) {
            throw new RockSpecError("TASK_EXECUTION_INCOMPLETE", `Task ${taskId} has no bound execution`);
          }
          if (task.review_attempts >= context.config.max_review_rounds) {
            throw new RockSpecError("REVIEW_ROUND_LIMIT", `Task ${taskId} exhausted its configured Review attempts`, {
              task_id: taskId,
              review_attempts: task.review_attempts,
              max_review_rounds: context.config.max_review_rounds,
            });
          }
          if (task.review_package_mode === "scope_blocked") {
            await this.assertTaskScopeBlockedState(context.root, task);
          } else {
            await this.assertTaskProductState(context.root, task);
          }
          const reviewPackage = await this.writeReviewPackage(
            context.root,
            changeDir,
            change,
            "task",
            task.base_commit,
            await git(context.root, ["rev-parse", "HEAD"]),
            taskId,
            task.review_package_mode ?? "product",
            task.allowed_paths,
          );
          if (task.review_subject && !sameReviewSubject(task.review_subject, reviewPackage.subject)) {
            throw new RockSpecError("STALE_REVIEW_PACKAGE", `Task ${taskId} changed after its Review Package was prepared`, {
              prepared: task.review_subject,
              current: reviewPackage.subject,
            });
          }
          task.review_subject = reviewPackage.subject;
          const taskReview = await this.loadCodeReview(
            changeDir,
            change,
            change.profile,
            `reviews/tasks/${taskId}-review.md`,
            reviewPackage.subject,
            [task.execution_id],
            reviewPackage.scope?.expanded_paths ?? [],
            input.verdict,
          );
          if (task.review_package_mode === "scope_blocked" && taskReview.verdict === "PASS") {
            throw new RockSpecError("SCOPE_BLOCKED_REVIEW_PASS", "A scope-blocked Task Review must record a non-PASS Finding");
          }
          if (taskReview.round !== task.review_attempts) {
            throw new RockSpecError("REVIEW_ROUND_MISMATCH", `Task ${taskId} Review uses the wrong round`, {
              task_id: taskId,
              expected_round: task.review_attempts,
              reported_round: taskReview.round,
            });
          }
          change.reviews[`task:${taskId}`] = taskReview;
          task.review_attempts += 1;
          actionPassed = change.reviews[`task:${taskId}`]?.verdict === "PASS";
          break;
        }
        case "acceptance.validate":
          await requireArtifacts(changeDir, ["testing/test-plan.md", "testing/test-report.md"]);
          await this.assertNoUncommittedProductChanges(context.root);
          change.reviews.acceptance = await this.loadAcceptanceReview(
            changeDir,
            change,
            await git(context.root, ["rev-parse", "HEAD"]),
            Object.values(change.tasks)
              .map((task) => task.execution_id)
              .filter((execution): execution is string => Boolean(execution)),
            input.verdict,
          );
          actionPassed = change.reviews.acceptance.verdict === "PASS";
          if (actionPassed) {
            await this.assertFreshEvidence(context.root, change, { actionId: "acceptance.validate" }, true);
            if (change.prototype.required) {
              await this.assertPrototypeEvidence(context.root, change);
            }
            change.state = change.uat.policy === "required" ? "UAT_PENDING" : "FINAL_REVIEW";
          }
          break;
        case "delivery.review": {
          await this.assertNoUncommittedProductChanges(context.root);
          if (!change.base_commit) throw new RockSpecError("BASE_COMMIT_MISSING", "Change has no base commit");
          const reviewPackage = await this.writeReviewPackage(
            context.root,
            changeDir,
            change,
            "delivery",
            change.base_commit,
            await git(context.root, ["rev-parse", "HEAD"]),
          );
          const implementerExecutions = Object.values(change.tasks)
            .map((task) => task.execution_id)
            .filter((execution): execution is string => Boolean(execution));
          change.reviews.delivery = await this.loadCodeReview(
            changeDir,
            change,
            change.profile,
            "reviews/delivery-review.md",
            reviewPackage.subject,
            implementerExecutions,
            [],
            input.verdict,
          );
          actionPassed = change.reviews.delivery.verdict === "PASS";
          if (actionPassed) {
            const unassigned = await this.findUnassignedProductCommits(context.root, change);
            if (unassigned.length > 0) {
              throw new RockSpecError(
                "UNASSIGNED_PRODUCT_COMMIT_REVIEW_REQUIRED",
                "Delivery Review must record an Open Finding for every unassigned product or test Commit",
                {
                  change_id: change.id,
                  commits: unassigned,
                  recommended_next: {
                    action: "delivery.review",
                    instruction: "Update the Delivery Review with a Finding routed to plan.create, then resubmit it as CHANGES_REQUIRED",
                  },
                },
              );
            }
          }
          if (actionPassed) change.state = "VERIFYING";
          else if (recoveryDirective(change)?.kind === "action") {
            await archiveReviewAttempt(changeDir, "reviews/delivery-review.md", "delivery-review");
            delete change.reviews.delivery;
            change.state = "ACCEPTANCE_VALIDATING";
          }
          break;
        }
        case "knowledge.evolve":
          await this.completeKnowledgeEvolution(changeDir, change, context);
          break;
      }
      if (actionPassed && !change.completed_actions.includes(input.action)) change.completed_actions.push(input.action);
      if (actionPassed) clearFailedReconciliation(change, input.action);
      if (input.action !== "task.execute") this.completeActionExecutions(change, input.action);
      await this.refreshArtifacts(changeDir, change);
      return { action: input.action, passed: actionPassed };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async completeUat(input: CompleteUatInput = {}): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "action.acceptance.uat.completed", async (change, changeDir, context) => {
      if (change.state !== "UAT_PENDING" || change.uat.policy !== "required") {
        throw new RockSpecError("UAT_NOT_REQUIRED", "This Change is not waiting for required user acceptance", {
          state: change.state,
          policy: change.uat.policy,
        });
      }
      const relativePath = input.reportPath ?? "testing/uat-report.md";
      const content = await readFile(path.join(changeDir, relativePath), "utf8").catch(() => null);
      if (!content) {
        throw new RockSpecError("UAT_REPORT_MISSING", "Required UAT needs a confirmation report", { path: relativePath });
      }
      await this.assertMaterialized(changeDir, [relativePath]);
      let document;
      try {
        document = UatDocumentSchema.parse(parseFrontmatter(content, relativePath));
      } catch (error) {
        throw new RockSpecError("UAT_REPORT_INVALID", "UAT report Frontmatter is invalid", {
          path: relativePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const currentCommit = await git(context.root, ["rev-parse", "HEAD"]);
      if (document.commit !== currentCommit) {
        throw new RockSpecError("STALE_UAT", "UAT confirmation does not cover the current Commit", {
          reported_commit: document.commit,
          current_commit: currentCommit,
        });
      }
      const scenarios = (await this.loadSpecTraceability(changeDir)).scenarioRequirement;
      const unknown = document.scenario_ids.filter((scenarioId) => !scenarios.has(scenarioId));
      if (unknown.length > 0) {
        throw new RockSpecError("UAT_SCENARIO_NOT_FOUND", "UAT references unknown Scenarios", { scenario_ids: unknown });
      }
      change.uat = {
        policy: "required",
        status: "confirmed",
        report_path: relativePath,
        report_hash: sha256(content),
        commit: currentCommit,
        confirmed_at: this.timestamp(),
      };
      if (!change.completed_actions.includes("acceptance.uat")) change.completed_actions.push("acceptance.uat");
      change.state = "FINAL_REVIEW";
      await this.refreshArtifacts(changeDir, change);
      return { report_path: relativePath, commit: currentCommit, scenario_ids: document.scenario_ids };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async approve(input: ApproveInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, `approval.${input.gate}.recorded`, async (change, changeDir) => {
      this.assertApprovalState(change, input.gate);
      await this.assertApprovalPrerequisites(changeDir, change, input.gate);
      const packagePath = `runtime/approvals/${input.gate}-package.yaml`;
      const packageContent = await readFile(path.join(changeDir, packagePath), "utf8").catch(() => null);
      if (!packageContent) {
        throw new RockSpecError("APPROVAL_PACKAGE_MISSING", "Prepare and present the Approval Package before recording approval", {
          gate: input.gate,
          path: packagePath,
        });
      }
      const packageHash = sha256(packageContent);
      if (packageHash !== input.packageHash) {
        throw new RockSpecError("APPROVAL_PACKAGE_MISMATCH", "Approval does not bind the prepared package", {
          gate: input.gate,
          expected: packageHash,
          supplied: input.packageHash,
        });
      }
      const parsedPackage = ApprovalPackageSchema.safeParse(parse(packageContent));
      if (!parsedPackage.success || parsedPackage.data.gate !== input.gate) {
        throw new RockSpecError("APPROVAL_PACKAGE_INVALID", "Approval Package is invalid or targets another Gate", {
          gate: input.gate,
          issues: parsedPackage.success ? [] : parsedPackage.error.issues,
        });
      }
      const hashes = await hashPaths(
        changeDir,
        approvalPaths(input.gate, change.prototype.required),
      );
      if (hashes.aggregate_hash !== parsedPackage.data.aggregate_hash ||
          JSON.stringify(hashes.artifact_hashes) !== JSON.stringify(parsedPackage.data.artifact_hashes)) {
        throw new RockSpecError("STALE_APPROVAL_PACKAGE", "Gate artifacts changed after the Approval Package was prepared", {
          gate: input.gate,
          prepared: parsedPackage.data.aggregate_hash,
          current: hashes.aggregate_hash,
        });
      }
      const approval: ApprovalRecord = {
        gate: input.gate,
        ...hashes,
        approved_by: input.approvedBy ?? "user",
        approved_at: this.timestamp(),
        mode: "human",
        authority_basis_hash: hashes.aggregate_hash,
        package_path: packagePath,
        package_hash: packageHash,
      };
      change.approvals[input.gate] = approval;
      const activeRevision = change.revisions.find((revision) => revision.status === "open");
      if (activeRevision && revisionGatePolicy(activeRevision, input.gate) === "human") {
        activeRevision.author_execution_id ??= `human-approval:${approval.approved_by}`;
      }
      if (input.gate === "spec") change.state = "SPEC_APPROVED";
      else if (input.gate === "design") change.state = "DESIGN_APPROVED";
      else change.state = "READY";
      await this.reconcileRevisionIfComplete(changeDir, change, input.gate);
      return { gate: input.gate, aggregate_hash: approval.aggregate_hash };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async prepareApproval(input: PrepareApprovalInput): Promise<ApprovalPackageResult> {
    let prepared: ApprovalPackageResult | undefined;
    await this.mutate(input.changeId, `approval.${input.gate}.package.prepared`, async (change, changeDir) => {
      this.assertApprovalState(change, input.gate);
      await this.assertApprovalPrerequisites(changeDir, change, input.gate);
      const hashes = await hashPaths(changeDir, approvalPaths(input.gate, change.prototype.required));
      const proposalContent = await readFile(path.join(changeDir, "proposal.md"), "utf8");
      const proposal = ProposalDefinitionSchema.parse(parseFrontmatter(proposalContent, "proposal.md"));
      const traceability = await this.loadSpecTraceability(changeDir);
      const decisionIds = input.gate === "spec"
        ? []
        : parseDesignDefinition(await readFile(path.join(changeDir, "design.md"), "utf8"), "design.md")
          .decisions.map((decision) => decision.id).sort();
      const taskIds = input.gate === "implementation" ? Object.keys(change.tasks).sort() : [];
      const summary = {
        non_goals: proposal.non_goals,
        assumptions: proposal.assumptions,
        open_questions: proposal.open_questions,
        requirement_ids: [...traceability.requirementScenarios.keys()].sort(),
        scenario_ids: [...traceability.scenarioRequirement.keys()].sort(),
        decision_ids: decisionIds,
        task_ids: taskIds,
      };
      const document = ApprovalPackageSchema.parse({
        schema_version: 1,
        gate: input.gate,
        generated_at: this.timestamp(),
        ...hashes,
        summary,
      });
      const content = stringify(document, { lineWidth: 0 });
      const relativePath = `runtime/approvals/${input.gate}-package.yaml`;
      const packageHash = sha256(content);
      await atomicWrite(path.join(changeDir, relativePath), content);
      prepared = {
        schema_version: 1,
        gate: input.gate,
        path: relativePath,
        hash: packageHash,
        ...hashes,
        summary,
      };
      return { gate: input.gate, path: relativePath, hash: packageHash };
    });
    if (!prepared) throw new RockSpecError("INTERNAL_ERROR", "Approval Package was not prepared");
    return prepared;
  }

  async prepareReconciliation(input: ReconciliationInput): Promise<ReconciliationPackageResult> {
    let prepared: ReconciliationPackageResult | undefined;
    await this.mutate(input.changeId, "reconciliation.package.prepared", async (change, changeDir) => {
      const revision = this.assertAutoReconciliation(change, input.gate);
      this.assertApprovalState(change, input.gate);
      await this.assertApprovalPrerequisites(changeDir, change, input.gate);
      const subject = await hashPaths(changeDir, approvalPaths(input.gate, change.prototype.required));
      const authorityBasisHash = revision.authority_baselines[input.gate];
      if (!authorityBasisHash || !revision.author_execution_id) {
        throw new RockSpecError("RECONCILIATION_BASELINE_MISSING", "Auto reconciliation requires an invalidated authority baseline and Author identity", {
          revision_id: revision.id,
          gate: input.gate,
        });
      }
      const reportPath = `revisions/${revision.id}/reviews/${input.gate}-reconciliation-review.md`;
      prepared = {
        revision_id: revision.id,
        gate: input.gate,
        round: revision.convergence_round,
        author_execution_id: revision.author_execution_id,
        classifications: revision.classifications,
        finding_ids: revision.trigger?.finding_ids ?? [],
        authority_basis_hash: authorityBasisHash,
        report_path: reportPath,
        subject,
      };
      await atomicWrite(
        path.join(changeDir, `revisions/${revision.id}/reviews/${input.gate}-reconciliation-package.yaml`),
        stringify({ schema_version: 1, ...prepared }, { lineWidth: 0 }),
      );
      await atomicWrite(
        path.join(changeDir, reportPath),
        reconciliationReviewTemplate(prepared),
      );
      return { revision_id: revision.id, gate: input.gate, round: revision.convergence_round, report_path: reportPath };
    });
    if (!prepared) throw new RockSpecError("INTERNAL_ERROR", "Reconciliation package was not created");
    return prepared;
  }

  async completeReconciliation(input: CompleteReconciliationInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, `reconciliation.${input.gate}.reviewed`, async (change, changeDir, context) => {
      const revision = this.assertAutoReconciliation(change, input.gate);
      this.assertApprovalState(change, input.gate);
      await this.assertApprovalPrerequisites(changeDir, change, input.gate);
      const relativePath = `revisions/${revision.id}/reviews/${input.gate}-reconciliation-review.md`;
      const absolutePath = path.join(changeDir, relativePath);
      if (!(await exists(absolutePath))) {
        throw new RockSpecError("MISSING_RECONCILIATION_REVIEW", "Prepare and complete an independent Reconciliation Review first", {
          revision_id: revision.id,
          gate: input.gate,
          path: relativePath,
        });
      }
      const content = await readFile(absolutePath, "utf8");
      const review = parseReconciliationReviewDocument(content, relativePath);
      this.assertRegisteredExecution(
        change,
        review.reviewer_execution_id,
        "reconciliation_reviewer",
        `reconcile.${input.gate}`,
      );
      if (review.revision_id !== revision.id || review.gate !== input.gate || review.round !== revision.convergence_round) {
        throw new RockSpecError("RECONCILIATION_SUBJECT_MISMATCH", "Reconciliation Review targets the wrong Revision, Gate, or round", {
          expected: { revision_id: revision.id, gate: input.gate, round: revision.convergence_round },
          reported: { revision_id: review.revision_id, gate: review.gate, round: review.round },
        });
      }
      if (review.reviewer_execution_id === revision.author_execution_id) {
        throw new RockSpecError("RECONCILIATION_REVIEWER_NOT_INDEPENDENT", "Reconciliation Reviewer must differ from the Revision Author", {
          execution_id: review.reviewer_execution_id,
        });
      }
      if (input.verdict && input.verdict !== review.verdict) {
        throw new RockSpecError("REVIEW_VERDICT_MISMATCH", "Reported verdict does not match the Reconciliation Review", {
          reported: input.verdict,
          artifact: review.verdict,
        });
      }
      if (JSON.stringify([...review.classifications].sort()) !== JSON.stringify([...revision.classifications].sort()) ||
          JSON.stringify([...review.finding_ids].sort()) !== JSON.stringify([...(revision.trigger?.finding_ids ?? [])].sort())) {
        throw new RockSpecError("RECONCILIATION_SCOPE_MISMATCH", "Reconciliation Review must cover every Revision classification and triggering Finding", {
          expected_classifications: revision.classifications,
          expected_finding_ids: revision.trigger?.finding_ids ?? [],
          reported_classifications: review.classifications,
          reported_finding_ids: review.finding_ids,
        });
      }
      const current = await hashPaths(changeDir, approvalPaths(input.gate, change.prototype.required));
      if (current.aggregate_hash !== review.subject.aggregate_hash ||
          JSON.stringify(current.artifact_hashes) !== JSON.stringify(review.subject.artifact_hashes)) {
        throw new RockSpecError("STALE_RECONCILIATION_REVIEW", "Reconciliation Review does not cover the current Gate artifacts", {
          reviewed: review.subject,
          current,
        });
      }
      const reportHash = sha256(content);
      revision.last_reconciliation = {
        gate: input.gate,
        verdict: review.verdict,
        reviewer_execution_id: review.reviewer_execution_id,
        authority_delta: review.authority_delta,
        report_path: relativePath,
        report_hash: reportHash,
        aggregate_hash: current.aggregate_hash,
        round: revision.convergence_round,
        reviewed_at: this.timestamp(),
      };
      await archiveReconciliationReview(changeDir, revision.id, input.gate, revision.convergence_round, relativePath);

      if (review.authority_delta !== "unchanged") {
        revision.approval_policy = "human";
        revision.gate_policies[input.gate] = "human";
        revision.authority_delta = review.authority_delta;
        revision.escalation_reason = "Independent Reviewer found a changed or unknown authority boundary";
        await this.writeRevision(changeDir, revision);
        return { revision_id: revision.id, gate: input.gate, passed: false, approval_policy: "human" };
      }
      if (review.verdict !== "PASS") {
        const maximum = context.config.max_reconciliation_rounds;
        if (revision.convergence_round >= maximum) {
          revision.approval_policy = "human";
          revision.gate_policies[input.gate] = "human";
          revision.escalation_reason = `Reconciliation did not converge within ${maximum} rounds`;
        } else {
          revision.convergence_round += 1;
        }
        await this.writeRevision(changeDir, revision);
        return { revision_id: revision.id, gate: input.gate, passed: false, approval_policy: revision.approval_policy };
      }

      const authorityBasisHash = revision.authority_baselines[input.gate];
      if (!authorityBasisHash) throw new RockSpecError("RECONCILIATION_BASELINE_MISSING", "Authority baseline is missing");
      const approval: ApprovalRecord = {
        gate: input.gate,
        ...current,
        approved_by: `ai:${review.reviewer_execution_id}`,
        approved_at: this.timestamp(),
        mode: "auto",
        revision_id: revision.id,
        authority_basis_hash: authorityBasisHash,
      };
      change.approvals[input.gate] = approval;
      revision.auto_approvals.push({
        gate: input.gate,
        reviewer_execution_id: review.reviewer_execution_id,
        report_path: relativePath,
        report_hash: reportHash,
        aggregate_hash: current.aggregate_hash,
        authority_basis_hash: authorityBasisHash,
        approved_at: approval.approved_at,
      });
      if (input.gate === "spec") change.state = "SPEC_APPROVED";
      else if (input.gate === "design") change.state = "DESIGN_APPROVED";
      else change.state = "READY";
      await this.reconcileRevisionIfComplete(changeDir, change, input.gate);
      await this.writeRevision(changeDir, revision);
      return { revision_id: revision.id, gate: input.gate, passed: true, approval_policy: "auto" };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async promote(input: PromoteInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "change.promoted", async (change, changeDir) => {
      const ranks: Record<WorkflowProfile, number> = { lite: 0, standard: 1, strict: 2 };
      if (ranks[input.profile] <= ranks[change.profile]) {
        throw new RockSpecError("INVALID_PROMOTION", "Profiles can only be promoted upward", {
          current_profile: change.profile,
          requested_profile: input.profile,
        });
      }
      if (change.state === "READY_TO_FINISH" || change.state === "ARCHIVED") {
        throw new RockSpecError("ILLEGAL_PROMOTION", "A finished or archived Change cannot be promoted", {
          state: change.state,
        });
      }
      const previousProfile = change.profile;
      change.profile = input.profile;
      change.state = "SCOPING";
      change.approvals = {};
      change.reviews = {};
      change.verification = { status: "pending" };
      resetUat(change);
      await this.ensureTemplates(changeDir, change);
      return { previous_profile: previousProfile, profile: input.profile };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async revise(input: ReviseInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "change.revision.started", async (change, changeDir, context) => {
      if (change.profile === "lite") {
        throw new RockSpecError("REVISION_NOT_SUPPORTED", "Promote a Lite Change before opening a cross-stage revision");
      }
      if (change.revisions.some((revision) => revision.status === "open")) {
        throw new RockSpecError("REVISION_ALREADY_OPEN", "Reconcile the active Revision before opening another one");
      }
      const feedbackBatch = input.feedbackBatchId
        ? change.feedback_batches.find((batch) => batch.id === input.feedbackBatchId)
        : undefined;
      if (input.feedbackBatchId && (!feedbackBatch || feedbackBatch.route !== "same_change")) {
        throw new RockSpecError("FEEDBACK_BATCH_NOT_FOUND", "Same-Change feedback batch is missing or routed to a new Change", {
          feedback_batch_id: input.feedbackBatchId,
        });
      }
      const recoveryStates: ChangeSnapshot["state"][] = ["IMPLEMENTING", "ACCEPTANCE_VALIDATING", "FINAL_REVIEW"];
      const mode = feedbackBatch
        ? "feedback_reopen" as const
        : recoveryStates.includes(change.state) ? "implementation_recovery" as const : "pre_implementation" as const;
      let source = input.source;
      let target = input.target;
      let revisionKind: "upstream" | "remediation" = "upstream";
      let trigger: RevisionRecord["trigger"];
      let classifications: RevisionRecord["classifications"] = [input.classification ?? "decision_change"];
      let authorityDelta: RevisionRecord["authority_delta"] = input.authorityDelta ?? "unknown";
      let approvalPolicy: RevisionRecord["approval_policy"] = isAutoRevision(classifications, authorityDelta)
        ? "auto"
        : "human";
      const interactionMode = feedbackBatch?.interaction_mode;

      if (mode === "feedback_reopen") {
        source = input.source ?? "acceptance.validate";
        target = input.target ?? feedbackBatch?.target;
        if (!target) throw new RockSpecError("FEEDBACK_TARGET_REQUIRED", "Same-Change feedback must identify its earliest affected target");
        revisionKind = "upstream";
        if (interactionMode === "reconcile") {
          classifications = ["consistency_fix"];
          authorityDelta = "unchanged";
          approvalPolicy = "auto";
        } else {
          classifications = ["decision_change"];
          authorityDelta = "changed";
          approvalPolicy = "human";
        }
      } else if (mode === "implementation_recovery") {
        const recovery = recoveryDirective(change);
        if (!recovery || recovery.kind !== "revision" || !recovery.target || !recovery.revision_kind) {
          throw new RockSpecError("RECOVERY_FINDING_REQUIRED", "Implementation recovery requires an Open Finding routed upstream or to remediation planning", {
            state: change.state,
          });
        }
        const findingIds = input.consumeCurrentRecovery
          ? recovery.finding_ids
          : [...new Set(input.findingIds ?? [])].sort();
        const reviewId = input.consumeCurrentRecovery ? recovery.review_id : input.reviewId;
        if (reviewId !== recovery.review_id ||
            JSON.stringify(findingIds) !== JSON.stringify(recovery.finding_ids)) {
          throw new RockSpecError("RECOVERY_TRIGGER_MISMATCH", "Recovery must bind every Open Finding in the Engine recommendation", {
            change_id: change.id,
            expected_review_id: recovery.review_id,
            expected_finding_ids: recovery.finding_ids,
            provided_review_id: reviewId ?? null,
            provided_finding_ids: findingIds,
          });
        }
        if (source && source !== recovery.source) {
          throw new RockSpecError("RECOVERY_SOURCE_MISMATCH", "Recovery source does not match the triggering Review", {
            change_id: change.id,
            expected: recovery.source,
            provided: source,
          });
        }
        if (target && target !== recovery.target) {
          throw new RockSpecError("RECOVERY_TARGET_MISMATCH", "Recovery target must be the earliest responsible capability", {
            change_id: change.id,
            expected: recovery.target,
            provided: target,
          });
        }
        const review = change.reviews[recovery.review_id];
        if (!review) throw new RockSpecError("RECOVERY_REVIEW_MISSING", "The triggering Review is no longer available");
        source = recovery.source;
        target = recovery.target;
        revisionKind = recovery.revision_kind;
        classifications = recovery.classifications ?? ["decision_change"];
        authorityDelta = recovery.authority_delta ?? "unknown";
        approvalPolicy = recovery.approval_policy ?? "human";
        trigger = {
          review_id: recovery.review_id,
          finding_ids: recovery.finding_ids,
          review_hash: review.report_hash ?? review.content_hash,
        };
      } else {
        if (["VERIFYING", "READY_TO_FINISH"].includes(change.state)) {
          throw new RockSpecError("REVISION_TOO_LATE", "Verification or finishing requires an explicit post-review recovery path", {
            state: change.state,
          });
        }
        if (!source || !target) {
          throw new RockSpecError("REVISION_ROUTE_REQUIRED", "Pre-implementation Revision requires source and target");
        }
      }

      if (!source || !target) throw new RockSpecError("REVISION_ROUTE_REQUIRED", "Revision source and target are required");
      if (approvalPolicy === "auto" && !input.authorExecutionId?.trim()) {
        throw new RockSpecError("REVISION_AUTHOR_REQUIRED", "Auto Revision requires --author-execution for Reviewer independence", {
          change_id: change.id,
        });
      }
      assertRevisionTargetAllowed(change, target);
      const reason = input.reason.trim() ||
        (input.consumeCurrentRecovery && trigger ? recoveryRevisionReason(change, trigger.review_id, trigger.finding_ids) : "");
      const affectedIds = [...new Set(input.affectedIds)].sort();
      if (!reason) throw new RockSpecError("REVISION_REASON_REQUIRED", "Revision reason must not be empty");
      if ((revisionKind === "upstream" && affectedIds.length === 0) || affectedIds.some((id) => !/^[RSD]-\d{3,}$/.test(id))) {
        throw new RockSpecError("INVALID_REVISION_IDS", "Revision affected IDs must be unique R-/S-/D- IDs", {
          affected_ids: input.affectedIds,
        });
      }

      const beforeHashes = await this.revisionHashes(changeDir);
      const invalidatedApprovals = revisionApprovals(target, change.approvals);
      const authorityBaselines = Object.fromEntries(
        invalidatedApprovals.flatMap((gate) => {
          const approval = change.approvals[gate];
          return approval ? [[gate, approval.authority_basis_hash ?? approval.aggregate_hash] as const] : [];
        }),
      );
      if (interactionMode === "reconcile" && !authorityBaselines[feedbackAuthorityGate(target)]) {
        throw new RockSpecError(
          "FEEDBACK_AUTHORITY_BASELINE_REQUIRED",
          "Reconcile feedback requires an existing approved Authority Baseline for its target Gate",
          { target, gate: feedbackAuthorityGate(target) },
        );
      }
      const invalidatedReviews = revisionReviews(target, change.reviews, mode);
      const invalidatedActions = revisionActions(target, change.completed_actions, mode);
      const revision: RevisionRecord = {
        id: `RV-${String(change.revisions.length + 1).padStart(3, "0")}`,
        source,
        target,
        mode,
        ...(interactionMode ? { interaction_mode: interactionMode } : {}),
        kind: revisionKind,
        status: "open" as const,
        reason,
        affected_ids: affectedIds,
        classifications,
        approval_policy: approvalPolicy,
        gate_policies: revisionGatePolicies(target, invalidatedApprovals, approvalPolicy),
        authority_delta: authorityDelta,
        ...(input.authorExecutionId?.trim() ? { author_execution_id: input.authorExecutionId.trim() } : {}),
        authority_baselines: authorityBaselines,
        convergence_round: 1,
        auto_approvals: [],
        amendments: [],
        ...(trigger ? { trigger } : {}),
        before_hashes: beforeHashes,
        after_hashes: {},
        invalidated_approvals: invalidatedApprovals,
        invalidated_reviews: invalidatedReviews,
        invalidated_actions: invalidatedActions,
        started_at: this.timestamp(),
      };
      change.revisions.push(revision);
      if (feedbackBatch) {
        feedbackBatch.status = "routed";
        feedbackBatch.revision_id = revision.id;
      }
      await this.snapshotRevisionArtifacts(changeDir, revision.id, target, mode);
      if (mode === "implementation_recovery") {
        applyImplementationRecoveryInvalidation(
          change,
          target,
          revision.id,
          revision.invalidated_approvals,
          revision.invalidated_reviews,
          revision.invalidated_actions,
          await git(context.root, ["rev-parse", "HEAD"]),
          this.timestamp(),
        );
      } else if (mode === "feedback_reopen") {
        applyFeedbackRevisionInvalidation(change, target);
      } else {
        applyPreImplementationRevisionInvalidation(change, target);
      }
      await mkdir(path.join(changeDir, "revisions"), { recursive: true });
      await atomicWrite(path.join(changeDir, "revisions", `${revision.id}.yaml`), stringify(revision, { lineWidth: 0 }));
      return {
        revision_id: revision.id,
        target,
        mode,
        ...(interactionMode ? { interaction_mode: interactionMode } : {}),
        kind: revisionKind,
        classifications,
        approval_policy: approvalPolicy,
        authority_delta: authorityDelta,
        affected_ids: affectedIds,
        invalidated_approvals: invalidatedApprovals,
        invalidated_reviews: invalidatedReviews,
        invalidated_actions: invalidatedActions,
      };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async applyRecovery(input: ApplyRecoveryInput = {}): Promise<StatusResult> {
    const status = await this.getStatus(input);
    const recovery = status.recovery;
    if (!recovery) {
      throw new RockSpecError("RECOVERY_NOT_AVAILABLE", "The Change has no current Finding-bound recovery", {
        change_id: status.change.id,
        state: status.current_state,
      });
    }
    if (recovery.kind !== "revision") {
      throw new RockSpecError("RECOVERY_ACTION_REQUIRED", "The current recovery continues through an existing Action, not a Revision", {
        change_id: status.change.id,
        route_to: recovery.route_to,
        recommended_next: status.recommended_next,
      });
    }
    const revisionInput: ReviseInput = {
      changeId: status.change.id,
      reason: input.reason?.trim() ?? "",
      affectedIds: input.affectedIds ?? [],
      ...(input.authorExecutionId?.trim() ? { authorExecutionId: input.authorExecutionId.trim() } : {}),
      consumeCurrentRecovery: true,
    };
    return status.change.revisions.some((revision) => revision.status === "open")
      ? this.amendRevision(revisionInput)
      : this.revise(revisionInput);
  }

  async submitFeedback(input: FeedbackSubmitInput): Promise<StatusResult> {
    const reason = input.reason.trim();
    const items = input.items.map((item) => item.trim()).filter(Boolean);
    const interactionMode = input.interactionMode ?? "compact";
    if (!reason) throw new RockSpecError("FEEDBACK_REASON_REQUIRED", "Feedback reason must not be empty");
    if (items.length === 0) throw new RockSpecError("FEEDBACK_ITEMS_REQUIRED", "At least one feedback item is required");
    if (input.route === "same_change" && !input.target) {
      throw new RockSpecError("FEEDBACK_TARGET_REQUIRED", "Same-Change feedback must identify its earliest affected target");
    }
    if (interactionMode === "reconcile" && !input.authorExecutionId?.trim()) {
      throw new RockSpecError("REVISION_AUTHOR_REQUIRED", "Reconcile feedback requires --author-execution for Reviewer independence");
    }
    const result = await this.mutate(input.changeId, "feedback.submitted", async (change, changeDir) => {
      if (change.state === "ARCHIVED") {
        throw new RockSpecError("CHANGE_ARCHIVED", "Archived Changes cannot receive feedback", { change_id: change.id });
      }
      if (interactionMode === "reconcile" && input.target) {
        const gate = feedbackAuthorityGate(input.target);
        const approval = change.approvals[gate];
        if (!approval?.authority_basis_hash && !approval?.aggregate_hash) {
          throw new RockSpecError(
            "FEEDBACK_AUTHORITY_BASELINE_REQUIRED",
            "Reconcile feedback requires an existing approved Authority Baseline for its target Gate",
            { target: input.target, gate },
          );
        }
      }
      const batch: ChangeSnapshot["feedback_batches"][number] = {
        schema_version: 1,
        id: `FB-${String(change.feedback_batches.length + 1).padStart(3, "0")}`,
        source: "user_acceptance",
        route: input.route,
        interaction_mode: interactionMode,
        status: "submitted",
        reason,
        items: items.map((description, index) => ({
          id: `FB-ITEM-${String(index + 1).padStart(3, "0")}`,
          description,
        })),
        ...(input.target ? { target: input.target } : {}),
        affected_ids: [...new Set(input.affectedIds ?? [])].sort(),
        ...(input.relatedChangeId ? (assertProtocolChangeId(input.relatedChangeId), { related_change_id: input.relatedChangeId as ChangeSnapshot["id"] }) : {}),
        submitted_by: input.submittedBy?.trim() || "user",
        submitted_at: this.timestamp(),
      };
      change.feedback_batches.push(batch);
      await mkdir(path.join(changeDir, "feedback"), { recursive: true });
      await atomicWrite(path.join(changeDir, "feedback", `${batch.id}.yaml`), stringify(batch, { lineWidth: 0 }));
      return {
        feedback_batch_id: batch.id,
        route: batch.route,
        interaction_mode: batch.interaction_mode,
        target: batch.target ?? null,
      };
    });
    if (input.route === "same_change") {
      const batchId = result.change.feedback_batches.at(-1)?.id;
      if (!batchId || !input.target) throw new RockSpecError("INTERNAL_ERROR", "Feedback batch was not persisted with a target");
      return this.revise({
        ...(input.changeId ? { changeId: input.changeId } : {}),
        feedbackBatchId: batchId,
        source: "acceptance.validate",
        target: input.target,
        reason,
        affectedIds: input.affectedIds ?? [],
        ...(input.authorExecutionId?.trim() ? { authorExecutionId: input.authorExecutionId.trim() } : {}),
      });
    }
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async amendRevision(input: AmendRevisionInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "change.revision.amended", async (change, changeDir, context) => {
      const revision = change.revisions.find((item) => item.status === "open");
      if (!revision) {
        throw new RockSpecError("REVISION_NOT_OPEN", "There is no open Revision to amend");
      }
      const recovery = recoveryDirective(change);
      if (!recovery || recovery.kind !== "revision" || !recovery.target || !recovery.revision_kind) {
        throw new RockSpecError("REVISION_AMENDMENT_FINDING_REQUIRED", "Revision amendment requires a new non-PASS Review with Open Findings");
      }
      const findingIds = input.consumeCurrentRecovery
        ? recovery.finding_ids
        : [...new Set(input.findingIds ?? [])].sort();
      const reviewId = input.consumeCurrentRecovery ? recovery.review_id : input.reviewId;
      if (reviewId !== recovery.review_id ||
          JSON.stringify(findingIds) !== JSON.stringify(recovery.finding_ids)) {
        throw new RockSpecError("RECOVERY_TRIGGER_MISMATCH", "Revision amendment must bind every Open Finding in the Engine recommendation", {
          change_id: change.id,
          expected_review_id: recovery.review_id,
          expected_finding_ids: recovery.finding_ids,
          provided_review_id: reviewId ?? null,
          provided_finding_ids: findingIds,
        });
      }
      if (input.source && input.source !== recovery.source) {
        throw new RockSpecError("RECOVERY_SOURCE_MISMATCH", "Revision amendment source does not match the triggering Review", {
          change_id: change.id,
          expected: recovery.source,
          provided: input.source,
        });
      }
      if (input.target && input.target !== recovery.target) {
        throw new RockSpecError("RECOVERY_TARGET_MISMATCH", "Revision amendment target must be the earliest responsible capability", {
          change_id: change.id,
          expected: recovery.target,
          provided: input.target,
        });
      }
      const review = change.reviews[recovery.review_id];
      if (!review) throw new RockSpecError("RECOVERY_REVIEW_MISSING", "The triggering Review is no longer available");

      const reason = input.reason.trim() ||
        (input.consumeCurrentRecovery
          ? recoveryRevisionReason(change, recovery.review_id, recovery.finding_ids)
          : "");
      const affectedIds = [...new Set(input.affectedIds)].sort();
      if (!reason) throw new RockSpecError("REVISION_REASON_REQUIRED", "Revision amendment reason must not be empty");
      if (affectedIds.some((id) => !/^[RSD]-\d{3,}$/.test(id))) {
        throw new RockSpecError("INVALID_REVISION_IDS", "Revision amendment affected IDs must be unique R-/S-/D- IDs", {
          affected_ids: input.affectedIds,
        });
      }

      const amendmentTarget = recovery.target;
      const target = earlierRevisionTarget(revision.target, amendmentTarget);
      const revisionKind = revision.kind === "upstream" || recovery.revision_kind === "upstream"
        ? "upstream" as const
        : "remediation" as const;
      const mergedAffectedIds = [...new Set([...revision.affected_ids, ...affectedIds])].sort();
      if (revisionKind === "upstream" && mergedAffectedIds.length === 0) {
        throw new RockSpecError("INVALID_REVISION_IDS", "An upstream Revision amendment must identify affected R-/S-/D- IDs");
      }
      const classifications = [...new Set([
        ...revision.classifications,
        ...(recovery.classifications ?? ["decision_change"]),
      ])].sort() as RevisionRecord["classifications"];
      const authorityDelta = worseAuthorityImpact(
        revision.authority_delta,
        recovery.authority_delta ?? "unknown",
      );
      const approvalPolicy = revision.approval_policy === "human" ||
          recovery.approval_policy === "human" ||
          !isAutoRevision(classifications, authorityDelta)
        ? "human" as const
        : "auto" as const;
      const authorExecutionId = input.authorExecutionId?.trim() || revision.author_execution_id;
      if (approvalPolicy === "auto" && !authorExecutionId) {
        throw new RockSpecError("REVISION_AUTHOR_REQUIRED", "Auto Revision amendment requires --author-execution for Reviewer independence", {
          change_id: change.id,
        });
      }

      const beforeHashes = await this.revisionHashes(changeDir);
      const invalidatedApprovals = revisionApprovals(amendmentTarget, change.approvals);
      const invalidatedReviews = revisionReviews(amendmentTarget, change.reviews, revision.mode);
      const invalidatedActions = revisionActions(amendmentTarget, change.completed_actions, revision.mode);
      const amendmentApprovalPolicy = recovery.approval_policy ?? "human";
      const amendmentGatePolicies = revisionGatePolicies(
        amendmentTarget,
        invalidatedApprovals,
        amendmentApprovalPolicy,
      );
      const amendment: RevisionAmendmentRecord = {
        id: `AM-${String(revision.amendments.length + 1).padStart(3, "0")}`,
        source: recovery.source,
        target: recovery.target,
        reason,
        affected_ids: affectedIds,
        classifications: recovery.classifications ?? ["decision_change"],
        approval_policy: amendmentApprovalPolicy,
        gate_policies: amendmentGatePolicies,
        authority_delta: recovery.authority_delta ?? "unknown",
        trigger: {
          review_id: recovery.review_id,
          finding_ids: recovery.finding_ids,
          review_hash: review.report_hash ?? review.content_hash,
        },
        before_hashes: beforeHashes,
        invalidated_approvals: invalidatedApprovals,
        invalidated_reviews: invalidatedReviews,
        invalidated_actions: invalidatedActions,
        amended_at: this.timestamp(),
      };
      await this.snapshotRevisionAmendmentArtifacts(changeDir, revision, amendment, amendmentTarget);

      const newAuthorityBaselines = Object.fromEntries(
        invalidatedApprovals.flatMap((gate) => {
          const approval = change.approvals[gate];
          return approval ? [[gate, approval.authority_basis_hash ?? approval.aggregate_hash] as const] : [];
        }),
      );
      revision.target = target;
      revision.kind = revisionKind;
      revision.affected_ids = mergedAffectedIds;
      revision.classifications = classifications;
      revision.approval_policy = approvalPolicy;
      revision.gate_policies = {
        ...revision.gate_policies,
        ...Object.fromEntries(invalidatedApprovals.map((gate) => [gate, amendmentGatePolicies[gate]])),
      };
      revision.authority_delta = authorityDelta;
      if (authorExecutionId) revision.author_execution_id = authorExecutionId;
      revision.authority_baselines = { ...revision.authority_baselines, ...newAuthorityBaselines };
      revision.amendments.push(amendment);
      revision.invalidated_approvals = [...new Set([...revision.invalidated_approvals, ...invalidatedApprovals])].sort();
      revision.invalidated_reviews = [...new Set([...revision.invalidated_reviews, ...invalidatedReviews])].sort();
      revision.invalidated_actions = [...new Set([...revision.invalidated_actions, ...invalidatedActions])].sort();
      revision.after_hashes = {};
      if (invalidatedApprovals.some((gate) => amendmentGatePolicies[gate] === "human")) {
        revision.escalation_reason = `Amendment ${amendment.id} requires renewed human approval`;
      }
      if (revision.last_reconciliation && invalidatedApprovals.includes(revision.last_reconciliation.gate)) {
        delete revision.last_reconciliation;
      }

      if (revision.mode === "implementation_recovery") {
        applyImplementationRecoveryInvalidation(
          change,
          amendmentTarget,
          revision.id,
          amendment.invalidated_approvals,
          amendment.invalidated_reviews,
          amendment.invalidated_actions,
          await git(context.root, ["rev-parse", "HEAD"]),
          this.timestamp(),
        );
      } else if (revision.mode === "feedback_reopen") {
        applyFeedbackRevisionInvalidation(change, amendmentTarget);
      } else {
        applyPreImplementationRevisionInvalidation(change, amendmentTarget);
      }
      await this.writeRevision(changeDir, revision);
      return {
        revision_id: revision.id,
        amendment_id: amendment.id,
        target: amendmentTarget,
        revision_target: target,
        classifications,
        approval_policy: approvalPolicy,
        authority_delta: authorityDelta,
        affected_ids: mergedAffectedIds,
        invalidated_approvals: invalidatedApprovals,
        invalidated_reviews: invalidatedReviews,
        invalidated_actions: invalidatedActions,
      };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async validate(input: ValidateInput = {}): Promise<ValidationResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId, true);
    const errors = await this.validationErrors(
      context,
      located.changeDir,
      located.change,
      input.gate,
      input.strict ?? false,
    );
    const status = await this.statusFor(context, located.changeDir, located.change);
    return {
      valid: errors.length === 0,
      ...(input.gate ? { gate: input.gate } : {}),
      errors,
      warnings: [],
      status,
    };
  }

  async gate(input: GateInput): Promise<ValidationResult> {
    return this.validate({ ...input, strict: true });
  }

  async recordEvidence(input: RecordEvidenceInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "evidence.recorded", async (change, changeDir, context) => {
      const now = this.timestamp();
      const commit = input.commit ?? (await git(context.root, ["rev-parse", "HEAD"]));
      const scenarioIds = [...new Set(input.scenarioIds ?? [])].sort();
      if (scenarioIds.length > 0) {
        const known = (await this.loadSpecTraceability(changeDir)).scenarioRequirement;
        const unknown = scenarioIds.filter((scenarioId) => !known.has(scenarioId));
        if (unknown.length > 0) {
          throw new RockSpecError("EVIDENCE_SCENARIO_NOT_FOUND", "Evidence references unknown Scenarios", { scenario_ids: unknown });
        }
      }
      const record = {
        id: `E-${String(change.evidence.length + 1).padStart(3, "0")}`,
        kind: input.kind ?? "verification",
        command: input.command,
        cwd: input.cwd ?? context.root,
        started_at: input.startedAt ?? now,
        finished_at: input.finishedAt ?? now,
        exit_code: input.exitCode,
        commit,
        source: input.source ?? "recorded",
        scenario_ids: scenarioIds,
        finding_ids: [...new Set(input.findingIds ?? [])].sort(),
        artifact_paths: [...new Set(input.artifactPaths ?? [])].sort(),
        ...(input.taskId ? { task_id: input.taskId } : {}),
        ...(input.actionId ? { action_id: input.actionId } : {}),
        ...(input.reportPath ? { report_path: input.reportPath } : {}),
        ...(input.outputHash ? { output_hash: input.outputHash } : {}),
      };
      change.evidence.push(record);
      await atomicWrite(
        path.join(changeDir, "evidence", "verification.yaml"),
        stringify({ schema_version: 1, evidence: change.evidence }, { lineWidth: 0 }),
      );
      return { evidence_id: record.id, commit, exit_code: record.exit_code };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async runCheck(input: RunCheckInput): Promise<RunCheckResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    await this.assertWorkspaceBinding(context, located.change);
    const executable = input.executable.trim();
    if (!executable) throw new RockSpecError("INVALID_CHECK_COMMAND", "Check executable cannot be empty");

    const command = formatCommand(executable, input.args ?? []);
    const commit = await git(context.root, ["rev-parse", "HEAD"]);
    const taskScenarioIds = input.taskId ? located.change.tasks[input.taskId]?.scenario_ids : undefined;
    const scenarioIds = [...new Set(input.scenarioIds ?? taskScenarioIds ?? [])].sort();
    const findingIds = [...new Set(input.findingIds ?? [])].sort();
    const artifactPaths = [...new Set(input.artifactPaths ?? [])].sort();
    if (input.reuseCachedEvidence !== false) {
      const cached = await this.findReusableEvidence(
        located.changeDir,
        located.change,
        {
          command,
          commit,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.actionId ? { actionId: input.actionId } : {}),
          scenarioIds,
          findingIds,
          artifactPaths,
        },
      );
      if (cached) {
        return {
          ...await this.statusFor(context, located.changeDir, located.change),
          check: {
            evidence_id: cached.id,
            command,
            exit_code: cached.exit_code,
            output_hash: cached.output_hash!,
            report_path: cached.report_path!,
            cached: true,
          },
        };
      }
    }

    const startedAt = this.timestamp();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const result = await execFileAsync(executable, input.args ?? [], {
        cwd: context.root,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? failure.message;
      exitCode = typeof failure.code === "number" ? failure.code : 1;
    }
    const finishedAt = this.timestamp();
    const output = [
      `command: ${command}`,
      `cwd: ${context.root}`,
      `started_at: ${startedAt}`,
      `finished_at: ${finishedAt}`,
      `exit_code: ${exitCode}`,
      "",
      "## stdout",
      stdout,
      "",
      "## stderr",
      stderr,
      "",
    ].join("\n");
    const reportPath = `evidence/logs/check-${randomUUID()}.log`;
    await atomicWrite(path.join(located.changeDir, reportPath), output);
    const outputHash = sha256(output);
    const status = await this.recordEvidence({
      ...(input.changeId ? { changeId: input.changeId } : {}),
      command,
      exitCode,
      startedAt,
      finishedAt,
      kind: input.kind ?? "verification",
      source: "executed",
      outputHash,
      reportPath,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.actionId ? { actionId: input.actionId } : {}),
      scenarioIds,
      findingIds,
      artifactPaths,
    });
    const evidence = status.change.evidence.at(-1);
    if (!evidence) throw new RockSpecError("INTERNAL_ERROR", "Executed check produced no evidence record");
    return {
      ...status,
      check: {
        evidence_id: evidence.id,
        command,
        exit_code: exitCode,
        output_hash: outputHash,
        report_path: reportPath,
        cached: false,
      },
    };
  }

  async listTasks(input: ChangeInput = {}): Promise<TaskRecord[]> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    return Object.values(located.change.tasks).sort((left, right) => left.id.localeCompare(right.id));
  }

  async nextTask(input: ChangeInput = {}): Promise<TaskRecord | null> {
    const tasks = await this.listTasks(input);
    return tasks.find((task) => task.status === "in_progress") ??
      tasks.find((task) => task.status === "suspended" && taskDependenciesComplete(task, tasks)) ??
      tasks.find((task) => task.status === "pending" && taskDependenciesComplete(task, tasks)) ??
      null;
  }

  async startTask(input: StartTaskInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "task.started", async (change, changeDir, context) => {
      if (change.state !== "READY" && change.state !== "IMPLEMENTING") {
        throw new RockSpecError("ILLEGAL_ACTION", `Tasks cannot start while the Change is ${change.state}`, {
          state: change.state,
          task_id: input.taskId,
        });
      }
      if (change.execution.active_task && change.execution.active_task !== input.taskId) {
        throw new RockSpecError("TASK_ALREADY_ACTIVE", `Task ${change.execution.active_task} is already active`, {
          active_task: change.execution.active_task,
        });
      }
      await this.assertApprovalClosure(changeDir, change, ["spec", "design", "implementation"]);
      const task = change.tasks[input.taskId];
      if (!task) throw new RockSpecError("TASK_NOT_FOUND", `Task ${input.taskId} does not exist`);
      if (task.status === "completed") {
        throw new RockSpecError("TASK_ALREADY_COMPLETED", `Task ${input.taskId} is already completed`);
      }
      if (task.status === "superseded") {
        throw new RockSpecError("TASK_SUPERSEDED", `Task ${input.taskId} was superseded by ${task.superseded_by}`, {
          task_id: input.taskId,
          superseded_by: task.superseded_by,
          revision_id: task.superseded_in_revision,
        });
      }
      if (task.status === "blocked") {
        throw new RockSpecError("TASK_BLOCKED", `Task ${input.taskId} is blocked`, { task_id: input.taskId });
      }
      if (task.status === "in_progress" && change.execution.active_task === input.taskId) {
        return { task_id: input.taskId, execution_id: task.execution_id };
      }
      const incompleteDependencies = task.dependencies.filter(
        (dependency) => change.tasks[dependency]?.status !== "completed",
      );
      if (incompleteDependencies.length > 0) {
        throw new RockSpecError("TASK_DEPENDENCIES_INCOMPLETE", `Task ${input.taskId} is not ready`, {
          task_id: input.taskId,
          dependencies: incompleteDependencies,
        });
      }
      await this.assertNoUncommittedProductChanges(context.root);
      const suspendedAttempt = task.status === "suspended" ? task.attempts.at(-1) : undefined;
      const baseCommit = suspendedAttempt?.base_commit ?? await git(context.root, ["rev-parse", "HEAD"]);
      if (suspendedAttempt) {
        const headCommit = await git(context.root, ["rev-parse", "HEAD"]);
        const mergeBase = await git(context.root, ["merge-base", baseCommit, headCommit]);
        if (mergeBase !== baseCommit) {
          throw new RockSpecError("TASK_HISTORY_DIVERGED", `Suspended Task ${input.taskId} no longer descends from its original base`, {
            task_id: input.taskId,
            base_commit: baseCommit,
            head_commit: headCommit,
          });
        }
      }
      const executionId = randomUUID();
      const runtimeRoot = `runtime/tasks/${input.taskId}`;
      const briefPath = `${runtimeRoot}/brief.md`;
      const reportPath = `${runtimeRoot}/implementer-report.md`;
      const brief = await this.composeTaskBrief(changeDir, change, input.taskId);
      const briefHash = sha256(brief.content);
      await atomicWrite(path.join(changeDir, briefPath), brief.content);
      await atomicWrite(
        path.join(changeDir, reportPath),
        implementerReportTemplate(input.taskId, executionId, baseCommit, briefPath, briefHash),
      );
      task.status = "in_progress";
      task.started_at = this.timestamp();
      task.base_commit = baseCommit;
      task.execution_id = executionId;
      task.brief_path = briefPath;
      task.brief_hash = briefHash;
      task.report_path = reportPath;
      delete task.report_hash;
      delete task.review_subject;
      delete task.review_package_mode;
      task.review_attempts = 0;
      change.execution.registry.push({
        id: executionId,
        role: "task_implementer",
        action: "task.execute",
        started_at: task.started_at,
        ...(input.modelTier ? { model_tier: input.modelTier } : {}),
        ...(input.hostModel ? { host_model: input.hostModel } : {}),
        context_package_path: briefPath,
        context_package_hash: briefHash,
      });
      change.execution.active_task = input.taskId;
      change.execution.active_execution = executionId;
      change.state = "IMPLEMENTING";
      return { task_id: input.taskId, execution_id: executionId, base_commit: baseCommit, brief_path: briefPath };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async getTaskBrief(input: TaskInput): Promise<TaskBriefResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    const task = located.change.tasks[input.taskId];
    if (!task) throw new RockSpecError("TASK_NOT_FOUND", `Task ${input.taskId} does not exist`);
    const taskPath = path.join(located.changeDir, "tasks", `${input.taskId}.md`);
    if (!(await exists(taskPath))) {
      throw new RockSpecError("MISSING_ARTIFACT", `Task brief ${input.taskId}.md does not exist`);
    }
    await this.assertApprovalClosure(located.changeDir, located.change, ["spec", "design", "implementation"]);
    const composed = await this.composeTaskBrief(located.changeDir, located.change, input.taskId);
    const frozenPath = task.brief_path;
    const content = frozenPath && await exists(path.join(located.changeDir, frozenPath))
      ? await readFile(path.join(located.changeDir, frozenPath), "utf8")
      : composed.content;
    return {
      change_id: located.change.id,
      task_id: input.taskId,
      content,
      references: composed.references,
      ...(frozenPath ? { path: frozenPath } : {}),
      hash: sha256(content),
      ...(task.base_commit ? { base_commit: task.base_commit } : {}),
    };
  }

  async prepareKnowledgePackage(input: ChangeInput = {}): Promise<KnowledgePackageResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId, true);
    const sourceDigest = await this.knowledgeSourceDigest(located.changeDir, located.change);
    if (located.change.knowledge_evolution.status !== "pending") {
      if (located.change.knowledge_evolution.source_digest !== sourceDigest) {
        throw new RockSpecError("KNOWLEDGE_EVOLUTION_STALE", "Knowledge evolution no longer matches the frozen Change inputs", {
          recorded_digest: located.change.knowledge_evolution.source_digest,
          current_digest: sourceDigest,
        });
      }
      await this.assertKnowledgeReceipt(located.changeDir, located.change.knowledge_evolution);
      if (located.change.state === "ARCHIVED") {
        await this.assertCanonicalKnowledgeReceipt(context, located.change);
        return knowledgePackageFromReceipt(located.change.knowledge_evolution, sourceDigest);
      }
    }
    if (located.change.state !== "READY_TO_FINISH") {
      throw new RockSpecError("ILLEGAL_ACTION", `Knowledge evolution cannot run while the Change is ${located.change.state}`, {
        state: located.change.state,
      });
    }
    const proposal = await this.loadKnowledgeProposal(context, located.changeDir, located.change);
    if (
      located.change.knowledge_evolution.status !== "pending" &&
      located.change.knowledge_evolution.delta_hash === proposal.deltaHash &&
      sameJson(
        located.change.knowledge_evolution.updates.map((update) => ({
          target: update.target,
          before_digest: update.before_digest,
          after_digest: update.after_digest,
        })),
        proposal.updates.map((update) => ({
          target: update.target,
          before_digest: update.before_digest,
          after_digest: update.after_digest,
        })),
      )
    ) {
      return knowledgePackageFromReceipt(located.change.knowledge_evolution, sourceDigest);
    }
    return {
      change_id: located.change.id,
      already_evolved: false,
      status: "pending",
      source_digest: sourceDigest,
      delta_path: "knowledge-delta.md",
      delta_hash: proposal.deltaHash,
      baseline_hashes: proposal.baselineHashes,
      candidate_hashes: proposal.candidateHashes,
      ...(proposal.delta.outcome === "proposed" ? { review_path: "reviews/knowledge-review.md" } : {}),
      requires_human_approval: proposal.delta.updates.some((update) => update.authority === "normative"),
    };
  }

  async prepareReviewPackage(input: ReviewPackageInput): Promise<ReviewPackageResult> {
    let prepared: ReviewPackageResult | undefined;
    await this.mutate(input.changeId, "review.package.prepared", async (change, changeDir, context) => {
      if (input.kind !== "task" && (input.mode || input.scopeBlocked)) {
        throw new RockSpecError("REVIEW_PACKAGE_MODE_INVALID", "scope_blocked mode is only valid for Task Review packages");
      }
      if (input.kind === "task") {
        if (!input.taskId) throw new RockSpecError("TASK_ID_REQUIRED", "Task review packages require a Task ID");
        const task = change.tasks[input.taskId];
        if (!task) throw new RockSpecError("TASK_NOT_FOUND", `Task ${input.taskId} does not exist`);
        if (change.execution.active_task !== input.taskId || task.status !== "in_progress") {
          throw new RockSpecError("TASK_NOT_ACTIVE", `Task ${input.taskId} is not the active Task`);
        }
        if (!task.base_commit) {
          throw new RockSpecError("TASK_BASE_MISSING", `Task ${input.taskId} has no recorded base commit`);
        }
        const scopeBlocked = input.mode === "scope_blocked" || input.scopeBlocked === true;
        if (input.mode === "product" && input.scopeBlocked === true) {
          throw new RockSpecError("REVIEW_PACKAGE_MODE_CONFLICT", "Review package mode cannot be both product and scope_blocked");
        }
        await this.assertTaskBriefFresh(changeDir, task);
        if (scopeBlocked) await this.assertTaskScopeBlockedState(context.root, task);
        else await this.assertTaskProductState(context.root, task);
        if (!task.report_path) {
          throw new RockSpecError("IMPLEMENTER_REPORT_MISSING", `Task ${input.taskId} has no Implementer report path`);
        }
        await this.assertMaterialized(changeDir, [task.report_path]);
        task.report_hash = sha256(await readFile(path.join(changeDir, task.report_path)));
        prepared = await this.writeReviewPackage(
          context.root,
          changeDir,
          change,
          "task",
          task.base_commit,
          await git(context.root, ["rev-parse", "HEAD"]),
          input.taskId,
          scopeBlocked ? "scope_blocked" : "product",
          task.allowed_paths,
        );
        task.review_subject = prepared.subject;
        task.review_package_mode = scopeBlocked ? "scope_blocked" : "product";
        prepared.mode = scopeBlocked ? "scope_blocked" : "product";
      } else {
        if (change.state !== "FINAL_REVIEW") {
          throw new RockSpecError("ILLEGAL_ACTION", "Delivery Review package requires FINAL_REVIEW state", {
            state: change.state,
          });
        }
        if (!change.base_commit) throw new RockSpecError("BASE_COMMIT_MISSING", "Change has no base commit");
        await this.assertNoUncommittedProductChanges(context.root);
        prepared = await this.writeReviewPackage(
          context.root,
          changeDir,
          change,
          "delivery",
          change.base_commit,
          await git(context.root, ["rev-parse", "HEAD"]),
        );
      }
      return { kind: input.kind, path: prepared.path, subject: prepared.subject };
    });
    if (!prepared) throw new RockSpecError("INTERNAL_ERROR", "Review package was not created");
    return prepared;
  }

  async completeTask(input: CompleteTaskInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "task.completed", async (change, changeDir, context) => {
      if (change.state !== "IMPLEMENTING") {
        throw new RockSpecError("ILLEGAL_ACTION", "A Task can only complete during implementation", {
          state: change.state,
        });
      }
      await this.assertApprovalClosure(changeDir, change, ["spec", "design", "implementation"]);
      const task = change.tasks[input.taskId];
      if (!task) throw new RockSpecError("TASK_NOT_FOUND", `Task ${input.taskId} does not exist`);
      if (task.status !== "in_progress" || change.execution.active_task !== input.taskId) {
        throw new RockSpecError("TASK_NOT_ACTIVE", `Task ${input.taskId} is not the active Task`, {
          active_task: change.execution.active_task,
        });
      }
      await this.assertTaskBriefFresh(changeDir, task);
      const requestedSha = input.commitSha ?? (await git(context.root, ["rev-parse", "HEAD"]));
      const commitSha = await git(context.root, ["rev-parse", `${requestedSha}^{commit}`]);
      const headCommit = await git(context.root, ["rev-parse", "HEAD"]);
      if (commitSha !== headCommit) {
        throw new RockSpecError("TASK_HEAD_MISMATCH", `Task ${input.taskId} must complete at the current HEAD`, {
          requested_commit: commitSha,
          current_head: headCommit,
        });
      }
      await this.assertTaskProductState(context.root, task);
      const duplicate = Object.values(change.tasks).find(
        (candidate) => candidate.id !== input.taskId && candidate.commit_sha === commitSha,
      );
      if (duplicate) {
        throw new RockSpecError("DUPLICATE_TASK_COMMIT", `Commit ${commitSha} already belongs to ${duplicate.id}`, {
          task_id: input.taskId,
          other_task_id: duplicate.id,
          commit_sha: commitSha,
        });
      }
      const review = change.reviews[`task:${input.taskId}`];
      if (!review || review.verdict !== "PASS" || !review.subject) {
        throw new RockSpecError("REVIEW_NOT_PASSED", `Task ${input.taskId} requires a submitted PASS Review`, {
          task_id: input.taskId,
          verdict: review?.verdict ?? "missing",
        });
      }
      if (!task.base_commit) throw new RockSpecError("TASK_BASE_MISSING", `Task ${input.taskId} has no base commit`);
      const currentPackage = await this.writeReviewPackage(
        context.root,
        changeDir,
        change,
        "task",
        task.base_commit,
        commitSha,
        input.taskId,
        "product",
        task.allowed_paths,
      );
      if (!sameReviewSubject(review.subject, currentPackage.subject)) {
        throw new RockSpecError("STALE_REVIEW", `Task ${input.taskId} Review does not cover the final Diff`, {
          reviewed_subject: review.subject,
          current_subject: currentPackage.subject,
        });
      }
      await this.assertReviewSourcesFresh(changeDir, review);
      if (!task.report_path || !task.report_hash) {
        throw new RockSpecError("IMPLEMENTER_REPORT_MISSING", `Task ${input.taskId} has no reviewed Implementer report`);
      }
      const reportHash = sha256(await readFile(path.join(changeDir, task.report_path)));
      if (reportHash !== task.report_hash) {
        throw new RockSpecError("STALE_IMPLEMENTER_REPORT", `Task ${input.taskId} report changed after Review`, {
          reviewed_hash: task.report_hash,
          current_hash: reportHash,
        });
      }
      await this.assertFreshEvidence(context.root, change, { taskId: input.taskId, commit: commitSha }, true);
      task.status = "completed";
      task.commit_sha = commitSha;
      task.completed_at = this.timestamp();
      change.execution.active_task = null;
      change.execution.active_execution = null;
      if (Object.values(change.tasks).every((candidate) => isTerminalTask(candidate))) {
        change.state = "ACCEPTANCE_VALIDATING";
      }
      return { task_id: input.taskId, commit_sha: commitSha };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async apply(input: ChangeInput = {}): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "change.apply.started", async (change, changeDir) => {
      if (change.profile === "lite" && (change.state === "SCOPING" || change.state === "IMPLEMENTING")) {
        await this.assertMaterialized(changeDir, ["brief.md"]);
        change.state = "IMPLEMENTING";
      } else if (change.state === "READY") {
        await this.assertApprovalClosure(changeDir, change, ["spec", "design", "implementation"]);
        change.state = "IMPLEMENTING";
      } else {
        throw new RockSpecError("ILLEGAL_ACTION", `Apply cannot start while the Change is ${change.state}`, {
          state: change.state,
        });
      }
      return {};
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async verify(input: ChangeInput = {}): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "change.verified", async (change, changeDir, context) => {
      const lite = change.profile === "lite";
      if ((lite && change.state !== "IMPLEMENTING" && change.state !== "VERIFYING") ||
          (!lite && change.state !== "VERIFYING")) {
        throw new RockSpecError("ILLEGAL_ACTION", `Verification cannot run while the Change is ${change.state}`, {
          state: change.state,
        });
      }
      const commit = await git(context.root, ["rev-parse", "HEAD"]);
      if (!lite) {
        await this.assertApprovalClosure(changeDir, change, ["spec", "design", "implementation"]);
      }
      if (!lite) {
        await this.assertFreshEvidence(
          context.root,
          change,
          { actionId: "change.verify", commit },
          true,
        );
        this.assertReviewPassed(change, "delivery");
        if (!change.base_commit || !change.reviews.delivery?.subject) {
          throw new RockSpecError("DELIVERY_REVIEW_SUBJECT_MISSING", "Delivery Review has no fixed subject");
        }
        const currentPackage = await this.writeReviewPackage(
          context.root,
          changeDir,
          change,
          "delivery",
          change.base_commit,
          commit,
        );
        if (!sameReviewSubject(change.reviews.delivery.subject, currentPackage.subject)) {
          throw new RockSpecError("STALE_REVIEW", "Delivery Review does not cover the current commit", {
            reviewed_subject: change.reviews.delivery.subject,
            current_subject: currentPackage.subject,
          });
        }
        await this.assertReviewSourcesFresh(changeDir, change.reviews.delivery);
      } else {
        await this.assertFreshEvidence(context.root, change, { commit }, true);
      }
      change.verification = { status: "passed", commit, verified_at: this.timestamp() };
      change.delivery_head = commit;
      change.state = "READY_TO_FINISH";
      return { commit };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async finish(input: FinishInput = {}): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, "change.finished", async (change, _changeDir, context) => {
      if (change.state !== "READY_TO_FINISH" || change.verification.status !== "passed") {
        throw new RockSpecError("FINISH_GATE_FAILED", "The Change is not ready to finish", {
          state: change.state,
          verification: change.verification.status,
        });
      }
      if (change.knowledge_evolution.status === "pending") {
        throw new RockSpecError("KNOWLEDGE_EVOLUTION_REQUIRED", "Complete knowledge evolution before choosing Finish disposition", {
          change_id: change.id,
        });
      }
      const currentCommit = await git(context.root, ["rev-parse", "HEAD"]);
      const deliveryHead = change.delivery_head ?? change.verification.commit;
      if (!deliveryHead || change.verification.commit !== deliveryHead) {
        throw new RockSpecError("STALE_EVIDENCE", "The final verification does not match the current commit", {
          verified_commit: change.verification.commit,
          delivery_head: deliveryHead,
          current_commit: currentCommit,
        });
      }
      await this.assertDeliveryHeadAncestor(context.root, deliveryHead, currentCommit);
      change.finished_at = this.timestamp();
      return { disposition: input.disposition ?? "keep", commit: deliveryHead, current_commit: currentCommit };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async archive(input: ChangeInput = {}): Promise<ArchiveResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId);
    let archivePath = "";
    let archived: ChangeSnapshot | undefined;
    await withFileLock(
      context.rocksRoot,
      async () => {
        const current = await readChange(located.changeDir);
        await this.assertWorkspaceBinding(context, current);
        if (current.state !== "READY_TO_FINISH" || !current.finished_at) {
          throw new RockSpecError("ARCHIVE_GATE_FAILED", "Finish the Change before archiving", {
            state: current.state,
          });
        }
        if (current.knowledge_evolution.status === "pending") {
          throw new RockSpecError("KNOWLEDGE_EVOLUTION_REQUIRED", "Complete knowledge evolution before archiving", {
            change_id: current.id,
          });
        }
        const currentCommit = await git(context.root, ["rev-parse", "HEAD"]);
        const deliveryHead = current.delivery_head ?? current.verification.commit;
        if (!deliveryHead || current.verification.commit !== deliveryHead) {
          throw new RockSpecError("STALE_EVIDENCE", "Archived delivery must remain bound to the verified Commit", {
            verified_commit: current.verification.commit,
            delivery_head: deliveryHead,
            current_commit: currentCommit,
          });
        }
        await this.assertDeliveryHeadAncestor(context.root, deliveryHead, currentCommit);
        const date = this.clock();
        archivePath = path.join(
          context.rocksRoot,
          "archive",
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, "0"),
          current.id,
        );
        if (await exists(archivePath)) {
          throw new RockSpecError("ARCHIVE_CONFLICT", "The archive destination already exists", {
            archive_path: archivePath,
          });
        }
        const staging = `${archivePath}.${randomUUID()}.staging`;
        await mkdir(path.dirname(archivePath), { recursive: true });
        const before = structuredClone(current);
        let knowledgeSwap: { root: string; backup: string | null } | null = null;
        try {
          await rename(located.changeDir, staging);
          knowledgeSwap = await this.installKnowledgeBaseline(context, staging, current);
          const specSource = path.join(staging, "specs");
          if (await exists(specSource)) {
            await cp(specSource, context.rocksRoot + "/specs", { recursive: true, force: true });
          }
          current.state = "ARCHIVED";
          current.archived_at = this.timestamp();
          current.updated_at = current.archived_at;
          await commitChangeMutation(staging, before, current, {
            schema_version: 1,
            sequence: (await eventCount(staging)) + 1,
            event: "change.archived",
            change_id: current.id,
            occurred_at: current.archived_at,
            previous_state: before.state,
            current_state: "ARCHIVED",
            data: { archive_path: path.relative(context.root, archivePath) },
          });
          await rename(staging, archivePath);
          archived = current;
          if (knowledgeSwap.backup) {
            try {
              await rm(knowledgeSwap.backup, { recursive: true, force: true });
            } catch {
              // The archive and baseline are committed; a leftover backup is safer than rolling them back.
            }
          }
        } catch (error) {
          if (knowledgeSwap) await this.rollbackKnowledgeBaseline(knowledgeSwap);
          if (await exists(staging)) {
            await writeChange(staging, before);
            if (before.knowledge_evolution.status !== "pending") {
              await atomicWrite(
                path.join(staging, "knowledge-evolution.yaml"),
                stringify(before.knowledge_evolution, { lineWidth: 0 }),
              );
            }
            await rename(staging, located.changeDir);
          }
          throw error;
        }
      },
      this.lockTimeoutMs,
      this.lockStaleMs,
    );
    if (!archived) throw new RockSpecError("INTERNAL_ERROR", "Archive produced no snapshot");
    const status = await this.statusFor(context, archivePath, archived);
    return { ...status, archive_path: archivePath };
  }

  private async completeKnowledgeEvolution(
    changeDir: string,
    change: ChangeSnapshot,
    context: Context,
  ): Promise<void> {
    const sourceDigest = await this.knowledgeSourceDigest(changeDir, change);
    const proposal = await this.loadKnowledgeProposal(context, changeDir, change);
    this.assertRegisteredExecution(change, proposal.delta.author_execution_id, "knowledge_author", "knowledge.evolve.author");
    if (change.knowledge_evolution.status !== "pending") {
      if (change.knowledge_evolution.source_digest !== sourceDigest) {
        throw new RockSpecError("KNOWLEDGE_EVOLUTION_STALE", "Knowledge evolution no longer matches the frozen Change inputs", {
          recorded_digest: change.knowledge_evolution.source_digest,
          current_digest: sourceDigest,
        });
      }
      await this.assertKnowledgeReceipt(changeDir, change.knowledge_evolution);
      const sameProposal = change.knowledge_evolution.delta_hash === proposal.deltaHash && sameJson(
        change.knowledge_evolution.updates.map((update) => ({
          target: update.target,
          before_digest: update.before_digest,
          after_digest: update.after_digest,
        })),
        proposal.updates.map((update) => ({
          target: update.target,
          before_digest: update.before_digest,
          after_digest: update.after_digest,
        })),
      );
      if (sameProposal) return;
    }
    const recordedAt = this.timestamp();
    const baseReceipt = {
      schema_version: 1 as const,
      change_id: change.id,
      protocol_version: 1 as const,
      source_digest: sourceDigest,
      delta_path: "knowledge-delta.md",
      delta_hash: proposal.deltaHash,
      recorded_at: recordedAt,
    };

    if (proposal.delta.outcome === "no_change") {
      const receipt = KnowledgeEvolutionSchema.parse({
        ...baseReceipt,
        status: "no_change",
        updates: [],
      });
      await atomicWrite(path.join(changeDir, "knowledge-evolution.yaml"), stringify(receipt, { lineWidth: 0 }));
      change.knowledge_evolution = receipt;
      return;
    }

    const reviewPath = "reviews/knowledge-review.md";
    const absoluteReviewPath = path.join(changeDir, reviewPath);
    if (!(await exists(absoluteReviewPath))) {
      throw new RockSpecError("MISSING_ARTIFACT", `Required artifact ${reviewPath} does not exist`, { path: reviewPath });
    }
    const reviewContent = await readFile(absoluteReviewPath, "utf8");
    const parsedReview = KnowledgeReviewDocumentSchema.safeParse(parseFrontmatter(reviewContent, reviewPath));
    if (!parsedReview.success) {
      throw new RockSpecError("INVALID_KNOWLEDGE_REVIEW", "Knowledge Review metadata is invalid", {
        path: reviewPath,
        issues: parsedReview.error.issues,
      });
    }
    const review = parsedReview.data;
    this.assertRegisteredExecution(change, review.reviewer_execution_id, "knowledge_reviewer", "knowledge.evolve.review");
    const expectedSubject = {
      source_digest: sourceDigest,
      delta_hash: proposal.deltaHash,
      baseline_hashes: proposal.baselineHashes,
      candidate_hashes: proposal.candidateHashes,
    };
    if (!sameJson(review.subject, expectedSubject)) {
      throw new RockSpecError("STALE_KNOWLEDGE_REVIEW", "Knowledge Review does not cover the current Delta and candidates", {
        reviewed_subject: review.subject,
        current_subject: expectedSubject,
      });
    }
    if (review.reviewer_execution_id === proposal.delta.author_execution_id) {
      throw new RockSpecError("REVIEWER_NOT_INDEPENDENT", "Knowledge Reviewer must be independent from the Delta author");
    }
    if (review.verdict !== "PASS") {
      throw new RockSpecError("KNOWLEDGE_REVIEW_FAILED", "Resolve the Knowledge Review Findings before completion", {
        verdict: review.verdict,
        finding_ids: review.findings.filter((finding) => finding.status === "open").map((finding) => finding.id),
      });
    }

    const receipt = KnowledgeEvolutionSchema.parse({
      ...baseReceipt,
      status: "approved",
      updates: proposal.updates,
      review: {
        reviewer_execution_id: review.reviewer_execution_id,
        report_path: reviewPath,
        report_hash: sha256(reviewContent),
      },
      ...(proposal.delta.approval ? { approval: proposal.delta.approval } : {}),
    });
    await atomicWrite(path.join(changeDir, "knowledge-evolution.yaml"), stringify(receipt, { lineWidth: 0 }));
    change.knowledge_evolution = receipt;
  }

  private async loadKnowledgeProposal(
    context: Context,
    changeDir: string,
    change: ChangeSnapshot,
  ) {
    const deltaPath = "knowledge-delta.md";
    const absoluteDeltaPath = path.join(changeDir, deltaPath);
    if (!(await exists(absoluteDeltaPath))) {
      throw new RockSpecError("MISSING_ARTIFACT", `Required artifact ${deltaPath} does not exist`, { path: deltaPath });
    }
    const deltaContent = await readFile(absoluteDeltaPath, "utf8");
    const parsedDelta = KnowledgeDeltaDocumentSchema.safeParse(parseFrontmatter(deltaContent, deltaPath));
    if (!parsedDelta.success) {
      throw new RockSpecError("INVALID_KNOWLEDGE_DELTA", "Knowledge Delta metadata is invalid", {
        path: deltaPath,
        issues: parsedDelta.error.issues,
      });
    }
    const delta = parsedDelta.data;
    if (delta.change_id !== change.id) {
      throw new RockSpecError("KNOWLEDGE_CHANGE_MISMATCH", "Knowledge Delta belongs to a different Change", {
        expected_change_id: change.id,
        actual_change_id: delta.change_id,
      });
    }

    const candidateRoot = path.join(changeDir, "knowledge", "updates");
    const candidateFiles = (await exists(candidateRoot))
      ? (await walkFiles(candidateRoot)).map((file) => path.relative(candidateRoot, file)).sort()
      : [];
    const declaredTargets = delta.updates.map((update) => update.target).sort();
    if (!sameJson(candidateFiles, declaredTargets)) {
      throw new RockSpecError("KNOWLEDGE_CANDIDATE_MISMATCH", "Knowledge candidate files must exactly match Delta targets", {
        declared_targets: declaredTargets,
        candidate_files: candidateFiles,
      });
    }

    const candidateHashes: Record<string, string> = {};
    const baselineHashes: Record<string, string | null> = {};
    const updates = [];
    for (const update of delta.updates) {
      const candidatePath = path.join(candidateRoot, update.target);
      const candidateContent = await readFile(candidatePath);
      if (candidateContent.toString("utf8").trim().length === 0) {
        throw new RockSpecError("EMPTY_KNOWLEDGE_CANDIDATE", `Knowledge candidate ${update.target} is empty`, {
          target: update.target,
        });
      }
      const baselinePath = path.join(context.rocksRoot, "knowledge", update.target);
      const baselineExists = await exists(baselinePath);
      if (update.operation === "new" && baselineExists) {
        throw new RockSpecError("KNOWLEDGE_TARGET_EXISTS", `New knowledge target ${update.target} already exists`, {
          target: update.target,
        });
      }
      if (update.operation !== "new" && !baselineExists) {
        throw new RockSpecError("KNOWLEDGE_TARGET_MISSING", `${update.operation} requires existing target ${update.target}`, {
          target: update.target,
        });
      }
      const beforeDigest = baselineExists ? sha256(await readFile(baselinePath)) : null;
      const afterDigest = sha256(candidateContent);
      baselineHashes[update.target] = beforeDigest;
      candidateHashes[update.target] = afterDigest;
      updates.push({ ...update, before_digest: beforeDigest, after_digest: afterDigest });
    }
    return {
      delta,
      deltaHash: sha256(deltaContent),
      baselineHashes: Object.fromEntries(Object.entries(baselineHashes).sort(([left], [right]) => left.localeCompare(right))),
      candidateHashes: Object.fromEntries(Object.entries(candidateHashes).sort(([left], [right]) => left.localeCompare(right))),
      updates,
    };
  }

  private async knowledgeSourceDigest(changeDir: string, change: ChangeSnapshot): Promise<string> {
    const candidates = [
      "brief.md",
      "proposal.md",
      "specs",
      "design.md",
      "prototype",
      "plan.md",
      "tasks.md",
      "tasks",
      "testing",
      "evidence",
      "reviews/requirements-review.md",
      "reviews/readiness-review.md",
      "reviews/tasks",
      "reviews/delivery-review.md",
    ];
    const present: string[] = [];
    for (const candidate of candidates) {
      if (await exists(path.join(changeDir, candidate))) present.push(candidate);
    }
    const hashed = await hashPaths(changeDir, present);
    return sha256(`knowledge-protocol:1\ncommit:${change.verification.commit ?? "none"}\n${hashed.aggregate_hash}\n`);
  }

  private async assertKnowledgeReceipt(
    changeDir: string,
    expected: ChangeSnapshot["knowledge_evolution"],
  ): Promise<void> {
    const receiptPath = path.join(changeDir, "knowledge-evolution.yaml");
    if (!(await exists(receiptPath))) {
      throw new RockSpecError("KNOWLEDGE_RECEIPT_MISSING", "Knowledge evolution state has no Change receipt");
    }
    const parsed = KnowledgeEvolutionSchema.safeParse(parse(await readFile(receiptPath, "utf8")));
    if (!parsed.success || !sameJson(parsed.data, expected)) {
      throw new RockSpecError("KNOWLEDGE_RECEIPT_DIVERGED", "Change knowledge receipt does not match Engine state", {
        path: path.relative(this.cwd, receiptPath),
      });
    }
  }

  private async assertCanonicalKnowledgeReceipt(context: Context, change: ChangeSnapshot): Promise<void> {
    const markerPath = path.join(context.rocksRoot, "knowledge", ".evolution", `${change.id}.yaml`);
    if (!(await exists(markerPath))) {
      throw new RockSpecError("KNOWLEDGE_RECEIPT_MISSING", "Archived Change has no canonical knowledge receipt", {
        path: path.relative(context.root, markerPath),
      });
    }
    const parsed = KnowledgeEvolutionSchema.safeParse(parse(await readFile(markerPath, "utf8")));
    if (!parsed.success || !sameJson(parsed.data, change.knowledge_evolution)) {
      throw new RockSpecError("KNOWLEDGE_BASELINE_DIVERGED", "Canonical knowledge receipt does not match the archived Change", {
        path: path.relative(context.root, markerPath),
      });
    }
  }

  private async installKnowledgeBaseline(
    context: Context,
    changeDir: string,
    change: ChangeSnapshot,
  ): Promise<{ root: string; backup: string | null }> {
    const evolution = change.knowledge_evolution;
    await this.assertKnowledgeReceipt(changeDir, evolution);
    const sourceDigest = await this.knowledgeSourceDigest(changeDir, change);
    if (evolution.source_digest !== sourceDigest) {
      throw new RockSpecError("KNOWLEDGE_EVOLUTION_STALE", "Knowledge evolution changed before archive", {
        recorded_digest: evolution.source_digest,
        current_digest: sourceDigest,
      });
    }

    const knowledgeRoot = path.join(context.rocksRoot, "knowledge");
    const stagedRoot = `${knowledgeRoot}.${randomUUID()}.staging`;
    const backupRoot = `${knowledgeRoot}.${randomUUID()}.backup`;
    const hadKnowledgeRoot = await exists(knowledgeRoot);
    if (hadKnowledgeRoot) await cp(knowledgeRoot, stagedRoot, { recursive: true });
    else await mkdir(stagedRoot, { recursive: true });

    let installed = false;
    try {
      for (const update of evolution.updates) {
        const stagedTarget = path.join(stagedRoot, update.target);
        const stagedTargetExists = await exists(stagedTarget);
        const actualBefore = stagedTargetExists ? sha256(await readFile(stagedTarget)) : null;
        if (actualBefore !== update.before_digest) {
          throw new RockSpecError("KNOWLEDGE_BASELINE_DIVERGED", `Knowledge target ${update.target} changed after Review`, {
            target: update.target,
            reviewed_digest: update.before_digest,
            current_digest: actualBefore,
          });
        }
        const candidate = path.join(changeDir, "knowledge", "updates", update.target);
        if (!(await exists(candidate)) || sha256(await readFile(candidate)) !== update.after_digest) {
          throw new RockSpecError("KNOWLEDGE_CANDIDATE_DIVERGED", `Knowledge candidate ${update.target} changed after Review`, {
            target: update.target,
          });
        }
        await mkdir(path.dirname(stagedTarget), { recursive: true });
        await cp(candidate, stagedTarget, { force: true });
      }

      const finalized = evolution.status === "approved"
        ? KnowledgeEvolutionSchema.parse({ ...evolution, status: "applied", applied_at: this.timestamp() })
        : evolution;
      const markerPath = path.join(stagedRoot, ".evolution", `${change.id}.yaml`);
      await atomicWrite(markerPath, stringify(finalized, { lineWidth: 0 }));
      await atomicWrite(path.join(changeDir, "knowledge-evolution.yaml"), stringify(finalized, { lineWidth: 0 }));
      change.knowledge_evolution = finalized;

      if (hadKnowledgeRoot) await rename(knowledgeRoot, backupRoot);
      await rename(stagedRoot, knowledgeRoot);
      installed = true;
      return { root: knowledgeRoot, backup: hadKnowledgeRoot ? backupRoot : null };
    } catch (error) {
      if (!installed && hadKnowledgeRoot && await exists(backupRoot) && !(await exists(knowledgeRoot))) {
        await rename(backupRoot, knowledgeRoot);
      }
      await rm(stagedRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async rollbackKnowledgeBaseline(swap: { root: string; backup: string | null }): Promise<void> {
    await rm(swap.root, { recursive: true, force: true });
    if (swap.backup && await exists(swap.backup)) await rename(swap.backup, swap.root);
  }

  private async context(): Promise<Context> {
    const repository = await resolveRepository(this.cwd);
    return { ...repository, config: await readConfig(repository.rocksRoot) };
  }

  private async runEnvironmentPreflight(
    context: Context,
    changeId: string,
  ): Promise<Pick<EnvironmentPreflightResult, "valid" | "checks">> {
    const checks: EnvironmentPreflightResult["checks"] = [];
    for (const probe of context.config.environment_preflight) {
      const started = Date.now();
      try {
        await execFileAsync(probe.command, probe.args, {
          cwd: context.root,
          timeout: 15_000,
          maxBuffer: 256 * 1024,
        });
        checks.push({
          id: probe.id,
          kind: probe.kind,
          required: probe.required,
          status: "passed",
          duration_ms: Date.now() - started,
          detail: `${probe.kind} probe passed`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
        checks.push({
          id: probe.id,
          kind: probe.kind,
          required: probe.required,
          status: probe.required ? "failed" : "skipped",
          duration_ms: Date.now() - started,
          detail: `${probe.kind} probe failed: ${message}`,
        });
      }
    }
    const valid = checks.every((check) => !check.required || check.status === "passed");
    return { valid, checks };
  }

  private async locateChange(
    context: Context,
    requestedId?: string,
    includeArchive = false,
  ): Promise<LocatedChange> {
    let id = requestedId;
    if (!id) {
      const active = await activeChangeIds(context.rocksRoot);
      if (active.length === 0) {
        throw new RockSpecError("CHANGE_NOT_FOUND", "No active Change exists in this repository");
      }
      if (active.length > 1) {
        throw new RockSpecError("AMBIGUOUS_CHANGE", "More than one active Change exists; specify change-id", {
          active_changes: active,
        });
      }
      [id] = active;
    }
    if (!id) throw new RockSpecError("CHANGE_NOT_FOUND", "No Change ID was provided");
    const activePath = path.join(context.rocksRoot, "changes", id);
    if (await exists(activePath)) return { changeDir: activePath, change: await readChange(activePath) };
    if (includeArchive) {
      const archivedPath = await findArchivedChange(context.rocksRoot, id);
      if (archivedPath) return { changeDir: archivedPath, change: await readChange(archivedPath) };
    }
    throw new RockSpecError("CHANGE_NOT_FOUND", `Change ${id} does not exist`, { change_id: id });
  }

  private async mutate(
    requestedId: string | undefined,
    eventName: string,
    operation: (
      change: ChangeSnapshot,
      changeDir: string,
      context: Context,
    ) => Promise<Record<string, unknown>>,
  ): Promise<MutationResult> {
    const context = await this.context();
    const initiallyLocated = await this.locateChange(context, requestedId);
    let change = initiallyLocated.change;
    await withFileLock(
      context.rocksRoot,
      async () => {
        change = await readChange(initiallyLocated.changeDir);
        await this.assertWorkspaceBinding(context, change);
        if (change.state === "ARCHIVED") {
          throw new RockSpecError("CHANGE_ARCHIVED", "Archived Changes are read-only", {
            change_id: change.id,
          });
        }
        const before = structuredClone(change);
        const previousState = change.state;
        const data = await operation(change, initiallyLocated.changeDir, context);
        change.updated_at = this.timestamp();
        const event: EventRecord = {
          schema_version: 1,
          sequence: (await eventCount(initiallyLocated.changeDir)) + 1,
          event: eventName,
          change_id: change.id,
          occurred_at: change.updated_at,
          previous_state: previousState,
          current_state: change.state,
          data,
        };
        await commitChangeMutation(initiallyLocated.changeDir, before, change, event);
      },
      this.lockTimeoutMs,
      this.lockStaleMs,
    );
    return { context, changeDir: initiallyLocated.changeDir, change };
  }

  private async statusFor(
    context: Context,
    changeDir: string,
    change: ChangeSnapshot,
  ): Promise<StatusResult> {
    const blocked = await this.collectBlockers(context, changeDir, change);
    const recovery = recoveryDirective(change);
    if (recovery) {
      blocked.push({
        code: "FINDING_RECOVERY_REQUIRED",
        message: `${recovery.review_id} has Open Findings routed outside the current stage`,
        paths: [recovery.review_id, ...recovery.finding_ids],
      });
    }
    const normalizedBlocked = deduplicateBlocks(blocked);
    const advice = workflowAdvice(change, normalizedBlocked, recovery);
    return {
      schema_version: 1,
      current_state: change.state,
      change,
      recommended_next: advice.recommended,
      alternatives: advice.alternatives,
      blocked_by: normalizedBlocked,
      allowed_actions: advice.allowed,
      recovery,
    };
  }

  private async collectBlockers(
    context: Context,
    changeDir: string,
    change: ChangeSnapshot,
  ): Promise<BlockReason[]> {
    const blocked: BlockReason[] = [];
    const workspaceBlock = await this.workspaceBlock(context, change);
    if (workspaceBlock) blocked.push(workspaceBlock);
    for (const gate of ["spec", "design", "implementation"] as const) {
      const approval = change.approvals[gate];
      if (!approval) continue;
      try {
        const current = await hashPaths(changeDir, approvalPaths(gate, change.prototype.required));
        if (current.aggregate_hash !== approval.aggregate_hash) {
          blocked.push({
            code: "STALE_APPROVAL",
            message: `${gate} content changed after approval`,
            paths: [gate, ...changedArtifactPaths(approval.artifact_hashes, current.artifact_hashes)],
          });
        }
      } catch (error) {
        blocked.push({
          code: "STALE_APPROVAL",
          message: `${gate} approval content is missing or unreadable`,
          paths: [gate],
        });
      }
    }
    for (const [reviewId, paths] of [
      ["requirements", ["proposal.md", "specs"]],
      ["readiness", ["design.md", "plan.md", "tasks.md", "tasks"]],
    ] as const) {
      const review = change.reviews[reviewId];
      if (!review) continue;
      try {
        const current = await hashPaths(changeDir, paths);
        if (current.aggregate_hash !== review.content_hash) {
          blocked.push({
            code: "STALE_REVIEW",
            message: `${reviewId} review does not cover the current content`,
            paths: [reviewId],
          });
        }
      } catch {
        blocked.push({
          code: "STALE_REVIEW",
          message: `${reviewId} review content is missing or unreadable`,
          paths: [reviewId],
        });
      }
    }
    if (change.reviews.delivery && (change.state === "VERIFYING" || change.state === "READY_TO_FINISH")) {
      const currentCommit = await git(context.root, ["rev-parse", "HEAD"]);
      const expectedCommit = change.delivery_head ?? currentCommit;
      if (change.reviews.delivery.subject?.head_commit !== expectedCommit) {
        blocked.push({
          code: "STALE_REVIEW",
          message: "Delivery Review does not cover the frozen delivery snapshot",
          paths: ["delivery"],
        });
      }
    }
    if (change.state === "DESIGNING" && change.prototype.required && change.prototype.status === "pending") {
      const binding = context.config.capabilities[change.prototype.capability];
      if (!binding) {
        blocked.push({
          code: "CAPABILITY_NOT_CONFIGURED",
          message: `${change.prototype.capability} has no configured provider`,
        });
      } else if (!this.providerAvailable(binding.provider, binding.distribution)) {
        blocked.push({
          code: "PROVIDER_UNAVAILABLE",
          message: `Provider ${binding.provider} is not available for ${change.prototype.capability}`,
        });
      }
    }
    return blocked;
  }

  private async workspaceBlock(
    context: Context,
    change: ChangeSnapshot,
  ): Promise<BlockReason | null> {
    if (change.workspace === null || change.state === "ARCHIVED") return null;
    const actual = await inspectGitWorkspace(context.root);
    if (change.workspace.mode !== actual.mode) {
      return {
        code: "WORKSPACE_MODE_MISMATCH",
        message: `Change ${change.id} is bound to ${change.workspace.mode}, not ${actual.mode}`,
        paths: [context.root],
      };
    }
    if (change.workspace.branch !== null && change.workspace.branch !== actual.branch) {
      return {
        code: "WORKSPACE_BRANCH_MISMATCH",
        message: `Change ${change.id} is bound to branch ${change.workspace.branch}`,
        paths: [context.root],
      };
    }
    return null;
  }

  private async assertWorkspaceBinding(context: Context, change: ChangeSnapshot): Promise<void> {
    const block = await this.workspaceBlock(context, change);
    if (!block) return;
    throw new RockSpecError(block.code, block.message, {
      change_id: change.id,
      expected: change.workspace,
      repository_root: context.root,
    });
  }

  private async validationErrors(
    context: Context,
    changeDir: string,
    change: ChangeSnapshot,
    gate?: string,
    strict = false,
  ): Promise<BlockReason[]> {
    const errors = await this.collectBlockers(context, changeDir, change);
    const add = (code: string, message: string, paths?: string[]): void => {
      errors.push({ code, message, ...(paths ? { paths } : {}) });
    };
    const relevant = gate ?? "change";
    const gateMinimumStates: Record<string, Parameters<typeof stateAtLeast>[1]> = {
      spec: "SPEC_APPROVED",
      design: "DESIGN_APPROVED",
      readiness: "READY",
      task: "ACCEPTANCE_VALIDATING",
      acceptance: "FINAL_REVIEW",
      delivery: "VERIFYING",
      finish: "READY_TO_FINISH",
    };
    if (gate && !(gate in gateMinimumStates)) {
      add("UNKNOWN_GATE", `Unknown gate ${gate}`, [gate]);
    } else if (gate) {
      const minimum = gateMinimumStates[gate];
      if (minimum && !stateAtLeast(change.state, minimum)) {
        add(
          "GATE_STATE",
          `Gate ${gate} requires ${minimum} or a later state; current state is ${change.state}`,
          [gate],
        );
      }
    }
    if ((relevant === "spec" || relevant === "change") && stateAtLeast(change.state, "SPEC_APPROVED")) {
      if (!change.approvals.spec) add("MISSING_APPROVAL", "Spec approval is missing", ["spec"]);
      if (change.reviews.requirements?.verdict !== "PASS") {
        add("REVIEW_NOT_PASSED", "Requirements review has not passed", ["requirements"]);
      }
    }
    if ((relevant === "design" || relevant === "readiness" || relevant === "change") &&
        stateAtLeast(change.state, "DESIGN_APPROVED")) {
      if (!change.approvals.design) add("MISSING_APPROVAL", "Design approval is missing", ["design"]);
      if (change.prototype.required && change.prototype.status !== "reconciled") {
        add("PROTOTYPE_NOT_RECONCILED", "Required UI prototype has not been reconciled into Design", ["prototype"]);
      }
    }
    if ((relevant === "readiness" || relevant === "implementation" || relevant === "change") &&
        stateAtLeast(change.state, "READY")) {
      if (!change.approvals.implementation) {
        add("MISSING_APPROVAL", "Implementation approval is missing", ["implementation"]);
      }
      if (change.reviews.readiness?.verdict !== "PASS") {
        add("REVIEW_NOT_PASSED", "Readiness review has not passed", ["readiness"]);
      }
      if (Object.keys(change.tasks).length === 0) add("NO_TASKS", "No implementation Tasks exist");
      else {
        try {
          assertTaskExecutionViable(change.tasks);
        } catch (error) {
          if (error instanceof RockSpecError) add(error.code, error.message, ["tasks"]);
          else throw error;
        }
      }
    }
    if ((relevant === "acceptance" || relevant === "change") &&
        stateAtLeast(change.state, "FINAL_REVIEW") && change.reviews.acceptance?.verdict !== "PASS") {
      add("ACCEPTANCE_NOT_PASSED", "Acceptance validation has not passed", ["testing/test-report.md"]);
    }
    if (relevant === "task" && stateAtLeast(change.state, "ACCEPTANCE_VALIDATING")) {
      for (const task of Object.values(change.tasks)) {
        if (task.status === "superseded") {
          const replacement = task.superseded_by ? change.tasks[task.superseded_by] : undefined;
          if (!replacement || replacement.status !== "completed" || !replacement.supersedes.includes(task.id)) {
            add("TASK_SUPERSESSION_INCOMPLETE", `Superseded Task ${task.id} has no completed replacement`, [task.id]);
          }
          continue;
        }
        if (task.status !== "completed" || !task.commit_sha) {
          add("TASK_NOT_COMPLETED", `Task ${task.id} has not completed its Gate`, [task.id]);
          continue;
        }
        if (change.reviews[`task:${task.id}`]?.verdict !== "PASS") {
          add("REVIEW_NOT_PASSED", `Task ${task.id} review has not passed`, [task.id]);
        }
        if (!change.evidence.some((item) =>
          item.task_id === task.id && item.commit === task.commit_sha && item.exit_code === 0)) {
          add("STALE_EVIDENCE", `Task ${task.id} has no fresh passing evidence`, [task.id]);
        }
      }
    }
    if ((relevant === "delivery" || relevant === "finish" || relevant === "change") &&
        stateAtLeast(change.state, "VERIFYING") && change.profile !== "lite" &&
        change.reviews.delivery?.verdict !== "PASS") {
      add("DELIVERY_REVIEW_NOT_PASSED", "Delivery Review has not passed", ["reviews/delivery-review.md"]);
    }
    if ((relevant === "finish" || relevant === "change") && change.state === "READY_TO_FINISH" &&
        change.verification.status !== "passed") {
      add("VERIFICATION_NOT_PASSED", "Final verification has not passed");
    }
    if ((relevant === "finish" || relevant === "change") && change.state === "READY_TO_FINISH" &&
        change.knowledge_evolution.status === "pending") {
      add("KNOWLEDGE_EVOLUTION_REQUIRED", "Knowledge evolution must record no_change or an approved Delta");
    }
    if (strict && change.profile === "strict") {
      for (const [key, review] of Object.entries(change.reviews)) {
        if (review.verdict !== "PASS") add("STRICT_REVIEW_NOT_PASSED", `${key} review has not passed`);
      }
    }
    return deduplicateBlocks(errors);
  }

  private async assertNoStalePrerequisites(
    changeDir: string,
    change: ChangeSnapshot,
    action: CompleteActionInput["action"],
  ): Promise<void> {
    const required: ApprovalGate[] = [];
    if (["design.technical", "design.prototype"].includes(action)) required.push("spec");
    if (["plan.create", "readiness.review"].includes(action)) required.push("spec", "design");
    if (["task.execute", "task.review", "acceptance.validate", "acceptance.uat", "delivery.review"].includes(action)) {
      required.push("spec", "design", "implementation");
    }
    await this.assertApprovalClosure(changeDir, change, required);
  }

  private async assertApprovalClosure(
    changeDir: string,
    change: ChangeSnapshot,
    gates: ApprovalGate[],
  ): Promise<void> {
    for (const gate of [...new Set(gates)]) await this.assertApprovalFresh(changeDir, change, gate);
  }

  private async assertApprovalFresh(
    changeDir: string,
    change: ChangeSnapshot,
    gate: ApprovalGate,
  ): Promise<void> {
    const approval = change.approvals[gate];
    if (!approval) {
      throw new RockSpecError("MISSING_APPROVAL", `${gate} approval is required`, { gate });
    }
    let current;
    try {
      current = await hashPaths(changeDir, approvalPaths(gate, change.prototype.required));
    } catch (error) {
      throw new RockSpecError("STALE_APPROVAL", `${gate} approval content is missing`, {
        gate,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (current.aggregate_hash !== approval.aggregate_hash) {
      throw new RockSpecError("STALE_APPROVAL", `${gate} content changed after approval`, {
        gate,
        changed_paths: changedArtifactPaths(approval.artifact_hashes, current.artifact_hashes),
      });
    }
  }

  private assertApprovalState(change: ChangeSnapshot, gate: ApprovalGate): void {
    const expected = gate === "spec" ? "SPEC_REVIEW" : gate === "design" ? "DESIGNING" : "READINESS_REVIEW";
    if (change.state !== expected) {
      throw new RockSpecError("ILLEGAL_APPROVAL", `${gate} approval is not legal while the Change is ${change.state}`, {
        gate,
        state: change.state,
        expected_state: expected,
      });
    }
  }

  private async assertApprovalPrerequisites(
    changeDir: string,
    change: ChangeSnapshot,
    gate: ApprovalGate,
  ): Promise<void> {
    if (gate === "spec") {
      await this.assertMaterialized(changeDir, ["proposal.md", "specs"], true);
      await this.assertProposalReady(changeDir);
      this.assertReviewPassed(change, "requirements");
      await this.assertReviewFresh(changeDir, change, "requirements");
      await this.assertReviewSourcesFresh(changeDir, change.reviews.requirements!);
      return;
    }
    if (gate === "design") {
      await this.assertApprovalFresh(changeDir, change, "spec");
      await this.assertMaterialized(
        changeDir,
        change.prototype.required ? ["design.md", "prototype"] : ["design.md"],
      );
      await this.assertDesignCoverage(changeDir);
      if (change.prototype.required && change.prototype.status !== "reconciled") {
        throw new RockSpecError("PROTOTYPE_NOT_RECONCILED", "Reconcile the completed UI prototype into Design before approval");
      }
      return;
    }
    await this.assertApprovalFresh(changeDir, change, "spec");
    await this.assertApprovalFresh(changeDir, change, "design");
    await this.assertMaterialized(changeDir, ["plan.md", "tasks.md", "tasks"]);
    this.assertReviewPassed(change, "readiness");
    await this.assertReviewFresh(changeDir, change, "readiness");
    await this.assertReviewSourcesFresh(changeDir, change.reviews.readiness!);
    if (Object.keys(change.tasks).length === 0) {
      throw new RockSpecError("NO_TASKS", "At least one Task is required before implementation approval");
    }
    assertTaskExecutionViable(change.tasks);
  }

  private assertAutoReconciliation(change: ChangeSnapshot, gate: ApprovalGate): RevisionRecord {
    const revision = change.revisions.find((item) => item.status === "open");
    if (!revision) throw new RockSpecError("REVISION_NOT_FOUND", "No open Revision is available for reconciliation");
    if (!revision.invalidated_approvals.includes(gate) || !revision.authority_baselines[gate]) {
      throw new RockSpecError("FIRST_APPROVAL_REQUIRES_USER", "Auto reconciliation can only renew a Gate invalidated by this Revision", {
        revision_id: revision.id,
        gate,
        invalidated_approvals: revision.invalidated_approvals,
      });
    }
    const gatePolicy = revisionGatePolicy(revision, gate);
    if (gatePolicy !== "auto") {
      throw new RockSpecError("HUMAN_APPROVAL_REQUIRED", "This Revision requires human approval", {
        revision_id: revision.id,
        gate,
        gate_policy: gatePolicy,
        authority_delta: revision.authority_delta,
        classifications: revision.classifications,
        escalation_reason: revision.escalation_reason ?? null,
      });
    }
    return revision;
  }

  private async writeRevision(changeDir: string, revision: RevisionRecord): Promise<void> {
    await atomicWrite(
      path.join(changeDir, "revisions", `${revision.id}.yaml`),
      stringify(revision, { lineWidth: 0 }),
    );
  }

  private assertReviewPassed(change: ChangeSnapshot, reviewId: string): void {
    const review = change.reviews[reviewId];
    if (!review || review.verdict !== "PASS") {
      throw new RockSpecError("REVIEW_NOT_PASSED", `${reviewId} review must be PASS`, {
        review: reviewId,
        verdict: review?.verdict ?? "missing",
      });
    }
  }

  private async assertReviewFresh(
    changeDir: string,
    change: ChangeSnapshot,
    reviewId: "requirements" | "readiness",
  ): Promise<void> {
    const review = change.reviews[reviewId];
    if (!review) {
      throw new RockSpecError("MISSING_REVIEW", `${reviewId} review is missing`, { review: reviewId });
    }
    const paths = reviewId === "requirements"
      ? ["proposal.md", "specs"]
      : ["design.md", "plan.md", "tasks.md", "tasks"];
    const current = await hashPaths(changeDir, paths);
    if (current.aggregate_hash !== review.content_hash) {
      throw new RockSpecError("STALE_REVIEW", `${reviewId} review does not cover the current content`, {
        review: reviewId,
        reviewed_hash: review.content_hash,
        current_hash: current.aggregate_hash,
      });
    }
  }

  private async assertMaterialized(
    changeDir: string,
    relativePaths: string[],
    validateSpecs = false,
  ): Promise<void> {
    const markdownFiles = new Set<string>();
    for (const relativePath of relativePaths) {
      const absolute = path.join(changeDir, relativePath);
      for (const file of await walkFiles(absolute)) {
        if (file.endsWith(".md")) markdownFiles.add(file);
      }
    }
    for (const file of markdownFiles) {
      const content = await readFile(file, "utf8");
      const relative = path.relative(changeDir, file);
      if (content.trim().length === 0) {
        throw new RockSpecError("EMPTY_ARTIFACT", `${relative} is empty`, { path: relative });
      }
      const placeholder = content.match(/\b(?:TODO|TBD|FIXME)\b|\{\{[^}\n]+\}\}|<placeholder>/i)?.[0];
      if (placeholder) {
        throw new RockSpecError("UNRESOLVED_PLACEHOLDER", `${relative} still contains an unresolved placeholder`, {
          path: relative,
          placeholder,
        });
      }
      if (validateSpecs && relative.startsWith(`specs${path.sep}`)) {
        const result = validateSpec(content);
        if (!result.valid) {
          throw new RockSpecError("INVALID_SPEC", `${relative} is not a valid RockSpec document`, {
            path: relative,
            issues: result.issues,
          });
        }
      }
    }
  }

  private async assertTaskBriefFresh(changeDir: string, task: TaskRecord): Promise<void> {
    if (!task.brief_path || !task.brief_hash) {
      throw new RockSpecError("TASK_BRIEF_MISSING", `Task ${task.id} has no frozen Brief binding`, {
        task_id: task.id,
      });
    }
    const absolute = path.join(changeDir, task.brief_path);
    if (!(await exists(absolute))) {
      throw new RockSpecError("TASK_BRIEF_MISSING", `Task ${task.id} frozen Brief does not exist`, {
        task_id: task.id,
        path: task.brief_path,
      });
    }
    const currentHash = sha256(await readFile(absolute));
    if (currentHash !== task.brief_hash) {
      throw new RockSpecError("STALE_TASK_BRIEF", `Task ${task.id} frozen Brief changed after Task start`, {
        task_id: task.id,
        path: task.brief_path,
        recorded_hash: task.brief_hash,
        current_hash: currentHash,
      });
    }
  }

  private async loadStageReview(
    changeDir: string,
    change: ChangeSnapshot,
    profile: WorkflowProfile,
    relativePath: string,
    kind: "requirements" | "readiness",
    assertedVerdict?: ReviewVerdict,
  ): Promise<ReviewRecord> {
    const sourcePaths = profile === "strict" ? strictReviewerPaths(relativePath) : [relativePath];
    const paths = profile === "strict" ? [...sourcePaths, relativePath] : sourcePaths;
    const sources: ReviewRecord["sources"] = [];
    let aggregate = "";
    let combinedVerdict: ReviewVerdict = "PASS";
    for (const reviewPath of paths) {
      const absolute = path.join(changeDir, reviewPath);
      if (!(await exists(absolute))) {
        throw new RockSpecError("MISSING_REVIEW", `Review artifact ${reviewPath} does not exist`, {
          path: reviewPath,
        });
      }
      const content = await readFile(absolute, "utf8");
      aggregate += `${reviewPath}\0${sha256(content)}\n`;
      if (!sourcePaths.includes(reviewPath)) continue;
      const document = parseStageReviewDocument(content, reviewPath, kind);
      this.assertRegisteredExecution(
        change,
        document.reviewer_execution_id,
        kind === "requirements" ? "requirements_reviewer" : "readiness_reviewer",
        kind === "requirements" ? "requirements.review" : "readiness.review",
      );
      assertStageFindingRoutes(kind, document.findings, reviewPath);
      combinedVerdict = worseVerdict(combinedVerdict, document.verdict);
      sources.push({
        path: reviewPath,
        content_hash: sha256(content),
        reviewer_execution_id: document.reviewer_execution_id,
        verdict: document.verdict,
        findings: document.findings,
      });
    }
    const reviewerExecutionIds = sources.map((source) => source.reviewer_execution_id);
    if (new Set(reviewerExecutionIds).size !== reviewerExecutionIds.length) {
      throw new RockSpecError("REVIEWERS_NOT_INDEPENDENT", "Strict Stage Review requires distinct Reviewer executions", {
        reviewer_execution_ids: reviewerExecutionIds,
      });
    }
    if (profile === "strict") {
      const aggregateContent = await readFile(path.join(changeDir, relativePath), "utf8");
      const aggregateVerdict = parseVerdict(aggregateContent);
      if (aggregateVerdict !== combinedVerdict) {
        throw new RockSpecError("REVIEW_AGGREGATE_MISMATCH", "Strict aggregate verdict does not match source reports", {
          aggregate: aggregateVerdict,
          sources: combinedVerdict,
        });
      }
    }
    if (assertedVerdict && assertedVerdict !== combinedVerdict) {
      throw new RockSpecError("REVIEW_VERDICT_MISMATCH", "Reported verdict does not match the review artifact", {
        reported: assertedVerdict,
        artifact: combinedVerdict,
      });
    }
    const reportHash = sha256(aggregate);
    return {
      kind,
      verdict: combinedVerdict,
      path: relativePath,
      content_hash: reportHash,
      report_hash: reportHash,
      reviewer_execution_ids: reviewerExecutionIds,
      round: 0,
      sources,
      reviewed_at: this.timestamp(),
      findings: sources.flatMap((source) => source.findings),
    };
  }

  private async loadCodeReview(
    changeDir: string,
    change: ChangeSnapshot,
    profile: WorkflowProfile,
    relativePath: string,
    subject: ReviewPackageResult["subject"],
    excludedReviewerExecutions: string[],
    expectedExpandedPaths: string[],
    assertedVerdict?: ReviewVerdict,
  ): Promise<ReviewRecord> {
    const sourcePaths = profile === "strict"
      ? strictReviewerPaths(relativePath)
      : [relativePath];
    const allPaths = profile === "strict" ? [...sourcePaths, relativePath] : sourcePaths;
    const sources: ReviewRecord["sources"] = [];
    const rounds: number[] = [];
    let combinedVerdict: ReviewVerdict = "PASS";
    let aggregate = "";
    for (const reviewPath of allPaths) {
      const absolute = path.join(changeDir, reviewPath);
      if (!(await exists(absolute))) {
        throw new RockSpecError("MISSING_REVIEW", `Review artifact ${reviewPath} does not exist`, {
          path: reviewPath,
        });
      }
      const content = await readFile(absolute, "utf8");
      aggregate += `${reviewPath}\0${sha256(content)}\n`;
      if (!sourcePaths.includes(reviewPath)) continue;
      const document = parseReviewDocument(content, reviewPath);
      const reviewKind = relativePath.includes("/tasks/") ? "task" : "delivery";
      this.assertRegisteredExecution(
        change,
        document.reviewer_execution_id,
        reviewKind === "task" ? "task_reviewer" : "delivery_reviewer",
        reviewKind === "task" ? "task.review" : "delivery.review",
      );
      const assessedPaths = document.scope_assessment.map((item) => item.path);
      if (new Set(assessedPaths).size !== assessedPaths.length ||
          JSON.stringify([...assessedPaths].sort()) !== JSON.stringify([...expectedExpandedPaths].sort())) {
        throw new RockSpecError("SCOPE_ASSESSMENT_MISMATCH", `${reviewPath} must assess every expanded path exactly once`, {
          path: reviewPath,
          expected_paths: [...expectedExpandedPaths].sort(),
          assessed_paths: [...assessedPaths].sort(),
        });
      }
      assertFindingRoutes(relativePath.includes("/tasks/") ? "task" : "delivery", document.findings, reviewPath);
      if (!sameReviewSubject(document.subject, subject)) {
        throw new RockSpecError("STALE_REVIEW", `${reviewPath} does not cover the current Diff`, {
          path: reviewPath,
          reviewed_subject: document.subject,
          current_subject: subject,
        });
      }
      if (excludedReviewerExecutions.includes(document.reviewer_execution_id)) {
        throw new RockSpecError("REVIEWER_NOT_INDEPENDENT", `${reviewPath} was produced by an Implementer`, {
          path: reviewPath,
          reviewer_execution_id: document.reviewer_execution_id,
        });
      }
      sources.push({
        path: reviewPath,
        content_hash: sha256(content),
        reviewer_execution_id: document.reviewer_execution_id,
        verdict: document.verdict,
        findings: document.findings,
      });
      rounds.push(document.round);
      combinedVerdict = worseVerdict(combinedVerdict, document.verdict);
    }
    const reviewerExecutionIds = sources.map((source) => source.reviewer_execution_id);
    if (new Set(reviewerExecutionIds).size !== reviewerExecutionIds.length) {
      throw new RockSpecError("REVIEWERS_NOT_INDEPENDENT", "Strict Review requires distinct Reviewer executions", {
        reviewer_execution_ids: reviewerExecutionIds,
      });
    }
    if (new Set(rounds).size !== 1) {
      throw new RockSpecError("REVIEW_ROUND_MISMATCH", "Strict Reviewer reports must use the same round", {
        rounds,
      });
    }
    if (profile === "strict") {
      const aggregateContent = await readFile(path.join(changeDir, relativePath), "utf8");
      const aggregateVerdict = parseVerdict(aggregateContent);
      if (aggregateVerdict !== combinedVerdict) {
        throw new RockSpecError("REVIEW_AGGREGATE_MISMATCH", "Strict aggregate verdict does not match source reports", {
          aggregate: aggregateVerdict,
          sources: combinedVerdict,
        });
      }
    }
    if (assertedVerdict && assertedVerdict !== combinedVerdict) {
      throw new RockSpecError("REVIEW_VERDICT_MISMATCH", "Reported verdict does not match Reviewer sources", {
        reported: assertedVerdict,
        sources: combinedVerdict,
      });
    }
    const reportHash = sha256(aggregate);
    return {
      kind: relativePath.includes("/tasks/") ? "task" : "delivery",
      verdict: combinedVerdict,
      path: relativePath,
      content_hash: subject.diff_hash,
      report_hash: reportHash,
      reviewer_execution_ids: reviewerExecutionIds,
      subject,
      round: Math.max(0, ...rounds),
      sources,
      reviewed_at: this.timestamp(),
      findings: sources.flatMap((source) => source.findings),
    };
  }

  private async loadAcceptanceReview(
    changeDir: string,
    change: ChangeSnapshot,
    currentCommit: string,
    excludedReviewerExecutions: string[],
    assertedVerdict?: ReviewVerdict,
  ): Promise<ReviewRecord> {
    const relativePath = "testing/test-report.md";
    const content = await readFile(path.join(changeDir, relativePath), "utf8");
    const document = parseAcceptanceDocument(content, relativePath);
    this.assertRegisteredExecution(change, document.reviewer_execution_id, "acceptance_engineer", "acceptance.validate");
    if (document.verdict === "PASS") {
      const expectedScenarios = [...(await this.loadSpecTraceability(changeDir)).scenarioRequirement.keys()].sort();
      const coveredScenarios = document.scenario_coverage.map((coverage) => coverage.scenario_id).sort();
      if (JSON.stringify(coveredScenarios) !== JSON.stringify(expectedScenarios)) {
        throw new RockSpecError("ACCEPTANCE_SCENARIO_COVERAGE_GAP", "Acceptance must cover every approved Scenario", {
          expected_scenario_ids: expectedScenarios,
          covered_scenario_ids: coveredScenarios,
        });
      }
      for (const coverage of document.scenario_coverage) {
        for (const evidenceId of coverage.evidence_ids) {
          await this.assertAcceptanceEvidence(changeDir, change, currentCommit, evidenceId, coverage.scenario_id);
        }
      }
      if (change.prototype.required) {
        const dimensions = document.ui_evidence.map((item) => item.dimension).sort();
        const expectedDimensions = ["accessibility", "interaction", "responsive"];
        if (JSON.stringify(dimensions) !== JSON.stringify(expectedDimensions)) {
          throw new RockSpecError("UI_EVIDENCE_COVERAGE_GAP", "UI Acceptance must bind responsive, accessibility, and interaction evidence", {
            expected_dimensions: expectedDimensions,
            covered_dimensions: dimensions,
          });
        }
        for (const item of document.ui_evidence) {
          for (const evidenceId of item.evidence_ids) {
            await this.assertAcceptanceEvidence(changeDir, change, currentCommit, evidenceId, undefined, "ui.prototype", true);
          }
        }
      }
    }
    assertFindingRoutes("acceptance", document.findings, relativePath);
    if (document.commit !== currentCommit) {
      throw new RockSpecError("STALE_ACCEPTANCE", "Acceptance report does not cover the current Commit", {
        reported_commit: document.commit,
        current_commit: currentCommit,
      });
    }
    if (excludedReviewerExecutions.includes(document.reviewer_execution_id)) {
      throw new RockSpecError("REVIEWER_NOT_INDEPENDENT", "Acceptance was produced by a Task Implementer", {
        reviewer_execution_id: document.reviewer_execution_id,
      });
    }
    if (assertedVerdict && assertedVerdict !== document.verdict) {
      throw new RockSpecError("REVIEW_VERDICT_MISMATCH", "Reported verdict does not match the Acceptance artifact", {
        reported: assertedVerdict,
        artifact: document.verdict,
      });
    }
    const contentHash = sha256(content);
    return {
      kind: "acceptance",
      verdict: document.verdict,
      path: relativePath,
      content_hash: contentHash,
      report_hash: contentHash,
      reviewer_execution_ids: [document.reviewer_execution_id],
      round: 0,
      sources: [{
        path: relativePath,
        content_hash: contentHash,
        reviewer_execution_id: document.reviewer_execution_id,
        verdict: document.verdict,
        findings: document.findings,
      }],
      reviewed_at: this.timestamp(),
      findings: document.findings,
    };
  }

  private async assertReviewSourcesFresh(changeDir: string, review: ReviewRecord): Promise<void> {
    if (review.sources.length === 0) {
      throw new RockSpecError("REVIEW_SOURCES_MISSING", "Code Review has no structured Reviewer sources", {
        path: review.path,
      });
    }
    for (const source of review.sources) {
      const absolute = path.join(changeDir, source.path);
      if (!(await exists(absolute))) {
        throw new RockSpecError("MISSING_REVIEW", `Review source ${source.path} no longer exists`, {
          path: source.path,
        });
      }
      const currentHash = sha256(await readFile(absolute));
      if (currentHash !== source.content_hash) {
        throw new RockSpecError("STALE_REVIEW", `Review source ${source.path} changed after submission`, {
          path: source.path,
          submitted_hash: source.content_hash,
          current_hash: currentHash,
        });
      }
    }
  }

  private async assertAcceptanceEvidence(
    changeDir: string,
    change: ChangeSnapshot,
    commit: string,
    evidenceId: string,
    scenarioId?: string,
    kind?: string,
    requireArtifact = false,
  ): Promise<void> {
    const evidence = change.evidence.find((record) => record.id === evidenceId);
    if (!evidence || evidence.source !== "executed" || evidence.exit_code !== 0 || evidence.commit !== commit ||
        evidence.action_id !== "acceptance.validate" || (scenarioId && !evidence.scenario_ids.includes(scenarioId)) ||
        (kind && evidence.kind !== kind) || (requireArtifact && evidence.artifact_paths.length === 0)) {
      throw new RockSpecError("INVALID_ACCEPTANCE_EVIDENCE", "Acceptance coverage references evidence without the required execution binding", {
        evidence_id: evidenceId,
        scenario_id: scenarioId ?? null,
        kind: kind ?? null,
        commit,
      });
    }
    if (!evidence.report_path || !evidence.output_hash) {
      throw new RockSpecError("INVALID_EXECUTED_EVIDENCE", "Acceptance evidence is missing its log binding", { evidence_id: evidenceId });
    }
    const report = path.join(changeDir, evidence.report_path);
    if (!(await exists(report)) || sha256(await readFile(report)) !== evidence.output_hash) {
      throw new RockSpecError("STALE_EVIDENCE_LOG", "Acceptance evidence log is missing or changed", { evidence_id: evidenceId });
    }
    for (const artifactPath of evidence.artifact_paths) {
      if (!(await exists(path.join(changeDir, artifactPath)))) {
        throw new RockSpecError("MISSING_EVIDENCE_ARTIFACT", "Acceptance evidence artifact is missing", {
          evidence_id: evidenceId,
          artifact_path: artifactPath,
        });
      }
    }
  }

  private assertRegisteredExecution(
    change: ChangeSnapshot,
    executionId: string,
    role: ChangeSnapshot["execution"]["registry"][number]["role"],
    action: string,
  ): void {
    const execution = change.execution.registry.find((record) => record.id === executionId);
    if (!execution || execution.role !== role || execution.action !== action) {
      throw new RockSpecError("EXECUTION_NOT_REGISTERED", "Report identity is not a registered execution for this role and Action", {
        execution_id: executionId,
        expected_role: role,
        expected_action: action,
      });
    }
  }

  private completeActionExecutions(change: ChangeSnapshot, action: string): void {
    const completedAt = this.timestamp();
    for (const execution of change.execution.registry) {
      if (execution.action !== action || execution.completed_at) continue;
      execution.completed_at = completedAt;
      execution.outcome = "success";
    }
  }

  private async syncTasks(changeDir: string, change: ChangeSnapshot): Promise<void> {
    const taskFiles = (await walkFiles(path.join(changeDir, "tasks")))
      .filter((file) => /^T-[0-9]{3}\.md$/.test(path.basename(file)))
      .sort();
    if (taskFiles.length === 0) {
      throw new RockSpecError("NO_TASKS", "The task plan must contain at least one tasks/T-xxx.md file");
    }
    const plan = parsePlanDefinition(
      await readFile(path.join(changeDir, "plan.md"), "utf8"),
      "plan.md",
    );
    const recovery = change.revisions.find((revision) =>
      revision.status === "open" && revision.mode === "implementation_recovery");
    const feedbackRevision = change.revisions.find((revision) =>
      revision.status === "open" && revision.mode === "feedback_reopen");
    const historyProtected = recovery || feedbackRevision;
    const previousTasks = change.tasks;
    const next: Record<string, TaskRecord> = {};
    const immutableChanges: Array<{ task_id: string; status: "completed" | "suspended"; path: string }> = [];
    for (const file of taskFiles) {
      const id = path.basename(file, ".md");
      const definition = parseTaskDefinition(await readFile(file, "utf8"), path.relative(changeDir, file));
      if (definition.id !== id) {
        throw new RockSpecError("TASK_ID_MISMATCH", `Task definition ${definition.id} does not match ${id}`, {
          path: path.relative(changeDir, file),
          expected: id,
          actual: definition.id,
        });
      }
      const previous = previousTasks[id];
      const activeRevision = recovery ?? feedbackRevision;
      const historicalSupersession = feedbackRevision !== undefined &&
        previous !== undefined &&
        sameTaskDefinition(previous, definition) &&
        definition.supersedes.length > 0 &&
        definition.supersedes.every((supersededId) => {
          const superseded = previousTasks[supersededId];
          return superseded?.status === "superseded" &&
            superseded.superseded_by === id &&
            superseded.superseded_in_revision !== activeRevision?.id;
        });
      if (definition.supersedes.length > 0 && !recovery && !historicalSupersession) {
        throw new RockSpecError("SUPERSESSION_REQUIRES_RECOVERY", `Task ${id} can only supersede another Task during implementation recovery`, {
          task_id: id,
        });
      }
      if (historyProtected && (previous?.status === "completed" || previous?.status === "suspended") && !sameTaskDefinition(previous, definition)) {
        immutableChanges.push({
          task_id: id,
          status: previous.status,
          path: path.relative(changeDir, file),
        });
      }
      next[id] = {
        ...(previous ?? {
          id,
          status: "pending",
          acceptance_criteria: [],
          review_attempts: 0,
          attempts: [],
        }),
        id,
        title: definition.title,
        dependencies: definition.dependencies,
        supersedes: definition.supersedes,
        requirement_ids: definition.requirement_ids,
        scenario_ids: definition.scenario_ids,
        decision_ids: definition.decision_ids,
        finding_ids: definition.finding_ids,
        acceptance_criteria: definition.acceptance_criteria,
        consumes: definition.consumes,
        produces: definition.produces,
        allowed_paths: definition.allowed_paths,
      };
    }
    if (immutableChanges.length > 0) {
      const completed = immutableChanges.filter((item) => item.status === "completed").map((item) => item.task_id);
      const suspended = immutableChanges.filter((item) => item.status === "suspended").map((item) => item.task_id);
      throw new RockSpecError(
        "RECOVERY_PLAN_APPEND_ONLY",
        "Recovery Plan is append-only: preserve completed and suspended Tasks and add a new Remediation or Replacement Task",
        {
          revision_id: (recovery ?? feedbackRevision)?.id,
          immutable_tasks: immutableChanges,
          completed_task_ids: completed,
          suspended_task_ids: suspended,
          recommended_next: {
            action: "plan.create",
            instruction: "Restore immutable Task definitions, then append a new T-xxx Task bound to the triggering Finding",
          },
        },
      );
    }
    if (historyProtected) {
      for (const task of Object.values(previousTasks)) {
        if ((task.status === "completed" || task.status === "suspended") && !next[task.id]) {
          throw new RockSpecError(
            task.status === "completed" ? "COMPLETED_TASK_MISSING" : "SUSPENDED_TASK_MISSING",
            `${task.status === "completed" ? "Completed" : "Suspended"} Task ${task.id} must remain in the recovery Plan`,
            { task_id: task.id, revision_id: historyProtected.id },
          );
        }
      }
      if (!recovery) {
        await this.assertTaskPlanValid(changeDir, next, plan.verification_only_scenario_ids);
        for (const id of Object.keys(next).sort()) {
          const review = `reviews/tasks/${id}-review.md`;
          await this.writeTemplate(changeDir, review, codeReviewTemplate(`${id} Task Review`));
        }
        change.tasks = next;
        return;
      }
      const superseders = new Map<string, string>();
      const recoveryFindingIds = new Set([
        ...(recovery.trigger?.finding_ids ?? []),
        ...recovery.amendments.flatMap((amendment) => amendment.trigger.finding_ids),
      ]);
      for (const task of Object.values(next)) {
        if (task.supersedes.length === 0) continue;
        const previousReplacement = previousTasks[task.id];
        const recoveryHistoricalSupersession = previousReplacement !== undefined &&
          task.supersedes.every((supersededId) => {
            const superseded = previousTasks[supersededId];
            return superseded?.status === "superseded" &&
              superseded.superseded_by === task.id &&
              superseded.superseded_in_revision !== recovery.id;
          });
        if (recoveryHistoricalSupersession) continue;
        if (previousReplacement !== undefined &&
            (previousReplacement.status !== "pending" ||
              JSON.stringify(previousReplacement.supersedes) !== JSON.stringify(task.supersedes))) {
          throw new RockSpecError("REPLACEMENT_TASK_MUST_BE_NEW", `Replacement Task ${task.id} must use a new Task ID`, {
            task_id: task.id,
            revision_id: recovery.id,
          });
        }
        if (task.finding_ids.length === 0 || !task.finding_ids.some((findingId) => recoveryFindingIds.has(findingId))) {
          throw new RockSpecError("REPLACEMENT_FINDING_REQUIRED", `Replacement Task ${task.id} must cover a Recovery Finding`, {
            task_id: task.id,
            revision_id: recovery.id,
            recovery_finding_ids: [...recoveryFindingIds].sort(),
          });
        }
        for (const supersededId of task.supersedes) {
          const superseded = previousTasks[supersededId];
          if (!superseded || superseded.status !== "suspended") {
            throw new RockSpecError("TASK_NOT_SUSPENDED", `Task ${task.id} can only supersede a suspended Task`, {
              task_id: task.id,
              superseded_task_id: supersededId,
              status: superseded?.status ?? "missing",
            });
          }
          if (task.dependencies.includes(supersededId)) {
            throw new RockSpecError("SUPERSESSION_DEPENDENCY_CONFLICT", `Task ${task.id} cannot depend on the Task it supersedes`, {
              task_id: task.id,
              superseded_task_id: supersededId,
            });
          }
          const existing = superseders.get(supersededId);
          if (existing) {
            throw new RockSpecError("TASK_SUPERSEDED_MULTIPLE_TIMES", `Suspended Task ${supersededId} has multiple replacements`, {
              task_id: supersededId,
              replacement_task_ids: [existing, task.id],
            });
          }
          superseders.set(supersededId, task.id);
        }
      }
      if (recovery.kind === "remediation" && recovery.trigger) {
        const newTasks = Object.values(next).filter((task) => previousTasks[task.id] === undefined);
        const mappedFindings = new Set(newTasks.flatMap((task) => task.finding_ids));
        const missingFindings = recovery.trigger.finding_ids.filter((findingId) => !mappedFindings.has(findingId));
        if (newTasks.length === 0 || missingFindings.length > 0) {
          throw new RockSpecError("REMEDIATION_TASK_REQUIRED", "Recovery Plan must add Task coverage for every triggering Finding", {
            revision_id: recovery.id,
            finding_ids: recovery.trigger.finding_ids,
            missing_finding_ids: missingFindings,
          });
        }
      }
    }
    await this.assertTaskPlanValid(changeDir, next, plan.verification_only_scenario_ids);
    for (const id of Object.keys(next).sort()) {
      const review = `reviews/tasks/${id}-review.md`;
      await this.writeTemplate(changeDir, review, codeReviewTemplate(`${id} Task Review`));
      if (change.profile === "strict") {
        for (const strictPath of reviewPaths("strict", review)) {
          await this.writeTemplate(changeDir, strictPath, codeReviewTemplate(`${id} Task Review`));
        }
      }
    }
    change.tasks = next;
  }

  private async loadSpecTraceability(changeDir: string): Promise<SpecTraceability> {
    const requirementScenarios = new Map<string, Set<string>>();
    const scenarioRequirement = new Map<string, string>();
    const specFiles = (await walkFiles(path.join(changeDir, "specs")))
      .filter((file) => file.endsWith(".md"))
      .sort();
    for (const file of specFiles) {
      const relative = path.relative(changeDir, file);
      const result = validateSpec(await readFile(file, "utf8"));
      if (!result.valid || !result.data) {
        throw new RockSpecError("INVALID_SPEC", `${relative} is not a valid RockSpec document`, {
          path: relative,
          issues: result.issues,
        });
      }
      for (const requirement of result.data.requirements) {
        if (requirementScenarios.has(requirement.id)) {
          throw new RockSpecError("DUPLICATE_REQUIREMENT_ID", `Requirement ${requirement.id} is duplicated`, {
            requirement_id: requirement.id,
            path: relative,
          });
        }
        const scenarios = new Set<string>();
        requirementScenarios.set(requirement.id, scenarios);
        for (const scenario of requirement.scenarios) {
          if (scenarioRequirement.has(scenario.id)) {
            throw new RockSpecError("DUPLICATE_SCENARIO_ID", `Scenario ${scenario.id} is duplicated`, {
              scenario_id: scenario.id,
              path: relative,
            });
          }
          scenarios.add(scenario.id);
          scenarioRequirement.set(scenario.id, requirement.id);
        }
      }
    }
    return { requirementScenarios, scenarioRequirement };
  }

  private async assertDesignCoverage(changeDir: string): Promise<void> {
    const content = await readFile(path.join(changeDir, "design.md"), "utf8");
    const design = parseDesignDefinition(content, "design.md");
    const change = await readChange(changeDir);
    const specApproval = change.approvals.spec;
    if (!specApproval || design.inputs.spec_hash !== specApproval.aggregate_hash) {
      throw new RockSpecError("DESIGN_INPUT_STALE", "Design must bind the current approved Spec hash", {
        declared: design.inputs.spec_hash,
        expected: specApproval?.aggregate_hash ?? null,
      });
    }
    const { requirementScenarios, scenarioRequirement } = await this.loadSpecTraceability(changeDir);
    const coveredRequirements = new Set<string>();
    const coveredScenarios = new Set<string>();
    for (const decision of design.decisions) {
      for (const requirementId of decision.requirement_ids) {
        if (!requirementScenarios.has(requirementId)) {
          throw new RockSpecError("DESIGN_REQUIREMENT_NOT_FOUND", `Decision ${decision.id} references an unknown Requirement`, {
            decision_id: decision.id,
            requirement_id: requirementId,
          });
        }
        coveredRequirements.add(requirementId);
      }
      for (const scenarioId of decision.scenario_ids) {
        const owner = scenarioRequirement.get(scenarioId);
        if (!owner) {
          throw new RockSpecError("DESIGN_SCENARIO_NOT_FOUND", `Decision ${decision.id} references an unknown Scenario`, {
            decision_id: decision.id,
            scenario_id: scenarioId,
          });
        }
        if (!decision.requirement_ids.includes(owner)) {
          throw new RockSpecError(
            "DESIGN_SCENARIO_REQUIREMENT_MISMATCH",
            `Decision ${decision.id} must include Requirement ${owner} for Scenario ${scenarioId}`,
            { decision_id: decision.id, scenario_id: scenarioId, requirement_id: owner },
          );
        }
        coveredScenarios.add(scenarioId);
      }
    }
    const missingRequirements = [...requirementScenarios.keys()]
      .filter((requirementId) => !coveredRequirements.has(requirementId))
      .sort();
    const missingScenarios = [...scenarioRequirement.keys()]
      .filter((scenarioId) => !coveredScenarios.has(scenarioId))
      .sort();
    if (missingRequirements.length > 0 || missingScenarios.length > 0) {
      throw new RockSpecError("DESIGN_COVERAGE_GAP", "Design Decisions must cover every approved Requirement and Scenario", {
        requirement_ids: missingRequirements,
        scenario_ids: missingScenarios,
      });
    }
  }

  private async assertProposalReady(changeDir: string): Promise<void> {
    const relativePath = "proposal.md";
    const content = await readFile(path.join(changeDir, relativePath), "utf8");
    const result = ProposalDefinitionSchema.safeParse(parseFrontmatter(content, relativePath));
    if (!result.success) {
      throw new RockSpecError("INVALID_PROPOSAL", "Proposal must declare non-goals, assumptions, and resolved open questions", {
        path: relativePath,
        issues: result.error.issues,
      });
    }
  }

  private async assertPrototypeTraceability(changeDir: string): Promise<void> {
    const change = await readChange(changeDir);
    const specApproval = change.approvals.spec;
    const designContent = await readFile(path.join(changeDir, "design.md"), "utf8");
    const design = parseDesignDefinition(designContent, "design.md");
    const briefContent = await readFile(path.join(changeDir, "prototype", "brief.md"), "utf8");
    const brief = parsePrototypeBriefDefinition(briefContent, "prototype/brief.md");
    const expectedDesignHash = sha256(designContent);
    if (!specApproval || brief.inputs.spec_hash !== specApproval.aggregate_hash || brief.inputs.design_hash !== expectedDesignHash) {
      throw new RockSpecError("PROTOTYPE_INPUT_STALE", "Prototype must bind the current approved Spec and Design Draft hashes", {
        declared: brief.inputs,
        expected: { spec_hash: specApproval?.aggregate_hash ?? null, design_hash: expectedDesignHash },
      });
    }
    const { requirementScenarios, scenarioRequirement } = await this.loadSpecTraceability(changeDir);
    const decisionIds = new Set(design.decisions.map((decision) => decision.id));
    const unknown = {
      requirement_ids: brief.requirement_ids.filter((id) => !requirementScenarios.has(id)),
      scenario_ids: brief.scenario_ids.filter((id) => !scenarioRequirement.has(id)),
      decision_ids: brief.decision_ids.filter((id) => !decisionIds.has(id)),
    };
    if (Object.values(unknown).some((ids) => ids.length > 0)) {
      throw new RockSpecError("PROTOTYPE_TRACEABILITY_INVALID", "Prototype references unknown R/S/D IDs", unknown);
    }
  }

  private async revisionHashes(changeDir: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const relativePath of ["proposal.md", "specs", "design.md", "prototype", "plan.md", "tasks.md", "tasks"]) {
      if (!(await exists(path.join(changeDir, relativePath)))) continue;
      try {
        hashes[relativePath] = (await hashPaths(changeDir, [relativePath])).aggregate_hash;
      } catch (error) {
        if (!(error instanceof RockSpecError) || error.code !== "EMPTY_ARTIFACT_SET") throw error;
      }
    }
    return hashes;
  }

  private async snapshotRevisionArtifacts(
    changeDir: string,
    revisionId: string,
    target: NonNullable<ReviseInput["target"]>,
    mode: RevisionRecord["mode"],
  ): Promise<void> {
    const paths = mode === "implementation_recovery"
      ? [...new Set([
          ...revisionArtifactPaths(target),
          "change.yaml",
          "reviews/tasks",
          "runtime/tasks",
          "testing",
          "reviews/delivery-review.md",
          "evidence",
        ])]
      : revisionArtifactPaths(target);
    const beforeRoot = path.join(changeDir, "revisions", revisionId, "before");
    await mkdir(beforeRoot, { recursive: true });
    for (const relativePath of paths) {
      const source = path.join(changeDir, relativePath);
      if (!(await exists(source))) continue;
      const destination = path.join(beforeRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    }
    if (mode === "pre_implementation" && paths.includes("tasks")) {
      await rm(path.join(changeDir, "tasks"), { recursive: true, force: true });
      await rm(path.join(changeDir, "reviews", "tasks"), { recursive: true, force: true });
      await mkdir(path.join(changeDir, "tasks"), { recursive: true });
      await mkdir(path.join(changeDir, "reviews", "tasks"), { recursive: true });
    }
  }

  private async snapshotRevisionAmendmentArtifacts(
    changeDir: string,
    revision: RevisionRecord,
    amendment: RevisionAmendmentRecord,
    target: NonNullable<ReviseInput["target"]>,
  ): Promise<void> {
    const paths = [...new Set([
      ...revisionArtifactPaths(target),
      "change.yaml",
      "reviews",
      "runtime/tasks",
      "testing",
      "evidence",
    ])];
    const beforeRoot = path.join(
      changeDir,
      "revisions",
      revision.id,
      "amendments",
      amendment.id,
      "before",
    );
    await mkdir(beforeRoot, { recursive: true });
    for (const relativePath of paths) {
      const source = path.join(changeDir, relativePath);
      if (!(await exists(source))) continue;
      const destination = path.join(beforeRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    }
  }

  private async reconcileRevisionIfComplete(
    changeDir: string,
    change: ChangeSnapshot,
    gate: ApprovalGate,
  ): Promise<void> {
    const revision = change.revisions.find((item) => item.status === "open");
    if (!revision) return;
    const requiredGate = revision.target === "plan" ||
        revision.invalidated_approvals.includes("implementation") ||
        revision.invalidated_actions.includes("plan.create")
      ? "implementation"
      : "design";
    if (gate !== requiredGate) return;
    this.applyTaskRecoveryResolutions(change, revision);
    revision.status = "reconciled";
    revision.after_hashes = await this.revisionHashes(changeDir);
    revision.reconciled_at = this.timestamp();
    await atomicWrite(path.join(changeDir, "revisions", `${revision.id}.yaml`), stringify(revision, { lineWidth: 0 }));
  }

  private applyTaskRecoveryResolutions(change: ChangeSnapshot, revision: RevisionRecord): void {
    if (revision.mode !== "implementation_recovery") return;
    const suspended = Object.values(change.tasks).filter((task) => task.status === "suspended");
    for (const task of suspended) {
      const replacements = Object.values(change.tasks).filter((candidate) => candidate.supersedes.includes(task.id));
      if (replacements.length > 1) {
        throw new RockSpecError("TASK_SUPERSEDED_MULTIPLE_TIMES", `Suspended Task ${task.id} has multiple replacements`, {
          task_id: task.id,
          replacement_task_ids: replacements.map((replacement) => replacement.id).sort(),
        });
      }
      const replacement = replacements[0];
      if (!replacement) continue;
      const attempt = task.attempts.at(-1);
      if (!attempt || attempt.status !== "suspended" || attempt.revision_id !== revision.id) {
        throw new RockSpecError("TASK_SUSPENSION_MISMATCH", `Task ${task.id} has no suspended Attempt for ${revision.id}`, {
          task_id: task.id,
          revision_id: revision.id,
        });
      }
      attempt.status = "superseded";
      task.status = "superseded";
      task.superseded_by = replacement.id;
      task.superseded_in_revision = revision.id;
      task.superseded_at = this.timestamp();
    }
    assertTaskExecutionViable(change.tasks);
  }

  private async assertTaskPlanValid(
    changeDir: string,
    tasks: Record<string, TaskRecord>,
    verificationOnlyScenarioIds: string[],
  ): Promise<void> {
    const taskIds = Object.keys(tasks).sort();
    for (const task of Object.values(tasks)) {
      const missing = task.dependencies.filter((dependency) => !(dependency in tasks));
      if (missing.length > 0) {
        throw new RockSpecError("TASK_DEPENDENCY_NOT_FOUND", `Task ${task.id} has unknown dependencies`, {
          task_id: task.id,
          dependencies: missing,
        });
      }
      const missingSuperseded = task.supersedes.filter((superseded) => !(superseded in tasks));
      if (missingSuperseded.length > 0) {
        throw new RockSpecError("SUPERSEDED_TASK_NOT_FOUND", `Task ${task.id} supersedes unknown Tasks`, {
          task_id: task.id,
          supersedes: missingSuperseded,
        });
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string, pathIds: string[]): void => {
      if (visiting.has(taskId)) {
        const start = pathIds.indexOf(taskId);
        const cycle = [...pathIds.slice(start >= 0 ? start : 0), taskId];
        throw new RockSpecError("TASK_DEPENDENCY_CYCLE", "Task dependencies must form an acyclic graph", {
          cycle,
        });
      }
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      for (const dependency of tasks[taskId]?.dependencies ?? []) visit(dependency, [...pathIds, taskId]);
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const taskId of taskIds) visit(taskId, []);

    assertTaskExecutionViable(tasks);

    const ancestors = new Map<string, Set<string>>();
    const collectAncestors = (taskId: string): Set<string> => {
      const cached = ancestors.get(taskId);
      if (cached) return cached;
      const result = new Set<string>();
      for (const dependency of [
        ...(tasks[taskId]?.dependencies ?? []),
        ...(tasks[taskId]?.supersedes ?? []),
      ]) {
        result.add(dependency);
        for (const ancestor of collectAncestors(dependency)) result.add(ancestor);
      }
      ancestors.set(taskId, result);
      return result;
    };

    const producers = new Map<string, string>();
    for (const task of Object.values(tasks)) {
      for (const contract of task.produces) {
        const existing = producers.get(contract);
        if (existing) {
          throw new RockSpecError("TASK_OUTPUT_CONFLICT", `Interface contract is produced by multiple Tasks`, {
            contract,
            tasks: [existing, task.id],
          });
        }
        producers.set(contract, task.id);
      }
    }
    for (const task of Object.values(tasks)) {
      const dependencies = collectAncestors(task.id);
      for (const contract of task.consumes) {
        const producer = producers.get(contract);
        if (!producer) {
          throw new RockSpecError("TASK_INPUT_UNRESOLVED", `Task ${task.id} consumes an unknown contract`, {
            task_id: task.id,
            contract,
          });
        }
        if (!dependencies.has(producer)) {
          throw new RockSpecError("TASK_INPUT_NOT_DEPENDENCY", `Task ${task.id} consumes from a non-dependency`, {
            task_id: task.id,
            contract,
            producer,
          });
        }
      }
    }

    const { requirementScenarios, scenarioRequirement } = await this.loadSpecTraceability(changeDir);
    const design = parseDesignDefinition(await readFile(path.join(changeDir, "design.md"), "utf8"), "design.md");
    const knownDecisions = new Set(design.decisions.map((decision) => decision.id));

    const coveredRequirements = new Set<string>();
    const coveredScenarios = new Set<string>();
    const coveredDecisions = new Set<string>();
    for (const task of Object.values(tasks)) {
      // Preserve coverage for historical Tasks when their IDs remain current;
      // tolerate only IDs or mappings removed by a later Revision.
      const historical = isHistoricalTask(task);
      for (const requirementId of task.requirement_ids) {
        if (!requirementScenarios.has(requirementId)) {
          if (historical) continue;
          throw new RockSpecError("TASK_REQUIREMENT_NOT_FOUND", `Task ${task.id} references an unknown Requirement`, {
            task_id: task.id,
            requirement_id: requirementId,
          });
        }
        coveredRequirements.add(requirementId);
      }
      for (const scenarioId of task.scenario_ids) {
        const owner = scenarioRequirement.get(scenarioId);
        if (!owner) {
          if (historical) continue;
          throw new RockSpecError("TASK_SCENARIO_NOT_FOUND", `Task ${task.id} references an unknown Scenario`, {
            task_id: task.id,
            scenario_id: scenarioId,
          });
        }
        if (!task.requirement_ids.includes(owner)) {
          if (historical) continue;
          throw new RockSpecError(
            "TASK_SCENARIO_REQUIREMENT_MISMATCH",
            `Task ${task.id} must include Requirement ${owner} for Scenario ${scenarioId}`,
            { task_id: task.id, scenario_id: scenarioId, requirement_id: owner },
          );
        }
        coveredScenarios.add(scenarioId);
      }
      for (const decisionId of task.decision_ids) {
        if (!knownDecisions.has(decisionId)) {
          if (historical) continue;
          throw new RockSpecError("TASK_DECISION_NOT_FOUND", `Task ${task.id} references an unknown Design Decision`, {
            task_id: task.id,
            decision_id: decisionId,
          });
        }
        coveredDecisions.add(decisionId);
      }
    }

    const verificationOnly = new Set(verificationOnlyScenarioIds);
    for (const scenarioId of verificationOnly) {
      if (!scenarioRequirement.has(scenarioId)) {
        throw new RockSpecError("PLAN_SCENARIO_NOT_FOUND", `Plan references an unknown verification-only Scenario`, {
          scenario_id: scenarioId,
        });
      }
    }
    const scenarioGaps = [...scenarioRequirement.keys()]
      .filter((scenarioId) => !coveredScenarios.has(scenarioId) && !verificationOnly.has(scenarioId))
      .sort();
    if (scenarioGaps.length > 0) {
      throw new RockSpecError("SCENARIO_COVERAGE_GAP", "Every Scenario must map to a Task or non-code verification", {
        scenario_ids: scenarioGaps,
      });
    }
    const requirementGaps = [...requirementScenarios.entries()]
      .filter(([requirementId, scenarios]) =>
        !coveredRequirements.has(requirementId) &&
        ![...scenarios].every((scenarioId) => verificationOnly.has(scenarioId)))
      .map(([requirementId]) => requirementId)
      .sort();
    if (requirementGaps.length > 0) {
      throw new RockSpecError("REQUIREMENT_COVERAGE_GAP", "Every Requirement must map to a Task or non-code verification", {
        requirement_ids: requirementGaps,
      });
    }
    const decisionGaps = [...knownDecisions].filter((decisionId) => !coveredDecisions.has(decisionId)).sort();
    if (decisionGaps.length > 0) {
      throw new RockSpecError("DECISION_COVERAGE_GAP", "Every approved Design Decision must map to a Task", {
        decision_ids: decisionGaps,
      });
    }
  }

  private async composeTaskBrief(
    changeDir: string,
    change: ChangeSnapshot,
    taskId: string,
  ): Promise<{ content: string; references: string[] }> {
    const task = change.tasks[taskId];
    if (!task) throw new RockSpecError("TASK_NOT_FOUND", `Task ${taskId} does not exist`);
    const taskPath = `tasks/${taskId}.md`;
    const references = ["proposal.md"];
    const specFiles = (await walkFiles(path.join(changeDir, "specs")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.relative(changeDir, file))
      .sort();
    references.push(...specFiles, "design.md", "plan.md", taskPath);
    if (change.prototype.required) {
      await this.assertApprovalFresh(changeDir, change, "design");
      references.push("prototype/brief.md", "prototype/design-system.md", "prototype/prototype.md");
    }

    const [taskContent, specProjection, designContent, planContent] = await Promise.all([
      readFile(path.join(changeDir, taskPath), "utf8"),
      this.composeSpecProjection(changeDir, specFiles, task.requirement_ids, task.scenario_ids),
      readFile(path.join(changeDir, "design.md"), "utf8"),
      readFile(path.join(changeDir, "plan.md"), "utf8"),
    ]);
    const design = parseDesignDefinition(designContent, "design.md");
    const decisionSections = task.decision_ids.map((decisionId) =>
      extractMarkdownSectionById(designContent, decisionId, "Design Decision", "design.md"));
    const globalConstraints = [
      ["design.md", extractOptionalMarkdownSection(designContent, ["Global Constraints", "全局约束"])],
      ["plan.md", extractOptionalMarkdownSection(planContent, ["Global Constraints", "全局约束"])],
    ].filter((item): item is [string, string] => Boolean(item[1]));
    const dependencyFacts = collectTaskAncestors(task, change.tasks)
      .map((dependency) => renderDependencyFact(dependency))
      .join("\n\n");
    const prototypeSections: string[] = [];
    if (change.prototype.required && await exists(path.join(changeDir, "prototype", "brief.md"))) {
      const prototypeBriefContent = await readFile(path.join(changeDir, "prototype", "brief.md"), "utf8");
      const prototypeBrief = parsePrototypeBriefDefinition(prototypeBriefContent, "prototype/brief.md");
      const relevant = intersects(prototypeBrief.requirement_ids, task.requirement_ids) ||
        intersects(prototypeBrief.scenario_ids, task.scenario_ids) ||
        intersects(prototypeBrief.decision_ids, task.decision_ids);
      if (relevant) {
        for (const reference of ["prototype/brief.md", "prototype/design-system.md", "prototype/prototype.md"]) {
          const target = path.join(changeDir, reference);
          if (await exists(target)) {
            prototypeSections.push(`<!-- source: ${reference} -->\n${await readFile(target, "utf8")}`);
          }
        }
      }
    }
    const manifest = await renderAuthorityManifest(changeDir, references, {
      [taskPath]: [taskId],
      ...specProjection.projections,
      "design.md": task.decision_ids,
    });

    const sections = [
      `# ${taskId} Execution Brief`,
      "This is a frozen projection of the approved authority. Implement the Task contract; do not reinterpret or broaden it.",
      "If required behavior, an interface contract, a dependency, or an authority source conflicts with this projection, stop and report `CONTRACT_CONFLICT` or `AUTHORITY_CONFLICT`. If a missing repository fact can be discovered without changing the contract, inspect only the necessary code and record the scope expansion.",
      `## Task Contract\n\n<!-- source: ${taskPath} -->\n${taskContent}`,
      `## Relevant Approved Requirements\n\n${specProjection.content}`,
      `## Relevant Approved Design Decisions\n\n${decisionSections.join("\n\n")}`,
      ...(globalConstraints.length > 0 ? [
        `## Applicable Global Constraints\n\n${globalConstraints.map(([source, body]) => `<!-- source: ${source} -->\n${body}`).join("\n\n")}`,
      ] : []),
      `## Dependency Delivery Facts\n\n${dependencyFacts || "None."}`,
      ...(prototypeSections.length > 0 ? [`## Relevant Approved UI/UX Context\n\n${prototypeSections.join("\n\n")}`] : []),
      `## Authority Manifest\n\n${manifest}`,
    ];
    return {
      content: `${sections.join("\n\n")}\n`,
      references,
    };
  }

  private async composeSpecProjection(
    changeDir: string,
    specFiles: string[],
    requirementIds: string[],
    scenarioIds: string[],
  ): Promise<{ content: string; projections: Record<string, string[]> }> {
    const remainingRequirements = new Set(requirementIds);
    const remainingScenarios = new Set(scenarioIds);
    const sections: string[] = [];
    const projections: Record<string, string[]> = {};
    for (const relativePath of specFiles) {
      const content = await readFile(path.join(changeDir, relativePath), "utf8");
      const result = validateSpec(content);
      if (!result.valid || !result.data) {
        throw new RockSpecError("INVALID_SPEC", `${relativePath} is not a valid RockSpec document`, {
          path: relativePath,
          issues: result.issues,
        });
      }
      for (const requirement of result.data.requirements) {
        if (!remainingRequirements.has(requirement.id)) continue;
        const selectedScenarios = requirement.scenarios
          .map((scenario) => scenario.id)
          .filter((scenarioId) => remainingScenarios.has(scenarioId));
        sections.push(
          `<!-- source: ${relativePath}; projection: ${[requirement.id, ...selectedScenarios].join(", ")} -->\n` +
          projectRequirementMarkdown(content, requirement.id, new Set(selectedScenarios), relativePath),
        );
        projections[relativePath] = [...(projections[relativePath] ?? []), requirement.id, ...selectedScenarios];
        remainingRequirements.delete(requirement.id);
        for (const scenarioId of selectedScenarios) remainingScenarios.delete(scenarioId);
      }
    }
    if (remainingRequirements.size > 0 || remainingScenarios.size > 0) {
      throw new RockSpecError("TASK_AUTHORITY_PROJECTION_GAP", "Task authority IDs could not be projected from the approved Specs", {
        requirement_ids: [...remainingRequirements].sort(),
        scenario_ids: [...remainingScenarios].sort(),
      });
    }
    return { content: sections.join("\n\n"), projections };
  }

  private async assertTaskScopeBlockedState(root: string, task: TaskRecord): Promise<void> {
    if (!task.base_commit) throw new RockSpecError("TASK_BASE_MISSING", `Task ${task.id} has no recorded base commit`);
    await this.assertNoUncommittedProductChanges(root);
    const head = await git(root, ["rev-parse", "HEAD"]);
    const mergeBase = await git(root, ["merge-base", task.base_commit, head]);
    if (mergeBase !== task.base_commit) {
      throw new RockSpecError("TASK_HISTORY_DIVERGED", `Task ${task.id} no longer descends from its base`, {
        task_id: task.id,
        base_commit: task.base_commit,
        head_commit: head,
      });
    }
    const changedPaths = (await git(root, ["diff", "--name-only", "-z", task.base_commit, head]))
      .split("\0")
      .filter(Boolean)
      .filter((candidate) => candidate !== ".rockspec" && !candidate.startsWith(".rockspec/"));
    const productPaths = changedPaths.filter((candidate) =>
      !candidate.startsWith(".agents/skills/") &&
      !candidate.startsWith(".claude/skills/") &&
      !candidate.startsWith(".codex/"),
    );
    if (productPaths.length > 0) {
      throw new RockSpecError("SCOPE_BLOCKED_PRODUCT_DIFF", `Task ${task.id} scope-blocked review requires no product changes`, {
        task_id: task.id,
        changed_paths: productPaths,
      });
    }
  }

  private async assertDeliveryHeadAncestor(root: string, deliveryHead: string, currentCommit: string): Promise<void> {
    let mergeBase: string;
    try {
      mergeBase = await git(root, ["merge-base", deliveryHead, currentCommit]);
    } catch {
      throw new RockSpecError("DELIVERY_HISTORY_DIVERGED", "Current HEAD no longer contains the frozen delivery Commit", {
        delivery_head: deliveryHead,
        current_commit: currentCommit,
      });
    }
    if (mergeBase !== deliveryHead) {
      throw new RockSpecError("DELIVERY_HISTORY_DIVERGED", "Current HEAD no longer contains the frozen delivery Commit", {
        delivery_head: deliveryHead,
        current_commit: currentCommit,
        merge_base: mergeBase,
      });
    }
  }

  private async assertTaskProductState(root: string, task: TaskRecord): Promise<void> {
    if (!task.base_commit) throw new RockSpecError("TASK_BASE_MISSING", `Task ${task.id} has no base commit`);
    await this.assertNoUncommittedProductChanges(root);
    const head = await git(root, ["rev-parse", "HEAD"]);
    const mergeBase = await git(root, ["merge-base", task.base_commit, head]);
    if (mergeBase !== task.base_commit) {
      throw new RockSpecError("TASK_HISTORY_DIVERGED", `Task ${task.id} no longer descends from its base`, {
        task_id: task.id,
        base_commit: task.base_commit,
        head_commit: head,
      });
    }
    const commitCount = Number(await git(root, ["rev-list", "--count", `${task.base_commit}..${head}`]));
    if (commitCount !== 1) {
      throw new RockSpecError("TASK_COMMIT_COUNT", `Task ${task.id} must contain exactly one final Commit`, {
        task_id: task.id,
        base_commit: task.base_commit,
        head_commit: head,
        commit_count: commitCount,
      });
    }
    const message = await git(root, ["show", "-s", "--format=%B", head]);
    const commit = TaskCommitSchema.safeParse({ task_id: task.id, commit_sha: head, message });
    if (!commit.success) {
      throw new RockSpecError("TASK_COMMIT_MESSAGE", `Commit message must contain ${task.id}`, {
        task_id: task.id,
        commit_sha: head,
        required_token: `[${task.id}]`,
        issues: commit.error.issues,
      });
    }
    const changedPaths = (await git(root, ["diff", "--name-only", "-z", task.base_commit, head]))
      .split("\0")
      .filter(Boolean)
      .filter((candidate) => candidate !== ".rockspec" && !candidate.startsWith(".rockspec/"));
    if (changedPaths.length === 0) {
      throw new RockSpecError("EMPTY_TASK_DIFF", `Task ${task.id} has no product changes`);
    }
  }

  private async writeReviewPackage(
    root: string,
    changeDir: string,
    change: ChangeSnapshot,
    kind: "task" | "delivery",
    baseCommit: string,
    headCommit: string,
    taskId?: string,
    mode: "product" | "scope_blocked" = "product",
    plannedPaths: readonly string[] = [],
  ): Promise<ReviewPackageResult> {
    const diff = await git(root, ["diff", "--full-index", "--binary", "-U10", baseCommit, headCommit]);
    const subject = { base_commit: baseCommit, head_commit: headCommit, diff_hash: sha256(diff) };
    const [commits, stat, changedPathOutput] = await Promise.all([
      git(root, ["log", "--oneline", `${baseCommit}..${headCommit}`]),
      git(root, ["diff", "--stat", baseCommit, headCommit]),
      git(root, ["diff", "--name-only", "-z", baseCommit, headCommit]),
    ]);
    const changedPaths = changedPathOutput
      .split("\0")
      .filter(Boolean)
      .filter((candidate) => candidate !== ".rockspec" && !candidate.startsWith(".rockspec/"))
      .sort();
    const scope = kind === "task" ? {
      planned_paths: [...plannedPaths],
      changed_paths: changedPaths,
      expanded_paths: changedPaths.filter((candidate) =>
        !plannedPaths.some((planned) => planned.endsWith("/")
          ? candidate.startsWith(planned)
          : candidate === planned),
      ),
    } : undefined;
    const label = kind === "task" ? `task-${taskId}` : "delivery";
    const relativePath = `runtime/reviews/${label}-${baseCommit.slice(0, 7)}..${headCommit.slice(0, 7)}.diff`;
    const reviewerContext = kind === "task" && taskId
      ? await this.composeTaskReviewerContext(changeDir, change, taskId)
      : await this.composeDeliveryReviewerContext(changeDir, change);
    const content = [
      `# Review package: ${baseCommit}..${headCommit}`,
      `# Diff hash: ${subject.diff_hash}`,
      `# Mode: ${mode}`,
      "",
      "## Reviewer Context",
      reviewerContext,
      "",
      "## Commits",
      commits,
      "",
      "## Files changed",
      stat,
      "",
      ...(scope ? [
        "## Reference scope",
        ...renderReviewPathList("Reference paths", scope.planned_paths),
        ...renderReviewPathList("Changed paths", scope.changed_paths),
        ...renderReviewPathList("Expanded paths", scope.expanded_paths),
        "",
      ] : []),
      "## Diff",
      diff,
      "",
    ].join("\n");
    await atomicWrite(path.join(changeDir, relativePath), content);
    return {
      kind,
      ...(taskId ? { task_id: taskId } : {}),
      ...(kind === "task" ? { mode } : {}),
      ...(scope ? { scope } : {}),
      path: relativePath,
      hash: sha256(content),
      subject,
    };
  }

  private async composeTaskReviewerContext(
    changeDir: string,
    change: ChangeSnapshot,
    taskId: string,
  ): Promise<string> {
    const task = change.tasks[taskId];
    if (!task) throw new RockSpecError("TASK_NOT_FOUND", `Task ${taskId} does not exist`);
    await this.assertTaskBriefFresh(changeDir, task);
    const briefContent = await readFile(path.join(changeDir, task.brief_path!), "utf8");
    const designContent = await readFile(path.join(changeDir, "design.md"), "utf8");
    const design = parseDesignDefinition(designContent, "design.md");
    const relatedDecisions = design.decisions.filter((decision) =>
      !task.decision_ids.includes(decision.id) &&
      (intersects(decision.requirement_ids, task.requirement_ids) || intersects(decision.scenario_ids, task.scenario_ids)));
    const crossCheck = relatedDecisions.length > 0
      ? relatedDecisions.map((decision) =>
          `Mapped ${decision.id} (${[...decision.requirement_ids, ...decision.scenario_ids].join(", ")})\n\n` +
          extractMarkdownSectionById(designContent, decision.id, "Design Decision", "design.md"),
        ).join("\n\n")
      : "No additional Design Decisions share this Task's Requirement or Scenario IDs.";
    const evidence = change.evidence
      .filter((item) => item.task_id === taskId)
      .map((item) => `- ${item.id}: ${item.source} ${item.kind}, commit ${item.commit}, exit ${item.exit_code}, output ${item.output_hash ?? "unhashed"}`)
      .join("\n");
    const report = task.report_path && await exists(path.join(changeDir, task.report_path))
      ? `<!-- source: ${task.report_path}; hash: ${sha256(await readFile(path.join(changeDir, task.report_path)))} -->\n${await readFile(path.join(changeDir, task.report_path), "utf8")}`
      : "Missing Implementer Report.";
    return [
      `### Frozen Implementer Projection\n\n- Path: ${task.brief_path}\n- Hash: ${task.brief_hash}\n\n${briefContent}`,
      `### Reviewer-only Projection Audit\n\nTask mapping: ${[...task.requirement_ids, ...task.scenario_ids, ...task.decision_ids].join(", ")}\n\n${crossCheck}`,
      `### Implementer Report\n\n${report}`,
      `### Executed Evidence Index\n\n${evidence || "No Task evidence is recorded."}`,
    ].join("\n\n");
  }

  private async composeDeliveryReviewerContext(changeDir: string, change: ChangeSnapshot): Promise<string> {
    const authorityPaths = [
      "proposal.md",
      ...(await walkFiles(path.join(changeDir, "specs"))).filter((file) => file.endsWith(".md")).map((file) => path.relative(changeDir, file)).sort(),
      "design.md",
      "plan.md",
    ];
    const manifest = await renderAuthorityManifest(changeDir, authorityPaths, {});
    const taskCoverage = Object.values(change.tasks).sort((left, right) => left.id.localeCompare(right.id)).map((task) =>
      `- ${task.id}: ${task.status}; commit ${task.commit_sha ?? "pending"}; R/S/D ${[...task.requirement_ids, ...task.scenario_ids, ...task.decision_ids].join(", ")}`,
    ).join("\n");
    const evidence = change.evidence.map((item) =>
      `- ${item.id}: ${item.action_id ?? item.task_id ?? "change"}; ${item.source} ${item.kind}; commit ${item.commit}; scenarios ${item.scenario_ids.join(", ") || "none"}`,
    ).join("\n");
    return [
      `### Authority Manifest\n\n${manifest}`,
      `### Change-level Task Coverage\n\n${taskCoverage || "No Tasks."}`,
      `### Evidence Index\n\n${evidence || "No evidence recorded."}`,
    ].join("\n\n");
  }

  private async assertFreshEvidence(
    root: string,
    change: ChangeSnapshot,
    expected: { taskId?: string; actionId?: string; commit?: string },
    executedOnly = false,
  ): Promise<void> {
    const commit = expected.commit ?? (await git(root, ["rev-parse", "HEAD"]));
    const evidence = [...change.evidence].reverse().find((record) =>
      record.exit_code === 0 &&
      record.commit === commit &&
      (!executedOnly || record.source === "executed") &&
      (!expected.taskId || record.task_id === expected.taskId) &&
      (!expected.actionId || record.action_id === expected.actionId),
    );
    if (!evidence) {
      throw new RockSpecError("STALE_EVIDENCE", "Fresh passing evidence is required for the current commit", {
        commit,
        ...(expected.taskId ? { task_id: expected.taskId } : {}),
        ...(expected.actionId ? { action_id: expected.actionId } : {}),
        ...(executedOnly ? { source: "executed" } : {}),
      });
    }
    if (evidence.source === "executed") {
      if (!evidence.report_path || !evidence.output_hash) {
        throw new RockSpecError("INVALID_EXECUTED_EVIDENCE", "Executed evidence is missing its log binding", {
          evidence_id: evidence.id,
        });
      }
      const reportPath = path.join(root, ".rockspec", "changes", change.id, evidence.report_path);
      if (!(await exists(reportPath))) {
        throw new RockSpecError("MISSING_EVIDENCE_LOG", `Evidence log ${evidence.report_path} does not exist`, {
          evidence_id: evidence.id,
        });
      }
      const currentHash = sha256(await readFile(reportPath));
      if (currentHash !== evidence.output_hash) {
        throw new RockSpecError("STALE_EVIDENCE_LOG", `Evidence log ${evidence.report_path} has changed`, {
          evidence_id: evidence.id,
          recorded_hash: evidence.output_hash,
          current_hash: currentHash,
        });
      }
    }
  }

  private async findReusableEvidence(
    changeDir: string,
    change: ChangeSnapshot,
    expected: {
      command: string;
      commit: string;
      taskId?: string;
      actionId?: string;
      scenarioIds: string[];
      findingIds: string[];
      artifactPaths: string[];
    },
  ): Promise<ChangeSnapshot["evidence"][number] | undefined> {
    for (const evidence of [...change.evidence].reverse()) {
      if (evidence.source !== "executed" || evidence.exit_code !== 0 || evidence.commit !== expected.commit ||
          evidence.command !== expected.command || evidence.task_id !== expected.taskId ||
          evidence.action_id !== expected.actionId || !evidence.report_path || !evidence.output_hash) continue;
      if (JSON.stringify(evidence.scenario_ids) !== JSON.stringify(expected.scenarioIds) ||
          JSON.stringify(evidence.finding_ids) !== JSON.stringify(expected.findingIds) ||
          JSON.stringify(evidence.artifact_paths) !== JSON.stringify(expected.artifactPaths)) continue;
      const report = path.join(changeDir, evidence.report_path);
      if (!(await exists(report))) continue;
      if (sha256(await readFile(report)) !== evidence.output_hash) continue;
      return evidence;
    }
    return undefined;
  }

  private async assertPrototypeEvidence(root: string, change: ChangeSnapshot): Promise<void> {
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const evidence = [...change.evidence].reverse().find(
      (record) => record.exit_code === 0 && record.commit === commit && record.kind === "ui.prototype" &&
        record.source === "executed" && record.action_id === "acceptance.validate" &&
        Boolean(record.report_path && record.output_hash) && record.artifact_paths.length > 0,
    );
    if (!evidence) {
      throw new RockSpecError(
        "MISSING_UI_EVIDENCE",
        "UI prototype changes require responsive, accessibility, and interaction evidence",
        { commit, capability: change.prototype.capability },
      );
    }
  }

  private async assertNoUncommittedProductChanges(root: string): Promise<void> {
    const output = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const workflowPaths = new Set([".agents/skills", ".claude/skills", ".codex"]);
    const installLockPath = path.join(root, ".rockspec", "install.lock.yaml");
    if (await exists(installLockPath)) {
      const parsedLock = InstallLockSchema.safeParse(parse(await readFile(installLockPath, "utf8")));
      if (parsedLock.success) {
        for (const managed of parsedLock.data.managed_paths) workflowPaths.add(managed.path);
        for (const host of Object.values(parsedLock.data.hosts)) {
          if (host) workflowPaths.add(host.skills_root);
        }
      }
    }
    const isWorkflowAsset = (file: string): boolean => file === ".rockspec" || file.startsWith(".rockspec/") ||
      [...workflowPaths].some((managed) => file === managed || file.startsWith(`${managed}/`));
    const paths = output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((file) => !isWorkflowAsset(file));
    if (paths.length > 0) {
      throw new RockSpecError(
        "UNCOMMITTED_PRODUCT_CHANGES",
        "Acceptance and Delivery Review require product and test assets to be committed",
        { paths },
      );
    }
  }

  private async findUnassignedProductCommits(root: string, change: ChangeSnapshot): Promise<Array<{ commit: string; paths: string[] }>> {
    if (!change.base_commit) throw new RockSpecError("BASE_COMMIT_MISSING", "Change has no base commit");
    const head = await git(root, ["rev-parse", "HEAD"]);
    const commits = (await git(root, ["rev-list", "--reverse", `${change.base_commit}..${head}`])).split("\n").filter(Boolean);
    const assigned = new Set(Object.values(change.tasks).map((task) => task.commit_sha).filter((sha): sha is string => Boolean(sha)));
    const workflowPrefixes = [".rockspec/", ".agents/", ".claude/", ".codex/"];
    const unassigned: Array<{ commit: string; paths: string[] }> = [];
    for (const commit of commits) {
      if (assigned.has(commit)) continue;
      const statusLines = (await git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", commit])).split("\n")
        .filter(Boolean);
      const productStatusLines = statusLines.filter((line) => {
        const file = line.split("\t").at(-1) ?? "";
        return file && !workflowPrefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
      });
      const paths = productStatusLines.map((line) => line.split("\t").at(-1) ?? "");
      const subject = await git(root, ["show", "-s", "--format=%s", commit]);
      const newAcceptanceTestsOnly = subject.trimStart().startsWith("test(") && productStatusLines.length > 0 &&
        productStatusLines.every((line) => line.trimStart().startsWith("A")) &&
        paths.every((file) => /(?:test|spec|e2e|fixture)/i.test(file));
      if (paths.length > 0 && !newAcceptanceTestsOnly) unassigned.push({ commit, paths });
    }
    return unassigned;
  }

  private async assertProductCommitsAssigned(root: string, change: ChangeSnapshot): Promise<void> {
    const unassigned = await this.findUnassignedProductCommits(root, change);
    if (unassigned.length > 0) {
      const head = await git(root, ["rev-parse", "HEAD"]);
      throw new RockSpecError(
        "UNASSIGNED_PRODUCT_COMMIT",
        "Every product or test Commit between the Change base and delivery head must belong to a completed Task or Remediation Task",
        {
          base_commit: change.base_commit,
          head_commit: head,
          commits: unassigned,
          recommended_next: {
            action: "plan.create",
            instruction: "Attach the repair to a new Finding-bound Remediation Task before Delivery Review",
          },
        },
      );
    }
  }

  private providerAvailable(
    provider: string,
    distribution: "bundled" | "installed" | "host" | undefined,
  ): boolean {
    return distribution === "bundled" || this.availableProviders.has(provider);
  }

  private assertProviderAvailable(config: RockSpecConfig, expectedProvider: string): void {
    const binding = config.capabilities["ui.prototype"];
    if (!binding || binding.provider !== expectedProvider) {
      throw new RockSpecError("CAPABILITY_BINDING_CHANGED", "ui.prototype binding does not match the Change", {
        expected_provider: expectedProvider,
        configured_provider: binding?.provider,
      });
    }
    if (!this.providerAvailable(binding.provider, binding.distribution)) {
      throw new RockSpecError("PROVIDER_UNAVAILABLE", `Provider ${binding.provider} is not available`, {
        capability: "ui.prototype",
        provider: binding.provider,
      });
    }
  }

  private async ensureTemplates(changeDir: string, change: ChangeSnapshot): Promise<void> {
    await Promise.all([
      mkdir(path.join(changeDir, "evidence"), { recursive: true }),
      this.writeTemplate(changeDir, "brief.md", briefTemplate(change)),
      this.writeTemplate(
        changeDir,
        "evidence/verification.yaml",
        stringify({ schema_version: 1, evidence: [] }),
      ),
    ]);
    if (change.profile === "lite") return;

    await Promise.all([
      mkdir(path.join(changeDir, "specs", "change"), { recursive: true }),
      mkdir(path.join(changeDir, "tasks"), { recursive: true }),
      mkdir(path.join(changeDir, "reviews", "tasks"), { recursive: true }),
      mkdir(path.join(changeDir, "testing"), { recursive: true }),
    ]);
    const templates: Record<string, string> = {
      "proposal.md": "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\n## Why\n\nTODO\n\n## What\n\nTODO\n",
      "specs/change/spec.md": specTemplate(change),
      "design.md": "---\nschema_version: 1\ninputs:\n  spec_hash: TODO\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Context\n\nTODO\n\n## Decisions\n\n### D-001\n\nTODO\n",
      "plan.md": "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n\n## Approach\n\nTODO\n\n## Task DAG\n\n- T-001\n",
      "tasks.md": "# Tasks\n\n- [ ] T-001\n",
      "tasks/T-001.md": taskTemplate("T-001"),
      "reviews/requirements-review.md": reviewTemplate("Requirements Review"),
      "reviews/readiness-review.md": reviewTemplate("Readiness Review"),
      "reviews/tasks/T-001-review.md": codeReviewTemplate("T-001 Task Review"),
      "reviews/delivery-review.md": codeReviewTemplate("Delivery Review"),
      "testing/test-plan.md": "# Acceptance Test Plan\n\nTODO\n",
      "testing/test-report.md": acceptanceReviewTemplate(),
    };
    for (const [relativePath, content] of Object.entries(templates)) {
      await this.writeTemplate(changeDir, relativePath, content);
    }
    if (change.profile === "strict") {
      for (const base of [
        "reviews/requirements-review.md",
        "reviews/readiness-review.md",
        "reviews/tasks/T-001-review.md",
        "reviews/delivery-review.md",
      ]) {
        for (const strictPath of reviewPaths("strict", base)) {
          const template = base.includes("/tasks/") || base.includes("delivery-review")
            ? codeReviewTemplate(path.basename(strictPath, ".md"))
            : reviewTemplate(path.basename(strictPath, ".md"));
          await this.writeTemplate(changeDir, strictPath, template);
        }
      }
    }
    if (change.prototype.required) {
      await mkdir(path.join(changeDir, "prototype", "assets"), { recursive: true });
      await Promise.all([
        this.writeTemplate(changeDir, "prototype/brief.md", "---\nschema_version: 1\ninputs:\n  spec_hash: TODO\n  design_hash: TODO\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-001]\n---\n\n# Prototype Brief\n\nTODO\n"),
        this.writeTemplate(changeDir, "prototype/design-system.md", "# Design System\n\nTODO\n"),
        this.writeTemplate(changeDir, "prototype/prototype.md", "# Prototype\n\nTODO\n"),
      ]);
    }
    if (change.uat.policy === "required") {
      await this.writeTemplate(changeDir, "testing/uat-report.md", uatReportTemplate());
    }
  }

  private async writeTemplate(changeDir: string, relativePath: string, content: string): Promise<void> {
    const target = path.join(changeDir, relativePath);
    if (!(await exists(target))) await atomicWrite(target, content);
  }

  private async refreshArtifacts(changeDir: string, change: ChangeSnapshot): Promise<void> {
    for (const relativePath of ["brief.md", "proposal.md", "design.md", "plan.md", "tasks.md"] as const) {
      const target = path.join(changeDir, relativePath);
      if (!(await exists(target))) continue;
      change.artifacts[relativePath.replace(".md", "")] = {
        path: relativePath,
        hash: sha256(await readFile(target)),
        updated_at: this.timestamp(),
      };
    }
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}

function isHistoricalTask(task: TaskRecord): boolean {
  return task.status === "completed" || task.status === "superseded" || task.status === "suspended";
}

function renderReviewPathList(label: string, paths: readonly string[]): string[] {
  return [label, ...(paths.length > 0 ? paths.map((candidate) => `- ${candidate}`) : ["- (none)"]), ""];
}

function validateChangeId(id: string): void {
  try {
    assertProtocolChangeId(id);
  } catch (error) {
    throw new RockSpecError(
      "INVALID_CHANGE_ID",
      "Change ID must be 3-64 lowercase kebab-case characters, start with a letter, and not be reserved",
      {
        change_id: id,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function titleFromId(id: string): string {
  const words = id.split("-");
  return words.map((word, index) => index === 0 ? word[0]?.toUpperCase() + word.slice(1) : word).join(" ");
}

async function requireArtifacts(changeDir: string, relativePaths: string[]): Promise<void> {
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    const target = path.join(changeDir, relativePath);
    if (!(await exists(target))) missing.push(relativePath);
    else {
      const files = await walkFiles(target);
      if (files.length === 0) missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new RockSpecError("MISSING_ARTIFACT", "Required workflow artifacts are missing", { paths: missing });
  }
}

function parseVerdict(content: string): ReviewVerdict {
  const matches = content.match(/^\s*(?:verdict\s*:\s*)?(PASS|CHANGES_REQUIRED|BLOCKED)\s*$/gim);
  const last = matches?.at(-1)?.match(/(PASS|CHANGES_REQUIRED|BLOCKED)/i)?.[1]?.toUpperCase();
  if (last === "PASS" || last === "CHANGES_REQUIRED" || last === "BLOCKED") return last;
  throw new RockSpecError(
    "INVALID_REVIEW",
    "Review must contain a standalone PASS, CHANGES_REQUIRED, or BLOCKED verdict",
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function knowledgePackageFromReceipt(
  receipt: ChangeSnapshot["knowledge_evolution"],
  sourceDigest: string,
): KnowledgePackageResult {
  return {
    change_id: receipt.change_id!,
    already_evolved: true,
    status: receipt.status,
    source_digest: sourceDigest,
    ...(receipt.delta_path ? { delta_path: receipt.delta_path } : {}),
    ...(receipt.delta_hash ? { delta_hash: receipt.delta_hash } : {}),
    baseline_hashes: Object.fromEntries(receipt.updates.map((update) => [update.target, update.before_digest])),
    candidate_hashes: Object.fromEntries(receipt.updates.map((update) => [update.target, update.after_digest])),
    requires_human_approval: receipt.updates.some((update) => update.authority === "normative"),
  };
}

function reviewPaths(profile: WorkflowProfile, relativePath: string): string[] {
  if (profile !== "strict") return [relativePath];
  return [...strictReviewerPaths(relativePath), relativePath];
}

function strictReviewerPaths(relativePath: string): string[] {
  const suffix = relativePath.endsWith(".md") ? relativePath.slice(0, -3) : relativePath;
  return [`${suffix}-reviewer-1.md`, `${suffix}-reviewer-2.md`];
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(right);
  return left.some((value) => values.has(value));
}

function collectTaskAncestors(task: TaskRecord, tasks: Record<string, TaskRecord>): TaskRecord[] {
  const ancestors = new Map<string, TaskRecord>();
  const visit = (taskId: string): void => {
    const dependency = tasks[taskId];
    if (!dependency || ancestors.has(taskId)) return;
    ancestors.set(taskId, dependency);
    for (const parent of dependency.dependencies) visit(parent);
  };
  for (const dependency of task.dependencies) visit(dependency);
  return [...ancestors.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function renderDependencyFact(task: TaskRecord): string {
  const contracts = task.produces.length > 0
    ? task.produces.map((contract) => `  - ${contract}`).join("\n")
    : "  - None declared.";
  return [
    `### ${task.id}`,
    `- Status: ${task.status}`,
    `- Delivered Commit: ${task.commit_sha ?? "not recorded"}`,
    `- Planned paths: ${task.allowed_paths.join(", ") || "none"}`,
    "- Produced contracts:",
    contracts,
  ].join("\n");
}

function markdownHeading(line: string): { level: number; title: string } | undefined {
  const match = /^(#{1,6})\s+(\S.*)\s*$/.exec(line);
  return match ? { level: match[1]!.length, title: match[2]! } : undefined;
}

function extractMarkdownSectionById(
  content: string,
  id: string,
  kind: string,
  relativePath: string,
): string {
  const lines = content.split(/\r?\n/);
  const idPattern = new RegExp(`^${escapeRegExp(id)}(?:\\b|\\s|:)`);
  const start = lines.findIndex((line) => {
    const heading = markdownHeading(line);
    return heading !== undefined && idPattern.test(heading.title);
  });
  if (start < 0) {
    throw new RockSpecError("AUTHORITY_SECTION_MISSING", `${kind} ${id} has no Markdown section`, {
      path: relativePath,
      id,
      kind,
    });
  }
  const level = markdownHeading(lines[start]!)!.level;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = markdownHeading(lines[index]!);
    if (heading && heading.level <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

function extractOptionalMarkdownSection(content: string, titles: string[]): string | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = markdownHeading(line);
    return heading !== undefined && titles.includes(heading.title.trim());
  });
  if (start < 0) return undefined;
  const level = markdownHeading(lines[start]!)!.level;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = markdownHeading(lines[index]!);
    if (heading && heading.level <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function projectRequirementMarkdown(
  content: string,
  requirementId: string,
  scenarioIds: ReadonlySet<string>,
  relativePath: string,
): string {
  const requirementSection = extractMarkdownSectionById(
    content,
    requirementId,
    "Requirement",
    relativePath,
  );
  const lines = requirementSection.split(/\r?\n/);
  const projected: string[] = [];
  let include = true;
  for (const line of lines) {
    const heading = markdownHeading(line);
    const scenarioMatch = heading?.level === 4 ? /^(S-\d{3,})\s+Scenario:/.exec(heading.title) : undefined;
    if (scenarioMatch) include = scenarioIds.has(scenarioMatch[1]!);
    if (include) projected.push(line);
  }
  return projected.join("\n").trimEnd();
}

async function renderAuthorityManifest(
  changeDir: string,
  references: string[],
  projections: Record<string, string[]>,
): Promise<string> {
  const rows = ["| Source | SHA-256 | Projection |", "|---|---|---|"];
  for (const relativePath of references) {
    const target = path.join(changeDir, relativePath);
    if (!(await exists(target))) continue;
    const ids = projections[relativePath];
    rows.push(`| ${relativePath} | ${sha256(await readFile(target))} | ${ids?.join(", ") || "index only"} |`);
  }
  return rows.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFrontmatter(content: string, relativePath: string): unknown {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new RockSpecError("MISSING_FRONTMATTER", `${relativePath} requires YAML frontmatter`, {
      path: relativePath,
    });
  }
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) {
    throw new RockSpecError("INVALID_FRONTMATTER", `${relativePath} has no closing frontmatter delimiter`, {
      path: relativePath,
    });
  }
  try {
    return parse(lines.slice(1, end + 1).join("\n"));
  } catch (error) {
    throw new RockSpecError("INVALID_FRONTMATTER", `${relativePath} contains invalid YAML frontmatter`, {
      path: relativePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseTaskDefinition(content: string, relativePath: string) {
  const result = TaskDefinitionSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_TASK_DEFINITION", `${relativePath} has invalid Task metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function sameTaskDefinition(task: TaskRecord, definition: ReturnType<typeof parseTaskDefinition>): boolean {
  return JSON.stringify({
    title: task.title,
    dependencies: task.dependencies,
    supersedes: task.supersedes,
    requirement_ids: task.requirement_ids,
    scenario_ids: task.scenario_ids,
    decision_ids: task.decision_ids,
    finding_ids: task.finding_ids,
    acceptance_criteria: task.acceptance_criteria,
    consumes: task.consumes,
    produces: task.produces,
    allowed_paths: task.allowed_paths,
  }) === JSON.stringify({
    title: definition.title,
    dependencies: definition.dependencies,
    supersedes: definition.supersedes,
    requirement_ids: definition.requirement_ids,
    scenario_ids: definition.scenario_ids,
    decision_ids: definition.decision_ids,
    finding_ids: definition.finding_ids,
    acceptance_criteria: definition.acceptance_criteria,
    consumes: definition.consumes,
    produces: definition.produces,
    allowed_paths: definition.allowed_paths,
  });
}

function parsePlanDefinition(content: string, relativePath: string) {
  const result = PlanDefinitionSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_PLAN_DEFINITION", `${relativePath} has invalid Plan metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseDesignDefinition(content: string, relativePath: string) {
  const result = DesignDefinitionSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_DESIGN_DEFINITION", `${relativePath} has invalid Design metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parsePrototypeBriefDefinition(content: string, relativePath: string) {
  const result = PrototypeBriefDefinitionSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_PROTOTYPE_BRIEF", `${relativePath} has invalid Prototype metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseReviewDocument(content: string, relativePath: string) {
  const result = ReviewDocumentSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_REVIEW", `${relativePath} has invalid structured Review metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseStageReviewDocument(
  content: string,
  relativePath: string,
  kind: "requirements" | "readiness",
) {
  if (!content.trimStart().startsWith("---")) {
    throw new RockSpecError(
      "UNSTRUCTURED_STAGE_REVIEW",
      `${relativePath} must use structured Frontmatter`,
      { path: relativePath, kind },
    );
  }
  const result = StageReviewDocumentSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_STAGE_REVIEW", `${relativePath} has invalid structured Stage Review metadata`, {
      path: relativePath,
      kind,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseAcceptanceDocument(content: string, relativePath: string) {
  const result = AcceptanceDocumentSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_ACCEPTANCE", `${relativePath} has invalid structured Acceptance metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseReconciliationReviewDocument(content: string, relativePath: string) {
  const result = ReconciliationReviewDocumentSchema.safeParse(parseFrontmatter(content, relativePath));
  if (!result.success) {
    throw new RockSpecError("INVALID_RECONCILIATION_REVIEW", `${relativePath} has invalid Reconciliation Review metadata`, {
      path: relativePath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

function assertFindingRoutes(
  kind: "task" | "acceptance" | "delivery",
  findings: readonly { id: string; route_to: string }[],
  relativePath: string,
): void {
  const allowed = {
    task: ["requirements.clarify", "design.technical", "design.prototype", "plan.create", "task.execute"],
    acceptance: ["requirements.clarify", "design.technical", "design.prototype", "plan.create", "task.execute", "acceptance.validate"],
    delivery: ["requirements.clarify", "design.technical", "design.prototype", "plan.create", "task.execute", "acceptance.validate"],
  } as const;
  const invalid = findings.filter((finding) => !(allowed[kind] as readonly string[]).includes(finding.route_to));
  if (invalid.length > 0) {
    throw new RockSpecError("INVALID_FINDING_ROUTE", `${relativePath} contains Findings that cannot be routed from ${kind}`, {
      path: relativePath,
      findings: invalid.map((finding) => ({ id: finding.id, route_to: finding.route_to })),
      allowed: allowed[kind],
    });
  }
}

function assertStageFindingRoutes(
  kind: "requirements" | "readiness",
  findings: readonly { id: string; route_to: string }[],
  relativePath: string,
): void {
  const allowed = kind === "requirements"
    ? ["requirements.clarify"]
    : ["requirements.clarify", "design.technical", "design.prototype", "plan.create"];
  const invalid = findings.filter((finding) => !allowed.includes(finding.route_to));
  if (invalid.length > 0) {
    throw new RockSpecError("INVALID_FINDING_ROUTE", `${relativePath} contains Findings that cannot be routed from ${kind}`, {
      path: relativePath,
      findings: invalid.map((finding) => ({ id: finding.id, route_to: finding.route_to })),
      allowed,
    });
  }
}

function worseVerdict(left: ReviewVerdict, right: ReviewVerdict): ReviewVerdict {
  const rank: Record<ReviewVerdict, number> = { PASS: 0, CHANGES_REQUIRED: 1, BLOCKED: 2 };
  return rank[right] > rank[left] ? right : left;
}

function sameReviewSubject(
  left: { base_commit: string; head_commit: string; diff_hash: string },
  right: { base_commit: string; head_commit: string; diff_hash: string },
): boolean {
  return left.base_commit === right.base_commit &&
    left.head_commit === right.head_commit &&
    left.diff_hash === right.diff_hash;
}

function formatCommand(executable: string, args: string[]): string {
  return [executable, ...args].map((part) => /^[a-zA-Z0-9_./:=+-]+$/.test(part)
    ? part
    : `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}

function changedArtifactPaths(
  previous: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => previous[key] !== current[key])
    .sort();
}

function recoveryRevisionReason(
  change: ChangeSnapshot,
  reviewId: string,
  findingIds: string[],
): string {
  const findings = change.reviews[reviewId]?.findings ?? [];
  const descriptions = findingIds.map((findingId) => {
    const description = findings.find((finding) => finding.id === findingId)?.description;
    return description ? `${findingId}: ${description}` : findingId;
  });
  return `${reviewId} recovery: ${descriptions.join("; ")}`;
}

const REVISION_ACTIONS = {
  requirements: ["requirements.clarify", "requirements.review", "design.technical", "design.prototype", "plan.create", "readiness.review"],
  design: ["design.technical", "design.prototype", "plan.create", "readiness.review"],
  prototype: ["design.prototype", "design.technical", "plan.create", "readiness.review"],
  plan: ["plan.create", "readiness.review"],
} as const;

function assertRevisionTargetAllowed(change: ChangeSnapshot, target: NonNullable<ReviseInput["target"]>): void {
  const minimum: Record<NonNullable<ReviseInput["target"]>, (typeof STATE_ORDER)[number]> = {
    requirements: "SPEC_APPROVED",
    design: "DESIGNING",
    prototype: "DESIGNING",
    plan: "READINESS_REVIEW",
  };
  if (!stateAtLeast(change.state, minimum[target])) {
    throw new RockSpecError("REVISION_TARGET_NOT_REACHED", `Cannot revise ${target} before ${minimum[target]}`, {
      target,
      current_state: change.state,
      minimum_state: minimum[target],
    });
  }
  if (target === "prototype" && !change.prototype.required) {
    throw new RockSpecError("PROTOTYPE_NOT_REQUIRED", "Cannot revise Prototype for a Change without UI impact");
  }
}

function revisionArtifactPaths(target: NonNullable<ReviseInput["target"]>): string[] {
  if (target === "requirements") {
    return ["proposal.md", "specs", "design.md", "prototype", "plan.md", "tasks.md", "tasks"];
  }
  if (target === "design") return ["design.md", "prototype", "plan.md", "tasks.md", "tasks"];
  if (target === "prototype") return ["prototype", "design.md", "plan.md", "tasks.md", "tasks"];
  return ["plan.md", "tasks.md", "tasks"];
}

function revisionApprovals(
  target: NonNullable<ReviseInput["target"]>,
  approvals: ChangeSnapshot["approvals"],
): ApprovalGate[] {
  const candidates: ApprovalGate[] = target === "requirements"
    ? ["spec", "design", "implementation"]
    : target === "plan"
      ? ["implementation"]
      : ["design", "implementation"];
  return candidates.filter((gate) => approvals[gate] !== undefined);
}

function feedbackAuthorityGate(target: NonNullable<ReviseInput["target"]>): ApprovalGate {
  if (target === "requirements") return "spec";
  if (target === "plan") return "implementation";
  return "design";
}

function revisionGatePolicies(
  target: NonNullable<ReviseInput["target"]>,
  invalidatedApprovals: ApprovalGate[],
  approvalPolicy: RevisionRecord["approval_policy"],
): RevisionRecord["gate_policies"] {
  const policies: RevisionRecord["gate_policies"] = {
    spec: "preserve",
    design: "preserve",
    implementation: "preserve",
  };
  for (const gate of invalidatedApprovals) {
    if (approvalPolicy === "auto") {
      policies[gate] = "auto";
      continue;
    }
    policies[gate] = gate === "implementation" && target !== "plan" ? "auto" : "human";
  }
  return policies;
}

function revisionGatePolicy(revision: RevisionRecord, gate: ApprovalGate): "preserve" | "auto" | "human" {
  const explicit = revision.gate_policies[gate];
  if (explicit) return explicit;
  if (!revision.invalidated_approvals.includes(gate)) return "preserve";
  return revisionGatePolicies(revision.target, revision.invalidated_approvals, revision.approval_policy)[gate] ?? "preserve";
}

function revisionReviews(
  target: NonNullable<ReviseInput["target"]>,
  reviews: ChangeSnapshot["reviews"],
  mode: RevisionRecord["mode"] = "pre_implementation",
): string[] {
  const candidates = target === "requirements" ? ["requirements", "readiness"] : ["readiness"];
  if (mode === "implementation_recovery" || mode === "feedback_reopen") candidates.push("acceptance", "delivery");
  return candidates.filter((review) => reviews[review] !== undefined);
}

function revisionActions(
  target: NonNullable<ReviseInput["target"]>,
  completedActions: ChangeSnapshot["completed_actions"],
  mode: RevisionRecord["mode"] = "pre_implementation",
): ChangeSnapshot["completed_actions"] {
  const invalid = new Set<string>(REVISION_ACTIONS[target]);
  if (mode === "implementation_recovery" || mode === "feedback_reopen") {
    for (const action of ["task.execute", "task.review", "acceptance.validate", "acceptance.uat", "delivery.review", "change.verify"] as const) {
      invalid.add(action);
    }
  }
  return completedActions.filter((action) => invalid.has(action));
}

function isAutoRevision(
  classifications: RevisionRecord["classifications"],
  authorityDelta: RevisionRecord["authority_delta"],
): boolean {
  const allowed = new Set(["consistency_fix", "derived_gap", "implementation_fix"]);
  return authorityDelta === "unchanged" && classifications.every((classification) => allowed.has(classification));
}

function earlierRevisionTarget(
  left: NonNullable<ReviseInput["target"]>,
  right: NonNullable<ReviseInput["target"]>,
): NonNullable<ReviseInput["target"]> {
  const rank: Record<NonNullable<ReviseInput["target"]>, number> = {
    requirements: 0,
    design: 1,
    prototype: 2,
    plan: 3,
  };
  return rank[left] <= rank[right] ? left : right;
}

function worseAuthorityImpact(
  left: RevisionRecord["authority_delta"],
  right: RevisionRecord["authority_delta"],
): RevisionRecord["authority_delta"] {
  if (left === "changed" || right === "changed") return "changed";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "unchanged";
}

function clearFailedReconciliation(change: ChangeSnapshot, action: CompleteActionInput["action"]): void {
  const revision = change.revisions.find((item) => item.status === "open" &&
    item.last_reconciliation && revisionGatePolicy(item, item.last_reconciliation.gate) === "auto");
  const last = revision?.last_reconciliation;
  if (!revision || !last || last.verdict === "PASS") return;
  const repairAction = last.gate === "spec"
    ? "requirements.clarify"
    : last.gate === "design"
      ? "design.technical"
      : "plan.create";
  if (action === repairAction) delete revision.last_reconciliation;
}

function applyPreImplementationRevisionInvalidation(change: ChangeSnapshot, target: NonNullable<ReviseInput["target"]>): void {
  for (const gate of revisionApprovals(target, change.approvals)) delete change.approvals[gate];
  for (const review of revisionReviews(target, change.reviews)) delete change.reviews[review];
  const invalidActions = new Set<string>(REVISION_ACTIONS[target]);
  change.completed_actions = change.completed_actions.filter((action) => !invalidActions.has(action));
  change.tasks = {};
  change.execution = { ...change.execution, active_task: null, active_execution: null };
  change.verification = { status: "pending" };
  resetUat(change);
  if (change.prototype.required && target !== "plan") change.prototype.status = "pending";
  change.state = target === "requirements"
    ? "SCOPING"
    : target === "plan"
      ? "DESIGN_APPROVED"
      : target === "prototype"
        ? "DESIGNING"
        : "SPEC_APPROVED";
}

function applyImplementationRecoveryInvalidation(
  change: ChangeSnapshot,
  target: NonNullable<ReviseInput["target"]>,
  revisionId: string,
  invalidatedApprovals: ApprovalGate[],
  invalidatedReviews: string[],
  invalidatedActions: ChangeSnapshot["completed_actions"],
  headCommit: string,
  suspendedAt: string,
): void {
  for (const gate of invalidatedApprovals) delete change.approvals[gate];
  for (const review of invalidatedReviews) delete change.reviews[review];
  const invalidActions = new Set<string>(invalidatedActions);
  change.completed_actions = change.completed_actions.filter((action) => !invalidActions.has(action));

  const activeTaskId = change.execution.active_task;
  if (activeTaskId) {
    const task = change.tasks[activeTaskId];
    if (!task?.execution_id || !task.base_commit || !task.brief_path || !task.brief_hash) {
      throw new RockSpecError("TASK_EXECUTION_INCOMPLETE", `Active Task ${activeTaskId} cannot be suspended safely`);
    }
    const review = change.reviews[`task:${activeTaskId}`];
    task.attempts.push({
      execution_id: task.execution_id,
      status: "suspended",
      revision_id: revisionId,
      base_commit: task.base_commit,
      head_commit: headCommit,
      brief_path: `revisions/${revisionId}/before/${task.brief_path}`,
      brief_hash: task.brief_hash,
      ...(task.report_path ? { report_path: `revisions/${revisionId}/before/${task.report_path}` } : {}),
      ...(task.report_hash ? { report_hash: task.report_hash } : {}),
      ...(review ? { review_path: `revisions/${revisionId}/before/${review.path}` } : {}),
      ...(review?.report_hash ? { review_hash: review.report_hash } : {}),
      ...(task.review_subject ? { review_subject: task.review_subject } : {}),
      ...(task.review_package_mode ? { review_package_mode: task.review_package_mode } : {}),
      review_attempts: task.review_attempts,
      ...(task.started_at ? { started_at: task.started_at } : {}),
      suspended_at: suspendedAt,
    });
    delete change.reviews[`task:${activeTaskId}`];
    task.status = "suspended";
    task.review_attempts = 0;
    delete task.base_commit;
    delete task.commit_sha;
    delete task.execution_id;
    delete task.brief_path;
    delete task.brief_hash;
    delete task.report_path;
    delete task.report_hash;
    delete task.review_subject;
    delete task.review_package_mode;
    delete task.started_at;
    delete task.completed_at;
  }

  change.execution = { ...change.execution, active_task: null, active_execution: null };
  change.verification = { status: "pending" };
  resetUat(change);
  if (change.prototype.required && target !== "plan") change.prototype.status = "pending";
  change.state = target === "requirements"
    ? "SCOPING"
    : target === "plan"
      ? "DESIGN_APPROVED"
      : target === "prototype"
        ? "DESIGNING"
        : "SPEC_APPROVED";
}

function applyFeedbackRevisionInvalidation(
  change: ChangeSnapshot,
  target: NonNullable<ReviseInput["target"]>,
): void {
  if (change.execution.active_task) {
    throw new RockSpecError("ACTIVE_TASK_FEEDBACK_BLOCKED", "Submit feedback after the active Task has reached a stable review boundary", {
      task_id: change.execution.active_task,
    });
  }
  for (const gate of revisionApprovals(target, change.approvals)) delete change.approvals[gate];
  for (const review of revisionReviews(target, change.reviews, "feedback_reopen")) delete change.reviews[review];
  const invalidActions = new Set<string>(revisionActions(target, change.completed_actions, "feedback_reopen"));
  change.completed_actions = change.completed_actions.filter((action) => !invalidActions.has(action));
  change.execution = { ...change.execution, active_task: null, active_execution: null };
  change.verification = { status: "pending" };
  resetUat(change);
  change.knowledge_evolution = { schema_version: 1, status: "pending", protocol_version: 1, updates: [] };
  delete change.finished_at;
  delete change.delivery_head;
  if (change.prototype.required && target !== "plan") change.prototype.status = "pending";
  change.state = target === "requirements"
    ? "SCOPING"
    : target === "plan"
      ? "DESIGN_APPROVED"
      : target === "prototype"
        ? "DESIGNING"
        : "SPEC_APPROVED";
}

function resetUat(change: ChangeSnapshot): void {
  change.uat = change.uat.policy === "required"
    ? { policy: "required", status: "pending" }
    : { policy: change.uat.policy, status: "not_required" };
}

const STATE_ORDER = [
  "SCOPING",
  "SPEC_REVIEW",
  "SPEC_APPROVED",
  "DESIGNING",
  "DESIGN_APPROVED",
  "PLANNING",
  "READINESS_REVIEW",
  "READY",
  "IMPLEMENTING",
  "ACCEPTANCE_VALIDATING",
  "UAT_PENDING",
  "FINAL_REVIEW",
  "VERIFYING",
  "READY_TO_FINISH",
  "ARCHIVED",
] as const;

const EXECUTION_ACTION_BY_ROLE: Readonly<Record<StartExecutionInput["role"], readonly string[]>> = {
  requirements_author: ["requirements.clarify"],
  requirements_reviewer: ["requirements.review"],
  design_author: ["design.technical", "design.prototype"],
  planner: ["plan.create"],
  readiness_reviewer: ["readiness.review"],
  task_implementer: ["task.execute"],
  task_reviewer: ["task.review"],
  acceptance_engineer: ["acceptance.validate"],
  delivery_reviewer: ["delivery.review"],
  revision_author: ["revision.author"],
  reconciliation_reviewer: ["reconcile.spec", "reconcile.design", "reconcile.implementation"],
  knowledge_author: ["knowledge.evolve.author"],
  knowledge_reviewer: ["knowledge.evolve.review"],
};

function assertExecutionRoleAction(role: StartExecutionInput["role"], action: string): void {
  if (!EXECUTION_ACTION_BY_ROLE[role].includes(action)) {
    throw new RockSpecError("EXECUTION_ROLE_ACTION_MISMATCH", "Execution role is not allowed for this Action", {
      role,
      action,
      allowed_actions: EXECUTION_ACTION_BY_ROLE[role],
    });
  }
}

function stateAtLeast(changeState: ChangeSnapshot["state"], target: (typeof STATE_ORDER)[number]): boolean {
  const current = STATE_ORDER.indexOf(changeState as (typeof STATE_ORDER)[number]);
  return current >= STATE_ORDER.indexOf(target);
}

function isTerminalTask(task: TaskRecord): boolean {
  return task.status === "completed" || task.status === "superseded";
}

function taskDependenciesComplete(task: TaskRecord, tasks: TaskRecord[]): boolean {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependencies.every((dependency) => byId.get(dependency)?.status === "completed");
}

function assertTaskExecutionViable(tasks: Record<string, TaskRecord>): void {
  const plannedSuperseded = new Set(Object.values(tasks).flatMap((task) => task.supersedes));
  for (const task of Object.values(tasks)) {
    const invalidDependencies = task.dependencies.filter((dependency) => plannedSuperseded.has(dependency));
    if (invalidDependencies.length > 0) {
      throw new RockSpecError(
        "TASK_DEPENDS_ON_SUPERSEDED",
        `Task ${task.id} must depend on the replacement Task instead of a superseded baseline`,
        { task_id: task.id, dependencies: invalidDependencies },
      );
    }
  }

  const satisfied = new Set(
    Object.values(tasks)
      .filter((task) => task.status === "completed")
      .map((task) => task.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of Object.values(tasks)) {
      if (satisfied.has(task.id) || plannedSuperseded.has(task.id)) continue;
      if (!["pending", "suspended", "in_progress"].includes(task.status)) continue;
      if (task.dependencies.every((dependency) => satisfied.has(dependency))) {
        satisfied.add(task.id);
        changed = true;
      }
    }
  }

  const stranded = Object.values(tasks)
    .filter((task) => !isTerminalTask(task) && !plannedSuperseded.has(task.id) && !satisfied.has(task.id))
    .map((task) => ({ id: task.id, status: task.status, dependencies: task.dependencies }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (stranded.length > 0) {
    throw new RockSpecError("TASK_GRAPH_NOT_RUNNABLE", "Task graph contains Tasks that can never become runnable", {
      tasks: stranded,
    });
  }
}

function deduplicateBlocks(blocks: BlockReason[]): BlockReason[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.code}:${block.message}:${block.paths?.join(",") ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeExecutionUsage(
  usage: CompleteExecutionInput["usage"],
): NonNullable<CompleteExecutionInput["usage"]> | undefined {
  if (!usage) return undefined;
  const normalized: NonNullable<CompleteExecutionInput["usage"]> = {};
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"] as const) {
    const value = usage[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new RockSpecError("INVALID_EXECUTION_USAGE", `${key} must be a non-negative integer`, { key, value });
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function briefTemplate(change: ChangeSnapshot): string {
  return `# ${change.title}\n\n## Scope\n\nTODO\n\n## Verification\n\nTODO\n`;
}

function specTemplate(change: ChangeSnapshot): string {
  return `# ${change.title}\n\n## ADDED Requirements\n\n### R-001 Requirement: TODO\n\nThe system MUST TODO.\n\n#### S-001 Scenario: TODO\n\n- GIVEN TODO\n- WHEN TODO\n- THEN TODO\n`;
}

function taskTemplate(id: string): string {
  return `---\nschema_version: 1\nid: ${id}\ntitle: TODO\ndependencies: []\nsupersedes: []\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-001]\nfinding_ids: []\nacceptance_criteria:\n  - TODO\nconsumes: []\nproduces: []\nallowed_paths:\n  - TODO\n---\n\n# ${id}\n\n## Goal\n\nTODO\n\n## Traceability\n\n- R-001\n- S-001\n- D-001\n\n## Acceptance Criteria\n\nTODO\n\n## Verification\n\nTODO\n`;
}

function reviewTemplate(title: string): string {
  return `---\nschema_version: 1\nverdict: BLOCKED\nreviewer_execution_id: TODO\nfindings: []\n---\n\n# ${title}\n\nVerdict: BLOCKED\n\n## Findings\n\nTODO\n`;
}

function codeReviewTemplate(title: string): string {
  return `---\nschema_version: 1\nverdict: BLOCKED\nreviewer_execution_id: TODO\nsubject:\n  base_commit: TODO\n  head_commit: TODO\n  diff_hash: TODO\nround: 0\nscope_assessment: []\nfindings: []\n---\n\n# ${title}\n\nVerdict: BLOCKED\n\n## Four-axis assessment\n\nTODO\n\n## Findings\n\nTODO\n`;
}

function acceptanceReviewTemplate(): string {
  return `---\nschema_version: 1\nverdict: BLOCKED\nreviewer_execution_id: TODO\ncommit: TODO\nscenario_coverage: []\nui_evidence: []\nfindings: []\n---\n\n# Acceptance Test Report\n\nVerdict: BLOCKED\n\n## Findings\n\nTODO\n`;
}

function uatReportTemplate(): string {
  return `---\nschema_version: 1\nverdict: CONFIRMED\nconfirmed_by: TODO\ncommit: TODO\nscenario_ids: [S-001]\nnotes: TODO\n---\n\n# User Acceptance\n\nTODO\n`;
}

async function archiveReviewAttempt(
  changeDir: string,
  relativePath: string,
  basename: string,
): Promise<string> {
  const historyDir = path.join(changeDir, "reviews", "history");
  await mkdir(historyDir, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const archived = path.join(historyDir, `${basename}-attempt-${String(attempt).padStart(3, "0")}.md`);
    if (await exists(archived)) continue;
    await cp(path.join(changeDir, relativePath), archived, { errorOnExist: true, force: false });
    return path.relative(changeDir, archived);
  }
}

async function archiveReconciliationReview(
  changeDir: string,
  revisionId: string,
  gate: ApprovalGate,
  round: number,
  relativePath: string,
): Promise<void> {
  const target = path.join(
    changeDir,
    "revisions",
    revisionId,
    "reviews",
    "history",
    `${gate}-round-${String(round).padStart(3, "0")}.md`,
  );
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(changeDir, relativePath), target, { force: true });
}

function reconciliationReviewTemplate(prepared: ReconciliationPackageResult): string {
  const metadata = stringify({
    schema_version: 1,
    revision_id: prepared.revision_id,
    gate: prepared.gate,
    round: prepared.round,
    verdict: "BLOCKED",
    reviewer_execution_id: "TODO",
    classifications: prepared.classifications,
    authority_delta: "unknown",
    finding_ids: prepared.finding_ids,
    subject: prepared.subject,
    findings: [],
  }, { lineWidth: 0 }).trimEnd();
  return `---\n${metadata}\n---\n\n# Reconciliation Review\n\n## Authority boundary\n\nTODO\n\n## Downstream closure\n\nTODO\n\n## Findings\n\nTODO\n`;
}

function implementerReportTemplate(
  taskId: string,
  executionId: string,
  baseCommit: string,
  briefPath: string,
  briefHash: string,
): string {
  return `# ${taskId} Implementer Report\n\n- Execution ID: ${executionId}\n- Base Commit: ${baseCommit}\n- Final Commit: TODO\n- Frozen Brief: ${briefPath}\n- Brief Hash: ${briefHash}\n\n## Implemented behavior\n\nTODO\n\n## Files changed\n\nTODO\n\n## TDD and verification evidence\n\nTODO\n\n## Concerns and residual risks\n\nTODO\n`;
}
