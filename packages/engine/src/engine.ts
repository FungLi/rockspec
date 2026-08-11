import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import {
  DesignDefinitionSchema,
  PlanDefinitionSchema,
  ReviewDocumentSchema,
  TaskDefinitionSchema,
  TaskCommitSchema,
  assertChangeId as assertProtocolChangeId,
  validateSpec,
} from "@rockspec/protocol";
import { RockSpecError } from "./error.js";
import { approvalPaths, hashPaths, sha256 } from "./hashing.js";
import {
  DEFAULT_CONFIG,
  activeChangeIds,
  appendEvent,
  atomicWrite,
  changeLocationsAcrossWorktrees,
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
  ApprovalRecord,
  ArchiveResult,
  BlockReason,
  ChangeInput,
  ChangeSnapshot,
  CompleteActionInput,
  CompleteTaskInput,
  EngineOptions,
  EventRecord,
  FinishInput,
  GateInput,
  InitResult,
  NewChangeInput,
  PromoteInput,
  RecordEvidenceInput,
  ReviewPackageInput,
  ReviewPackageResult,
  ReviewRecord,
  ReviewVerdict,
  StatusResult,
  RunCheckInput,
  RunCheckResult,
  TaskBriefResult,
  TaskInput,
  TaskRecord,
  ValidationResult,
  ValidateInput,
  WorkflowProfile,
  ApproveInput,
} from "./types.js";
import { assertActionAllowed, workflowAdvice } from "./workflow.js";

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
  private readonly clock: () => Date;

  constructor(options: EngineOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.clock = options.now ?? (() => new Date());
    this.availableProviders = options.availableProviders ?? new Set<string>();
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
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
        ]);
      },
      this.lockTimeoutMs,
    );
    return { schema_version: 1, repository_root: root, rocks_root: rocksRoot, created };
  }

  async newChange(input: NewChangeInput): Promise<StatusResult> {
    validateChangeId(input.id);
    const context = await this.context();
    const profile = input.profile ?? context.config.default_profile;
    const changeDir = path.join(context.rocksRoot, "changes", input.id);
    const now = this.timestamp();
    let snapshot: ChangeSnapshot | undefined;

    await withFileLock(
      context.rocksRoot,
      async () => {
        const activeChanges = await activeChangeIds(context.rocksRoot);
        if (activeChanges.length > 0) {
          throw new RockSpecError(
            "WORKSPACE_ALREADY_BOUND",
            "This workspace already contains an active Change; use an isolated Worktree",
            { active_changes: activeChanges },
          );
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
        const baseCommit = await git(context.root, ["rev-parse", "HEAD"]);
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
          prototype: {
            required: input.prototypeRequired ?? false,
            capability: "ui.prototype",
            provider: binding.provider,
            status: input.prototypeRequired ? "pending" : "not_required",
          },
          execution: { active_task: null, active_execution: null },
          tasks: {},
          evidence: [],
          reviews: {},
          verification: { status: "pending" },
          completed_actions: [],
        };
        snapshot = createdSnapshot;
        try {
          await mkdir(path.dirname(changeDir), { recursive: true });
          await mkdir(changeDir, { recursive: false });
          await this.ensureTemplates(changeDir, createdSnapshot);
          await this.refreshArtifacts(changeDir, createdSnapshot);
          await writeChange(changeDir, createdSnapshot);
          await appendEvent(changeDir, {
            schema_version: 1,
            sequence: 1,
            event: "change.created",
            change_id: createdSnapshot.id,
            occurred_at: now,
            previous_state: "SCOPING",
            current_state: "SCOPING",
            data: {
              profile,
              prototype_required: createdSnapshot.prototype.required,
              workspace: createdSnapshot.workspace,
            },
          });
        } catch (error) {
          await rm(changeDir, { recursive: true, force: true });
          throw error;
        }
      },
      this.lockTimeoutMs,
    );

    if (!snapshot) throw new RockSpecError("INTERNAL_ERROR", "Change creation produced no snapshot");
    return this.statusFor(context, changeDir, snapshot);
  }

  async getStatus(input: ChangeInput = {}): Promise<StatusResult> {
    const context = await this.context();
    const located = await this.locateChange(context, input.changeId, true);
    return this.statusFor(context, located.changeDir, located.change);
  }

  async continue(input: ChangeInput = {}): Promise<StatusResult> {
    return this.getStatus(input);
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
      await this.assertNoStalePrerequisites(changeDir, change, input.action);
      let actionPassed = true;

      switch (input.action) {
        case "change.triage":
          await this.assertMaterialized(changeDir, ["brief.md"]);
          if (change.profile === "lite") change.state = "IMPLEMENTING";
          break;
        case "requirements.clarify":
          await requireArtifacts(changeDir, ["proposal.md", "specs"]);
          await this.assertMaterialized(changeDir, ["proposal.md", "specs"], true);
          change.state = "SPEC_REVIEW";
          break;
        case "requirements.review":
          change.reviews.requirements = await this.loadReview(
            changeDir,
            change.profile,
            "reviews/requirements-review.md",
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
          change.prototype.status = "completed";
          break;
        case "plan.create":
          await requireArtifacts(changeDir, ["plan.md", "tasks.md", "tasks"]);
          await this.assertMaterialized(changeDir, ["plan.md", "tasks.md", "tasks"]);
          await this.syncTasks(changeDir, change);
          change.state = "READINESS_REVIEW";
          break;
        case "readiness.review":
          change.reviews.readiness = await this.loadReview(
            changeDir,
            change.profile,
            "reviews/readiness-review.md",
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
          if (task.review_attempts >= 3) {
            throw new RockSpecError("REVIEW_ROUND_LIMIT", `Task ${taskId} exhausted its two fix reviews`, {
              task_id: taskId,
              review_attempts: task.review_attempts,
            });
          }
          await this.assertTaskProductState(context.root, task);
          const reviewPackage = await this.writeReviewPackage(
            context.root,
            changeDir,
            "task",
            task.base_commit,
            await git(context.root, ["rev-parse", "HEAD"]),
            taskId,
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
            change.profile,
            `reviews/tasks/${taskId}-review.md`,
            reviewPackage.subject,
            [task.execution_id],
            input.verdict,
          );
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
          change.reviews.acceptance = await this.loadReview(
            changeDir,
            "standard",
            "testing/test-report.md",
            input.verdict,
          );
          actionPassed = change.reviews.acceptance.verdict === "PASS";
          if (actionPassed) {
            await this.assertFreshEvidence(context.root, change, { actionId: "acceptance.validate" }, true);
            if (change.prototype.required) {
              await this.assertPrototypeEvidence(context.root, change);
            }
            change.state = "FINAL_REVIEW";
          }
          break;
        case "delivery.review": {
          await this.assertNoUncommittedProductChanges(context.root);
          if (!change.base_commit) throw new RockSpecError("BASE_COMMIT_MISSING", "Change has no base commit");
          const reviewPackage = await this.writeReviewPackage(
            context.root,
            changeDir,
            "delivery",
            change.base_commit,
            await git(context.root, ["rev-parse", "HEAD"]),
          );
          const implementerExecutions = Object.values(change.tasks)
            .map((task) => task.execution_id)
            .filter((execution): execution is string => Boolean(execution));
          change.reviews.delivery = await this.loadCodeReview(
            changeDir,
            change.profile,
            "reviews/delivery-review.md",
            reviewPackage.subject,
            implementerExecutions,
            input.verdict,
          );
          actionPassed = change.reviews.delivery.verdict === "PASS";
          if (actionPassed) change.state = "VERIFYING";
          break;
        }
      }
      if (actionPassed && !change.completed_actions.includes(input.action)) change.completed_actions.push(input.action);
      await this.refreshArtifacts(changeDir, change);
      return { action: input.action, passed: actionPassed };
    });
    return this.statusFor(result.context, result.changeDir, result.change);
  }

  async approve(input: ApproveInput): Promise<StatusResult> {
    const result = await this.mutate(input.changeId, `approval.${input.gate}.recorded`, async (change, changeDir) => {
      this.assertApprovalState(change, input.gate);
      if (input.gate === "spec") {
        await this.assertMaterialized(changeDir, ["proposal.md", "specs"], true);
        this.assertReviewPassed(change, "requirements");
        await this.assertReviewFresh(changeDir, change, "requirements");
      } else if (input.gate === "design") {
        await this.assertApprovalFresh(changeDir, change, "spec");
        await this.assertMaterialized(
          changeDir,
          change.prototype.required ? ["design.md", "prototype"] : ["design.md"],
        );
        if (change.prototype.required && change.prototype.status !== "completed") {
          throw new RockSpecError("PROTOTYPE_INCOMPLETE", "Complete the UI prototype before Design approval");
        }
      } else {
        await this.assertApprovalFresh(changeDir, change, "spec");
        await this.assertApprovalFresh(changeDir, change, "design");
        await this.assertMaterialized(changeDir, ["plan.md", "tasks.md", "tasks"]);
        this.assertReviewPassed(change, "readiness");
        await this.assertReviewFresh(changeDir, change, "readiness");
        if (Object.keys(change.tasks).length === 0) {
          throw new RockSpecError("NO_TASKS", "At least one Task is required before implementation approval");
        }
      }
      const hashes = await hashPaths(
        changeDir,
        approvalPaths(input.gate, change.prototype.required),
      );
      const approval: ApprovalRecord = {
        gate: input.gate,
        ...hashes,
        approved_by: input.approvedBy ?? "user",
        approved_at: this.timestamp(),
      };
      change.approvals[input.gate] = approval;
      if (input.gate === "spec") change.state = "SPEC_APPROVED";
      else if (input.gate === "design") change.state = "DESIGN_APPROVED";
      else change.state = "READY";
      return { gate: input.gate, aggregate_hash: approval.aggregate_hash };
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
      await this.ensureTemplates(changeDir, change);
      return { previous_profile: previousProfile, profile: input.profile };
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
        scenario_ids: [],
        finding_ids: [],
        artifact_paths: [],
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
    const command = formatCommand(executable, input.args ?? []);
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
      tasks.find((task) => task.status === "pending") ??
      null;
  }

  async startTask(input: TaskInput): Promise<StatusResult> {
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
      const baseCommit = await git(context.root, ["rev-parse", "HEAD"]);
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
      task.started_at ??= this.timestamp();
      task.base_commit = baseCommit;
      task.execution_id = executionId;
      task.brief_path = briefPath;
      task.brief_hash = briefHash;
      task.report_path = reportPath;
      delete task.report_hash;
      delete task.review_subject;
      task.review_attempts = 0;
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

  async prepareReviewPackage(input: ReviewPackageInput): Promise<ReviewPackageResult> {
    let prepared: ReviewPackageResult | undefined;
    await this.mutate(input.changeId, "review.package.prepared", async (change, changeDir, context) => {
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
        await this.assertTaskBriefFresh(changeDir, task);
        await this.assertTaskProductState(context.root, task);
        if (!task.report_path) {
          throw new RockSpecError("IMPLEMENTER_REPORT_MISSING", `Task ${input.taskId} has no Implementer report path`);
        }
        await this.assertMaterialized(changeDir, [task.report_path]);
        task.report_hash = sha256(await readFile(path.join(changeDir, task.report_path)));
        prepared = await this.writeReviewPackage(
          context.root,
          changeDir,
          "task",
          task.base_commit,
          await git(context.root, ["rev-parse", "HEAD"]),
          input.taskId,
        );
        task.review_subject = prepared.subject;
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
        "task",
        task.base_commit,
        commitSha,
        input.taskId,
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
      if (Object.values(change.tasks).every((candidate) => candidate.status === "completed")) {
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
      const currentCommit = await git(context.root, ["rev-parse", "HEAD"]);
      if (change.verification.commit !== currentCommit) {
        throw new RockSpecError("STALE_EVIDENCE", "The final verification does not match the current commit", {
          verified_commit: change.verification.commit,
          current_commit: currentCommit,
        });
      }
      change.finished_at = this.timestamp();
      return { disposition: input.disposition ?? "keep", commit: currentCommit };
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
        try {
          await rename(located.changeDir, staging);
          const specSource = path.join(staging, "specs");
          if (await exists(specSource)) {
            await cp(specSource, context.rocksRoot + "/specs", { recursive: true, force: true });
          }
          current.state = "ARCHIVED";
          current.archived_at = this.timestamp();
          current.updated_at = current.archived_at;
          await writeChange(staging, current);
          await appendEvent(staging, {
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
        } catch (error) {
          if (await exists(staging)) {
            await writeChange(staging, before);
            await rename(staging, located.changeDir);
          }
          throw error;
        }
      },
      this.lockTimeoutMs,
    );
    if (!archived) throw new RockSpecError("INTERNAL_ERROR", "Archive produced no snapshot");
    const status = await this.statusFor(context, archivePath, archived);
    return { ...status, archive_path: archivePath };
  }

  private async context(): Promise<Context> {
    const repository = await resolveRepository(this.cwd);
    return { ...repository, config: await readConfig(repository.rocksRoot) };
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
        const previousState = change.state;
        const data = await operation(change, initiallyLocated.changeDir, context);
        change.updated_at = this.timestamp();
        await writeChange(initiallyLocated.changeDir, change);
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
        await appendEvent(initiallyLocated.changeDir, event);
      },
      this.lockTimeoutMs,
    );
    return { context, changeDir: initiallyLocated.changeDir, change };
  }

  private async statusFor(
    context: Context,
    changeDir: string,
    change: ChangeSnapshot,
  ): Promise<StatusResult> {
    const blocked = await this.collectBlockers(context, changeDir, change);
    const advice = workflowAdvice(change, blocked);
    return {
      schema_version: 1,
      current_state: change.state,
      change,
      recommended_next: advice.recommended,
      alternatives: advice.alternatives,
      blocked_by: blocked,
      allowed_actions: advice.allowed,
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
      if (change.reviews.delivery.subject?.head_commit !== currentCommit) {
        blocked.push({
          code: "STALE_REVIEW",
          message: "Delivery Review does not cover the current commit",
          paths: ["delivery"],
        });
      }
    }
    if (change.state === "DESIGNING" && change.prototype.required && change.prototype.status !== "completed") {
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
      if (change.prototype.required && change.prototype.status !== "completed") {
        add("PROTOTYPE_INCOMPLETE", "Required UI prototype is incomplete", ["prototype"]);
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
    }
    if ((relevant === "acceptance" || relevant === "change") &&
        stateAtLeast(change.state, "FINAL_REVIEW") && change.reviews.acceptance?.verdict !== "PASS") {
      add("ACCEPTANCE_NOT_PASSED", "Acceptance validation has not passed", ["testing/test-report.md"]);
    }
    if (relevant === "task" && stateAtLeast(change.state, "ACCEPTANCE_VALIDATING")) {
      for (const task of Object.values(change.tasks)) {
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
    if (["task.execute", "task.review", "acceptance.validate", "delivery.review"].includes(action)) {
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
      if (/\bTODO\b/i.test(content)) {
        throw new RockSpecError("UNRESOLVED_PLACEHOLDER", `${relative} still contains TODO`, {
          path: relative,
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

  private async loadReview(
    changeDir: string,
    profile: WorkflowProfile,
    relativePath: string,
    assertedVerdict?: ReviewVerdict,
  ): Promise<ReviewRecord> {
    const paths = reviewPaths(profile, relativePath);
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
      const verdict = parseVerdict(content);
      combinedVerdict = worseVerdict(combinedVerdict, verdict);
      aggregate += `${reviewPath}\0${sha256(content)}\n`;
    }
    if (assertedVerdict && assertedVerdict !== combinedVerdict) {
      throw new RockSpecError("REVIEW_VERDICT_MISMATCH", "Reported verdict does not match the review artifact", {
        reported: assertedVerdict,
        artifact: combinedVerdict,
      });
    }
    const reportHash = sha256(aggregate);
    return {
      verdict: combinedVerdict,
      path: relativePath,
      content_hash: reportHash,
      report_hash: reportHash,
      reviewer_execution_ids: [],
      round: 0,
      sources: [],
      reviewed_at: this.timestamp(),
      findings: [],
    };
  }

  private async loadCodeReview(
    changeDir: string,
    profile: WorkflowProfile,
    relativePath: string,
    subject: ReviewPackageResult["subject"],
    excludedReviewerExecutions: string[],
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
    const next: Record<string, TaskRecord> = {};
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
      next[id] = {
        ...(change.tasks[id] ?? {
          id,
          status: "pending",
          acceptance_criteria: [],
          review_attempts: 0,
        }),
        id,
        title: definition.title,
        dependencies: definition.dependencies,
        requirement_ids: definition.requirement_ids,
        scenario_ids: definition.scenario_ids,
        acceptance_criteria: definition.acceptance_criteria,
        consumes: definition.consumes,
        produces: definition.produces,
        allowed_paths: definition.allowed_paths,
      };
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

    const ancestors = new Map<string, Set<string>>();
    const collectAncestors = (taskId: string): Set<string> => {
      const cached = ancestors.get(taskId);
      if (cached) return cached;
      const result = new Set<string>();
      for (const dependency of tasks[taskId]?.dependencies ?? []) {
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

    const coveredRequirements = new Set<string>();
    const coveredScenarios = new Set<string>();
    for (const task of Object.values(tasks)) {
      for (const requirementId of task.requirement_ids) {
        if (!requirementScenarios.has(requirementId)) {
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
          throw new RockSpecError("TASK_SCENARIO_NOT_FOUND", `Task ${task.id} references an unknown Scenario`, {
            task_id: task.id,
            scenario_id: scenarioId,
          });
        }
        if (!task.requirement_ids.includes(owner)) {
          throw new RockSpecError(
            "TASK_SCENARIO_REQUIREMENT_MISMATCH",
            `Task ${task.id} must include Requirement ${owner} for Scenario ${scenarioId}`,
            { task_id: task.id, scenario_id: scenarioId, requirement_id: owner },
          );
        }
        coveredScenarios.add(scenarioId);
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
  }

  private async composeTaskBrief(
    changeDir: string,
    change: ChangeSnapshot,
    taskId: string,
  ): Promise<{ content: string; references: string[] }> {
    const references = ["proposal.md"];
    const specFiles = (await walkFiles(path.join(changeDir, "specs")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.relative(changeDir, file))
      .sort();
    references.push(...specFiles, "design.md", "plan.md", `tasks/${taskId}.md`);
    if (change.prototype.required) {
      await this.assertApprovalFresh(changeDir, change, "design");
      references.push("prototype/design-system.md", "prototype/prototype.md");
    }
    const sections: string[] = [];
    for (const reference of references) {
      const target = path.join(changeDir, reference);
      if (await exists(target)) sections.push(`<!-- source: ${reference} -->\n${await readFile(target, "utf8")}`);
    }
    return {
      content: `# ${taskId} Execution Brief\n\n${sections.join("\n\n")}`,
      references,
    };
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
    const outsideScope = changedPaths.filter((candidate) =>
      !task.allowed_paths.some((allowed) => allowed.endsWith("/")
        ? candidate.startsWith(allowed)
        : candidate === allowed),
    );
    if (outsideScope.length > 0) {
      throw new RockSpecError("TASK_SCOPE_VIOLATION", `Task ${task.id} changed files outside its approved scope`, {
        task_id: task.id,
        allowed_paths: task.allowed_paths,
        changed_paths: changedPaths,
        outside_scope: outsideScope,
      });
    }
  }

  private async writeReviewPackage(
    root: string,
    changeDir: string,
    kind: "task" | "delivery",
    baseCommit: string,
    headCommit: string,
    taskId?: string,
  ): Promise<ReviewPackageResult> {
    const diff = await git(root, ["diff", "--full-index", "--binary", "-U10", baseCommit, headCommit]);
    const subject = { base_commit: baseCommit, head_commit: headCommit, diff_hash: sha256(diff) };
    const [commits, stat] = await Promise.all([
      git(root, ["log", "--oneline", `${baseCommit}..${headCommit}`]),
      git(root, ["diff", "--stat", baseCommit, headCommit]),
    ]);
    const label = kind === "task" ? `task-${taskId}` : "delivery";
    const relativePath = `runtime/reviews/${label}-${baseCommit.slice(0, 7)}..${headCommit.slice(0, 7)}.diff`;
    const content = [
      `# Review package: ${baseCommit}..${headCommit}`,
      `# Diff hash: ${subject.diff_hash}`,
      "",
      "## Commits",
      commits,
      "",
      "## Files changed",
      stat,
      "",
      "## Diff",
      diff,
      "",
    ].join("\n");
    await atomicWrite(path.join(changeDir, relativePath), content);
    return {
      kind,
      ...(taskId ? { task_id: taskId } : {}),
      path: relativePath,
      subject,
    };
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

  private async assertPrototypeEvidence(root: string, change: ChangeSnapshot): Promise<void> {
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const evidence = [...change.evidence].reverse().find(
      (record) => record.exit_code === 0 && record.commit === commit && record.kind === "ui.prototype",
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
    const paths = output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((file) => file !== ".rockspec" && !file.startsWith(".rockspec/"));
    if (paths.length > 0) {
      throw new RockSpecError(
        "UNCOMMITTED_PRODUCT_CHANGES",
        "Acceptance and Delivery Review require product and test assets to be committed",
        { paths },
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
      "proposal.md": "# Proposal\n\n## Why\n\nTODO\n\n## What\n\nTODO\n",
      "specs/change/spec.md": specTemplate(change),
      "design.md": "---\nschema_version: 1\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Context\n\nTODO\n\n## Decisions\n\n### D-001\n\nTODO\n",
      "plan.md": "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n\n## Approach\n\nTODO\n\n## Task DAG\n\n- T-001\n",
      "tasks.md": "# Tasks\n\n- [ ] T-001\n",
      "tasks/T-001.md": taskTemplate("T-001"),
      "reviews/requirements-review.md": reviewTemplate("Requirements Review"),
      "reviews/readiness-review.md": reviewTemplate("Readiness Review"),
      "reviews/tasks/T-001-review.md": codeReviewTemplate("T-001 Task Review"),
      "reviews/delivery-review.md": codeReviewTemplate("Delivery Review"),
      "testing/test-plan.md": "# Acceptance Test Plan\n\nTODO\n",
      "testing/test-report.md": reviewTemplate("Acceptance Test Report"),
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
        this.writeTemplate(changeDir, "prototype/brief.md", "# Prototype Brief\n\nTODO\n"),
        this.writeTemplate(changeDir, "prototype/design-system.md", "# Design System\n\nTODO\n"),
        this.writeTemplate(changeDir, "prototype/prototype.md", "# Prototype\n\nTODO\n"),
      ]);
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

function reviewPaths(profile: WorkflowProfile, relativePath: string): string[] {
  if (profile !== "strict") return [relativePath];
  return [...strictReviewerPaths(relativePath), relativePath];
}

function strictReviewerPaths(relativePath: string): string[] {
  const suffix = relativePath.endsWith(".md") ? relativePath.slice(0, -3) : relativePath;
  return [`${suffix}-reviewer-1.md`, `${suffix}-reviewer-2.md`];
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
  "FINAL_REVIEW",
  "VERIFYING",
  "READY_TO_FINISH",
  "ARCHIVED",
] as const;

function stateAtLeast(changeState: ChangeSnapshot["state"], target: (typeof STATE_ORDER)[number]): boolean {
  const current = STATE_ORDER.indexOf(changeState as (typeof STATE_ORDER)[number]);
  return current >= STATE_ORDER.indexOf(target);
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

function briefTemplate(change: ChangeSnapshot): string {
  return `# ${change.title}\n\n## Scope\n\nTODO\n\n## Verification\n\nTODO\n`;
}

function specTemplate(change: ChangeSnapshot): string {
  return `# ${change.title}\n\n## ADDED Requirements\n\n### R-001 Requirement: TODO\n\nThe system MUST TODO.\n\n#### S-001 Scenario: TODO\n\n- GIVEN TODO\n- WHEN TODO\n- THEN TODO\n`;
}

function taskTemplate(id: string): string {
  return `---\nschema_version: 1\nid: ${id}\ntitle: TODO\ndependencies: []\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\nacceptance_criteria:\n  - TODO\nconsumes: []\nproduces: []\nallowed_paths:\n  - TODO\n---\n\n# ${id}\n\n## Goal\n\nTODO\n\n## Traceability\n\n- R-001\n- S-001\n- D-001\n\n## Acceptance Criteria\n\nTODO\n\n## Verification\n\nTODO\n`;
}

function reviewTemplate(title: string): string {
  return `# ${title}\n\nVerdict: BLOCKED\n\n## Findings\n\n- TODO\n`;
}

function codeReviewTemplate(title: string): string {
  return `---\nschema_version: 1\nverdict: BLOCKED\nreviewer_execution_id: TODO\nsubject:\n  base_commit: TODO\n  head_commit: TODO\n  diff_hash: TODO\nround: 0\nfindings: []\n---\n\n# ${title}\n\nVerdict: BLOCKED\n\n## Four-axis assessment\n\nTODO\n\n## Findings\n\nTODO\n`;
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
