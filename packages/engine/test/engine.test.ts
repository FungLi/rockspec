import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { RockSpecEngine, RockSpecError } from "../src/index.js";
import { summarizeRuntimeTelemetry, withFileLock } from "../src/storage.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rockspec-engine-")));
  repositories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@rockspec.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RockSpec Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: initial"], { cwd: root });
  return root;
}

async function replace(root: string, changeId: string, relativePath: string, content: string): Promise<void> {
  await writeFile(path.join(root, ".rockspec", "changes", changeId, relativePath), content);
}

async function writeImplementedReport(root: string, changeId: string, relativePath: string, body: string): Promise<void> {
  const current = await readFile(path.join(root, ".rockspec", "changes", changeId, relativePath), "utf8");
  const frontmatterEnd = current.indexOf("\n---\n", 4);
  if (!current.startsWith("---\n") || frontmatterEnd < 0) throw new Error(`Missing generated report metadata in ${relativePath}`);
  await replace(root, changeId, relativePath, `${current.slice(0, frontmatterEnd + 5)}\n# Implementer Report\n\n${body}\n`);
}

async function writeNoChangeKnowledgeDelta(root: string, changeId: string): Promise<void> {
  const authorExecutionId = await startExecution(root, changeId, "knowledge.evolve.author", "knowledge_author");
  await replace(
    root,
    changeId,
    "knowledge-delta.md",
    `---\nschema_version: 1\nchange_id: ${changeId}\nauthor_execution_id: ${authorExecutionId}\noutcome: no_change\nupdates: []\n---\n\n# Knowledge Delta\n\nNo reusable knowledge was introduced.\n`,
  );
}

async function writeKnowledgeReview(
  root: string,
  changeId: string,
  subject: {
    source_digest: string;
    delta_hash: string;
    baseline_hashes: Record<string, string | null>;
    candidate_hashes: Record<string, string>;
  },
): Promise<void> {
  const reviewerExecutionId = await startExecution(root, changeId, "knowledge.evolve.review", "knowledge_reviewer");
  const frontmatter = stringify({
    schema_version: 1,
    verdict: "PASS",
    reviewer_execution_id: reviewerExecutionId,
    subject,
    findings: [],
  }, { lineWidth: 0 }).trimEnd();
  await mkdir(path.join(root, ".rockspec", "changes", changeId, "reviews"), { recursive: true });
  await replace(
    root,
    changeId,
    "reviews/knowledge-review.md",
    `---\n${frontmatter}\n---\n\n# Knowledge Review\n\nThe proposed knowledge is reusable and traceable.\n`,
  );
}

async function approvedSpecHash(root: string, changeId: string): Promise<string> {
  const snapshot = parse(await readFile(
    path.join(root, ".rockspec", "changes", changeId, "change.yaml"),
    "utf8",
  )) as { approvals?: { spec?: { aggregate_hash?: string } } };
  const hash = snapshot.approvals?.spec?.aggregate_hash;
  if (!hash) throw new Error(`Missing Spec approval for ${changeId}`);
  return hash;
}

async function passReview(root: string, changeId: string, relativePath: string): Promise<void> {
  if (relativePath === "testing/test-report.md") {
    const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const reviewerExecutionId = await startExecution(root, changeId, "acceptance.validate", "acceptance_engineer");
    const snapshot = parse(await readFile(path.join(root, ".rockspec", "changes", changeId, "change.yaml"), "utf8")) as {
      evidence: Array<{ id: string; action_id?: string; scenario_ids?: string[] }>;
    };
    const evidenceId = [...snapshot.evidence].reverse().find((item) =>
      item.action_id === "acceptance.validate" && item.scenario_ids?.includes("S-001"))?.id ??
      `E-${String(snapshot.evidence.length + 1).padStart(3, "0")}`;
    await replace(
      root,
      changeId,
      relativePath,
      `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${reviewerExecutionId}\ncommit: ${commit}\nscenario_coverage:\n  - scenario_id: S-001\n    test_ids: [AT-001]\n    evidence_ids: [${evidenceId}]\nui_evidence: []\nfindings: []\n---\n\n# Acceptance Test Report\n\nVerdict: PASS\n`,
    );
    return;
  }
  if (relativePath.includes("requirements-review")) {
    const reviewerExecutionId = await startExecution(root, changeId, "requirements.review", "requirements_reviewer");
    await replace(root, changeId, relativePath, `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${reviewerExecutionId}\nfindings: []\n---\n\n# Review\n\nVerdict: PASS\n`);
    return;
  }
  if (relativePath.includes("readiness-review")) {
    const reviewerExecutionId = await startExecution(root, changeId, "readiness.review", "readiness_reviewer");
    await replace(root, changeId, relativePath, `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${reviewerExecutionId}\nfindings: []\n---\n\n# Review\n\nVerdict: PASS\n`);
    return;
  }
  await replace(root, changeId, relativePath, "# Review\n\nVerdict: PASS\n\nNo blocking findings.\n");
}

async function writeCodeReview(
  root: string,
  changeId: string,
  relativePath: string,
  subject: { base_commit: string; head_commit: string; diff_hash: string },
  verdict: "PASS" | "CHANGES_REQUIRED" = "PASS",
  reviewerExecutionId?: string,
): Promise<void> {
  const actualReviewerExecutionId = reviewerExecutionId ?? await startExecution(
    root,
    changeId,
    relativePath.includes("delivery") ? "delivery.review" : "task.review",
    relativePath.includes("delivery") ? "delivery_reviewer" : "task_reviewer",
  );
  await replace(
    root,
    changeId,
    relativePath,
    `---\nschema_version: 1\nverdict: ${verdict}\nreviewer_execution_id: ${actualReviewerExecutionId}\nsubject:\n  base_commit: ${subject.base_commit}\n  head_commit: ${subject.head_commit}\n  diff_hash: ${subject.diff_hash}\nround: 0\nscope_assessment: []\nfindings: []\n---\n\n# Review\n\nVerdict: ${verdict}\n\nNo blocking findings.\n`,
  );
}

async function startExecution(
  root: string,
  changeId: string,
  action: string,
  role: Parameters<RockSpecEngine["startExecution"]>[0]["role"],
): Promise<string> {
  let contextPackage: { contextPackagePath: string; contextPackageHash: string } | undefined;
  if (role === "task_reviewer" || role === "delivery_reviewer") {
    const reviewsRoot = path.join(root, ".rockspec", "changes", changeId, "runtime", "reviews");
    const prefix = role === "task_reviewer" ? "task-" : "delivery-";
    const candidates = (await readdir(reviewsRoot)).filter((file) => file.startsWith(prefix) && file.endsWith(".diff"));
    const ranked = await Promise.all(candidates.map(async (file) => ({ file, modified: (await stat(path.join(reviewsRoot, file))).mtimeMs })));
    const latest = ranked.sort((left, right) => right.modified - left.modified)[0];
    if (!latest) throw new Error(`Missing ${role} context package for ${changeId}`);
    const contextPackagePath = `runtime/reviews/${latest.file}`;
    const content = await readFile(path.join(reviewsRoot, latest.file));
    contextPackage = { contextPackagePath, contextPackageHash: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  }
  const result = await new RockSpecEngine({ cwd: root }).startExecution({ changeId, action, role, ...contextPackage });
  return result.started_execution.id;
}

async function bindExecutionInArtifact(
  root: string,
  changeId: string,
  relativePath: string,
  placeholder: string,
  action: string,
  role: Parameters<RockSpecEngine["startExecution"]>[0]["role"],
): Promise<string> {
  const executionId = await startExecution(root, changeId, action, role);
  const target = path.join(root, ".rockspec", "changes", changeId, relativePath);
  await replace(root, changeId, relativePath, (await readFile(target, "utf8")).replace(placeholder, executionId));
  return executionId;
}

async function approveGate(
  engine: RockSpecEngine,
  changeId: string,
  gate: "spec" | "design" | "implementation",
) {
  const approvalPackage = await engine.prepareApproval({ changeId, gate });
  return engine.approve({ changeId, gate, approvedBy: "tester", packageHash: approvalPackage.hash });
}

async function confirmUat(engine: RockSpecEngine, root: string, changeId: string): Promise<void> {
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await replace(
    root,
    changeId,
    "testing/uat-report.md",
    `---\nschema_version: 1\nverdict: CONFIRMED\nconfirmed_by: product-owner\ncommit: ${commit}\nscenario_ids: [S-001]\nnotes: The approved behavior works in the acceptance environment.\n---\n\n# User Acceptance\n\nConfirmed.\n`,
  );
  await engine.completeUat({ changeId });
}

async function writeReconciliationReview(
  root: string,
  changeId: string,
  prepared: {
    revision_id: string;
    gate: "spec" | "design" | "implementation";
    round: number;
    classifications: string[];
    finding_ids: string[];
    report_path: string;
    subject: { artifact_hashes: Record<string, string>; aggregate_hash: string };
  },
  reviewerExecutionId: string,
): Promise<string> {
  const snapshot = parse(await readFile(path.join(root, ".rockspec", "changes", changeId, "change.yaml"), "utf8")) as {
    execution: { registry: Array<{ id: string; role: string; action: string }> };
  };
  const expectedAction = `reconcile.${prepared.gate}`;
  const registered = snapshot.execution.registry.find((record) =>
    record.id === reviewerExecutionId && record.role === "reconciliation_reviewer" && record.action === expectedAction);
  const actualReviewerExecutionId = registered
    ? reviewerExecutionId
    : await startExecution(root, changeId, expectedAction, "reconciliation_reviewer");
  const frontmatter = stringify({
    schema_version: 1,
    revision_id: prepared.revision_id,
    gate: prepared.gate,
    round: prepared.round,
    verdict: "PASS",
    reviewer_execution_id: actualReviewerExecutionId,
    classifications: prepared.classifications,
    authority_delta: "unchanged",
    finding_ids: prepared.finding_ids,
    subject: prepared.subject,
    findings: [],
  }, { lineWidth: 0 }).trimEnd();
  await replace(
    root,
    changeId,
    prepared.report_path,
    `---\n${frontmatter}\n---\n\n# Reconciliation Review\n\nThe repaired artifacts remain inside the approved authority envelope.\n`,
  );
  return actualReviewerExecutionId;
}

async function writeFailedReconciliationReview(
  root: string,
  changeId: string,
  prepared: {
    revision_id: string;
    gate: "spec" | "design" | "implementation";
    round: number;
    classifications: string[];
    finding_ids: string[];
    report_path: string;
    subject: { artifact_hashes: Record<string, string>; aggregate_hash: string };
  },
  reviewerExecutionId: string,
): Promise<void> {
  const actualReviewerExecutionId = await startExecution(
    root,
    changeId,
    `reconcile.${prepared.gate}`,
    "reconciliation_reviewer",
  );
  const frontmatter = stringify({
    schema_version: 1,
    revision_id: prepared.revision_id,
    gate: prepared.gate,
    round: prepared.round,
    verdict: "CHANGES_REQUIRED",
    reviewer_execution_id: actualReviewerExecutionId,
    classifications: prepared.classifications,
    authority_delta: "unchanged",
    finding_ids: prepared.finding_ids,
    subject: prepared.subject,
    findings: [{
      id: "F-900",
      severity: "important",
      category: "reconciliation-gap",
      evidence: "design.md:1",
      description: "The derived correction is not yet complete.",
      owner_domain: "design",
      route_to: "design.technical",
      status: "open",
      classification: "consistency_fix",
      authority_impact: "unchanged",
    }],
  }, { lineWidth: 0 }).trimEnd();
  await replace(
    root,
    changeId,
    prepared.report_path,
    `---\n${frontmatter}\n---\n\n# Reconciliation Review\n\nThe derived correction needs another repair round.\n`,
  );
}

async function materializeRequirements(root: string, changeId: string): Promise<void> {
  await replace(
    root,
    changeId,
    "proposal.md",
    "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\n## Why\n\nUsers need this behavior.\n\n## What\n\nAdd the requested observable behavior.\n",
  );
  await replace(
    root,
    changeId,
    "specs/change/spec.md",
    "## ADDED Requirements\n\n### R-001 Requirement: Observable behavior\n\nThe system MUST provide the requested behavior.\n\n#### S-001 Scenario: Successful behavior\n\n- GIVEN a valid user context\n- WHEN the user requests the behavior\n- THEN the system returns the expected result\n",
  );
}

async function materializeDesign(root: string, changeId: string): Promise<void> {
  const specHash = await approvedSpecHash(root, changeId);
  await replace(
    root,
    changeId,
    "design.md",
    `---\nschema_version: 1\ninputs:\n  spec_hash: ${specHash}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Context\n\nImplement R-001 without changing unrelated contracts.\n\n## 全局约束\n\nNone.\n\n## 总体方案比较\n\nUse the existing boundary instead of creating a parallel stack.\n\n## Decisions\n\n${completeDecisionBody("D-001", "Existing module boundary", "Use the existing module boundary and verification stack.")}\n\n## 未解决风险\n\nNone.\n`,
  );
}

function completeDecisionBody(id: string, title: string, architecture: string): string {
  return `### ${id} ${title}\n\n#### 目标与覆盖范围\n\nCover the mapped Requirement and Scenario without broadening scope.\n\n#### 架构决策\n\n${architecture}\n\n#### 模块与职责\n\nKeep responsibility in the mapped module.\n\n#### 接口与数据流\n\nUse the existing public interface and preserve its data flow.\n\n#### 失败与边界行为\n\nReturn the existing deterministic failure behavior.\n\n#### 安全与隐私\n\nDo not log sensitive input.\n\n#### 兼容、迁移与回滚\n\nPreserve compatibility; rollback reverts the Task commit.\n\n#### 验证策略\n\nRun focused behavior and regression tests.\n\n#### 取舍与剩余风险\n\nPrefer the existing boundary; residual risk is None.`;
}

function taskDocument(input: {
  id: string;
  scenarioIds: string[];
  allowedPath: string;
  dependencies?: string[];
  supersedes?: string[];
  requirementIds?: string[];
  decisionIds?: string[];
  findingIds?: string[];
  adoptedCommit?: string;
  validationCommands?: string[];
  consumes?: string[];
  produces?: string[];
}): string {
  const list = (values: string[]): string => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  return `---\nschema_version: 1\nid: ${input.id}\ntitle: ${input.id} implementation\ndependencies: ${list(input.dependencies ?? [])}\nsupersedes: ${list(input.supersedes ?? [])}\nrequirement_ids: ${list(input.requirementIds ?? ["R-001"])}\nscenario_ids: ${list(input.scenarioIds)}\ndecision_ids: ${list(input.decisionIds ?? ["D-001"])}\nfinding_ids: ${list(input.findingIds ?? [])}\n${input.adoptedCommit ? `adopted_commit: ${input.adoptedCommit}\n` : ""}acceptance_criteria: [The mapped behavior is observable.]\nvalidation_commands: ${list(input.validationCommands ?? [])}\nconsumes: ${list(input.consumes ?? [])}\nproduces: ${list(input.produces ?? [])}\nallowed_paths: [${input.allowedPath}]\n---\n\n# ${input.id}\n\n## Goal\n\nImplement the mapped behavior.\n`;
}

async function materializePlan(root: string, changeId: string): Promise<void> {
  await replace(root, changeId, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n\n## Approach\n\nImplement and verify R-001.\n\n## Task DAG\n\n- T-001\n");
  await replace(root, changeId, "tasks.md", "# Tasks\n\n- [ ] T-001 Implement R-001\n");
  await replace(
    root,
    changeId,
    "tasks/T-001.md",
    taskDocument({ id: "T-001", scenarioIds: ["S-001"], allowedPath: "feature.txt" }),
  );
}

async function approveRequirements(engine: RockSpecEngine, root: string, id: string): Promise<void> {
  await materializeRequirements(root, id);
  await engine.completeAction({ changeId: id, action: "requirements.clarify" });
  await passReview(root, id, "reviews/requirements-review.md");
  await engine.completeAction({ changeId: id, action: "requirements.review" });
  await approveGate(engine, id, "spec");
}

async function makeReady(engine: RockSpecEngine, root: string, id: string): Promise<void> {
  await approveRequirements(engine, root, id);
  await materializeDesign(root, id);
  await finishReadiness(engine, root, id);
}

async function finishReadiness(engine: RockSpecEngine, root: string, id: string): Promise<void> {
  await engine.completeAction({ changeId: id, action: "design.technical" });
  await approveGate(engine, id, "design");
  await materializePlan(root, id);
  await engine.completeAction({ changeId: id, action: "plan.create" });
  await passReview(root, id, "reviews/readiness-review.md");
  await engine.completeAction({ changeId: id, action: "readiness.review" });
  await approveGate(engine, id, "implementation");
}

async function preparePlanning(engine: RockSpecEngine, root: string, id: string): Promise<void> {
  await approveRequirements(engine, root, id);
  await materializeDesign(root, id);
  await engine.completeAction({ changeId: id, action: "design.technical" });
  await approveGate(engine, id, "design");
}

describe("RockSpecEngine", () => {
  it("records governed Agent execution duration and outcome", async () => {
    const root = await repository();
    let current = new Date("2026-08-23T00:00:00.000Z");
    const engine = new RockSpecEngine({ cwd: root, now: () => current });
    await engine.init();
    await engine.newChange({ id: "measure-review-execution", profile: "standard" });
    const started = await engine.startExecution({
      changeId: "measure-review-execution",
      action: "requirements.review",
      role: "requirements_reviewer",
      modelTier: "balanced",
      hostModel: "test-model",
    });
    current = new Date("2026-08-23T00:02:03.456Z");
    const completed = await engine.completeExecution({
      changeId: "measure-review-execution",
      executionId: started.started_execution.id,
      outcome: "success",
    });

    expect(completed.completed_execution).toEqual({
      id: started.started_execution.id,
      outcome: "success",
      duration_ms: 123456,
      already_completed: false,
    });
    expect(completed.change.execution.registry[0]).toMatchObject({
      completed_at: "2026-08-23T00:02:03.456Z",
      outcome: "success",
      model_tier: "balanced",
      host_model: "test-model",
    });
    await expect(summarizeRuntimeTelemetry(root, "measure-review-execution")).resolves.toMatchObject({
      agent_executions: {
        total_count: 1,
        completed_count: 1,
        incomplete_count: 0,
        total_duration_ms: 123456,
        by_role: {
          requirements_reviewer: {
            count: 1,
            completed_count: 1,
            success_count: 1,
            duration_ms: 123456,
          },
        },
      },
    });
  });

  it("enforces execution slots, heartbeat expiry, and reap", async () => {
    const root = await repository();
    let current = new Date("2026-08-23T00:00:00.000Z");
    const engine = new RockSpecEngine({ cwd: root, now: () => current });
    await engine.init();
    const id = "execution-lifecycle-guards";
    await engine.newChange({ id, profile: "standard" });
    const started = await engine.startExecution({
      changeId: id,
      action: "requirements.review",
      role: "requirements_reviewer",
      slotKey: "requirements-review",
      timeoutMs: 1_000,
    });
    await expect(engine.startExecution({
      changeId: id,
      action: "requirements.review",
      role: "requirements_reviewer",
      slotKey: "requirements-review",
    })).rejects.toMatchObject({ code: "EXECUTION_SLOT_ACTIVE" });
    current = new Date("2026-08-23T00:00:02.000Z");
    await expect(engine.completeExecution({
      changeId: id,
      executionId: started.started_execution.id,
      outcome: "success",
    })).rejects.toMatchObject({ code: "EXECUTION_EXPIRED" });
    const reaped = await engine.reapExecutions({ changeId: id, now: "2026-08-23T00:00:02.000Z" });
    expect(reaped.change.execution.registry[0]).toMatchObject({
      outcome: "cancelled",
      timeout_reason: "deadline_exceeded",
    });
  });

  it("verifies execution context path/hash bindings and records their trust state", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "verify-context-package";
    await engine.newChange({ id, profile: "standard" });
    const contextPath = "runtime/requirements-context.md";
    const contextBody = "# Requirements review context\n";
    await replace(root, id, contextPath, contextBody);
    const contextHash = `sha256:${createHash("sha256").update(contextBody).digest("hex")}`;

    await expect(engine.startExecution({
      changeId: id,
      action: "requirements.review",
      role: "requirements_reviewer",
      contextPackagePath: contextPath,
    })).rejects.toMatchObject({ code: "CONTEXT_PACKAGE_BINDING_INCOMPLETE" });
    await expect(engine.startExecution({
      changeId: id,
      action: "requirements.review",
      role: "requirements_reviewer",
      contextPackagePath: contextPath,
      contextPackageHash: `sha256:${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "CONTEXT_PACKAGE_HASH_MISMATCH" });
    await expect(engine.startExecution({
      changeId: id,
      action: "requirements.review",
      role: "requirements_reviewer",
      contextPackagePath: "../outside.md",
      contextPackageHash: contextHash,
    })).rejects.toMatchObject({ code: "CONTEXT_PACKAGE_NOT_FOUND" });
    await expect(engine.startExecution({
      changeId: id,
      action: "task.review",
      role: "task_reviewer",
    })).rejects.toMatchObject({ code: "REVIEW_CONTEXT_REQUIRED" });
    await expect(engine.startExecution({
      changeId: id,
      action: "task.review",
      role: "task_reviewer",
      contextPackagePath: contextPath,
      contextPackageHash: contextHash,
    })).rejects.toMatchObject({ code: "CONTEXT_PACKAGE_ROLE_MISMATCH" });

    const started = await engine.startExecution({
      changeId: id,
      action: "requirements.review",
      role: "requirements_reviewer",
      contextPackagePath: contextPath,
      contextPackageHash: contextHash,
    });
    expect(started.change.execution.registry.at(-1)).toMatchObject({
      id: started.started_execution.id,
      context_package_path: contextPath,
      context_package_hash: contextHash,
      context_package_verified: true,
    });
  });

  it("dry-runs one formal artifact and returns field-level schema guidance", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "validate-one-artifact";
    await engine.newChange({ id, profile: "standard" });
    await replace(
      root,
      id,
      "proposal.md",
      "---\nschema_version: 1\nnon_goals: []\nassumptions:\n  - unclear assumption\nopen_questions: []\n---\n\n# Proposal\n",
    );

    const result = await engine.validate({ changeId: id, artifactPath: "proposal.md" });
    expect(result).toMatchObject({
      valid: false,
      artifact: "proposal.md",
      errors: [expect.objectContaining({
        code: "invalid_type",
        paths: ["proposal.md", "assumptions", "0"],
        expected: "object",
      })],
    });
  });

  it("initializes at the Git root and runs the Lite lifecycle", async () => {
    const root = await repository();
    const visibleRoot = root.startsWith("/private/var/") ? root.slice("/private".length) : root;
    const child = path.join(visibleRoot, "apps", "web");
    await mkdir(child, { recursive: true });
    const engine = new RockSpecEngine({ cwd: child });

    const initialized = await engine.init();
    expect(initialized.repository_root).toBe(root);
    const created = await engine.newChange({ id: "rename-submit-button", profile: "lite", kind: "copy" });
    expect(created.current_state).toBe("SCOPING");
    expect(created.recommended_next?.action).toBe("change.triage");
    await expect(readFile(path.join(root, ".rockspec", "changes", "rename-submit-button", "proposal.md")))
      .rejects.toThrow();
    await expect(
      engine.completeAction({ changeId: "rename-submit-button", action: "change.triage" }),
    ).rejects.toMatchObject({ code: "UNRESOLVED_PLACEHOLDER" });

    await replace(
      root,
      "rename-submit-button",
      "brief.md",
      "# Rename submit button\n\n## Scope\n\nRename only the visible button label.\n\n## Verification\n\nRun the focused UI test.\n",
    );
    await engine.completeAction({ changeId: "rename-submit-button", action: "change.triage" });
    await engine.runCheck({
      changeId: "rename-submit-button",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const verified = await engine.verify({ changeId: "rename-submit-button" });
    expect(verified.current_state).toBe("READY_TO_FINISH");
    const events = await readFile(
      path.join(root, ".rockspec", "changes", "rename-submit-button", "events.ndjson"),
      "utf8",
    );
    expect(events.trim().split("\n")).toHaveLength(4);
  });

  it("creates the Standard artifact set and invalidates changed approvals", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const created = await engine.newChange({ id: "add-profile-export", profile: "standard" });
    expect(created.current_state).toBe("SCOPING");
    await expect(readFile(path.join(root, ".rockspec", "changes", "add-profile-export", "design.md"), "utf8"))
      .resolves.toContain("# 技术设计");
    await expect(readFile(path.join(root, ".rockspec", "changes", "add-profile-export", "design.md"), "utf8"))
      .resolves.toContain("## 全局约束");
    await expect(readFile(path.join(root, ".rockspec", "changes", "add-profile-export", "plan.md"), "utf8"))
      .resolves.toContain("## 全局约束");

    await approveRequirements(engine, root, "add-profile-export");
    await replace(
      root,
      "add-profile-export",
      "specs/change/spec.md",
      "## ADDED Requirements\n\n### R-001 Requirement: export\nThe system MUST export.\n",
    );
    const status = await engine.getStatus({ changeId: "add-profile-export" });
    expect(status.blocked_by.some((blocker) => blocker.code === "STALE_APPROVAL")).toBe(true);
    expect(status.recommended_next).toMatchObject({ action: "revise", entry_skill: "rockspec-change" });
    expect(status.allowed_actions).not.toContain("approve.spec");
    await expect(
      engine.completeAction({ changeId: "add-profile-export", action: "design.technical" }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
  });

  it("blocks Design completion when a Decision misses an approved Scenario", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "add-design-coverage-gate";
    await engine.newChange({ id, profile: "standard" });
    await approveRequirements(engine, root, id);
    const specHash = await approvedSpecHash(root, id);
    await replace(
      root,
      id,
      "design.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${specHash}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: []\n---\n\n# Technical Design\n\n## Decisions\n\n### D-001\n\nImplement only part of the approved behavior.\n`,
    );

    await expect(engine.completeAction({ changeId: id, action: "design.technical" }))
      .rejects.toMatchObject({
        code: "DESIGN_COVERAGE_GAP",
        details: { scenario_ids: ["S-001"] },
      });
    await replace(
      root,
      id,
      "design.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: sha256:${"0".repeat(64)}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Decisions\n\n### D-001\n\nUse stale input.\n`,
    );
    await expect(engine.completeAction({ changeId: id, action: "design.technical" }))
      .rejects.toMatchObject({ code: "DESIGN_INPUT_STALE" });
  });

  it("builds Chinese Gate summaries over formal artifacts without creating preview documents", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    const id = "approval-review-summary";
    await engine.init();
    await engine.newChange({ id, profile: "standard" });

    await materializeRequirements(root, id);
    await engine.completeAction({ changeId: id, action: "requirements.clarify" });
    await passReview(root, id, "reviews/requirements-review.md");
    await engine.completeAction({ changeId: id, action: "requirements.review" });
    const specPackage = await engine.prepareApproval({ changeId: id, gate: "spec" });
    expect(specPackage.review_summary).toMatchObject({
      language: "zh-CN",
      title: "需求审批",
      approval_prompt: expect.stringContaining("批准需求"),
      artifact_root: `.rockspec/changes/${id}`,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          label: "需求提案",
          path: `.rockspec/changes/${id}/proposal.md`,
          relative_path: "proposal.md",
          description: expect.stringContaining("需求背景"),
        }),
        expect.objectContaining({
          label: "需求评审",
          path: `.rockspec/changes/${id}/reviews/requirements-review.md`,
          relative_path: "reviews/requirements-review.md",
          description: expect.stringContaining("独立需求评审"),
        }),
      ]),
    });
    expect(specPackage.review_summary.sections.flatMap((section) => section.items).join("\n"))
      .toContain("R-001 Observable behavior");
    await engine.approve({ changeId: id, gate: "spec", packageHash: specPackage.hash });

    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });
    const designPackage = await engine.prepareApproval({ changeId: id, gate: "design" });
    expect(designPackage.review_summary).toMatchObject({
      title: "设计审批",
      approval_prompt: expect.stringContaining("批准设计"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          label: "技术设计",
          path: `.rockspec/changes/${id}/design.md`,
          relative_path: "design.md",
          description: expect.stringContaining("架构决策"),
        }),
      ]),
    });
    expect(designPackage.review_summary.sections.flatMap((section) => section.items).join("\n"))
      .toContain("D-001 Existing module boundary");
    expect(designPackage.review_summary.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "审阅问题" }),
      expect.objectContaining({ title: "变更范围与约束" }),
      expect.objectContaining({ title: "核心设计决策" }),
      expect.objectContaining({ title: "兼容、回滚与验证" }),
      expect.objectContaining({ title: "待用户决定", items: ["无"] }),
    ]));
    expect(designPackage.review_summary.sections.flatMap((section) => section.items).join("\n"))
      .toMatch(/决定：.*理由：.*影响：/s);
    await engine.approve({ changeId: id, gate: "design", packageHash: designPackage.hash });

    await materializePlan(root, id);
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });
    const implementationPackage = await engine.prepareApproval({ changeId: id, gate: "implementation" });
    expect(implementationPackage.review_summary).toMatchObject({
      title: "实施审批",
      approval_prompt: expect.stringContaining("批准实施"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ label: "实施计划", relative_path: "plan.md", description: expect.stringContaining("Task DAG") }),
        expect.objectContaining({ label: "任务 T-001", relative_path: "tasks/T-001.md", description: expect.stringContaining("单个 Task") }),
        expect.objectContaining({ label: "就绪评审", relative_path: "reviews/readiness-review.md", description: expect.stringContaining("实施就绪度") }),
      ]),
    });
    expect(implementationPackage.review_summary.sections.flatMap((section) => section.items).join("\n"))
      .toContain("T-001 <- 无前置任务");
    expect(await readdir(path.join(root, ".rockspec", "changes", id, "runtime", "approvals")))
      .toEqual(expect.not.arrayContaining([expect.stringMatching(/preview\.md$/)]));
  });

  it("never uses automatic reconciliation for a Gate without a human authority baseline", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "require-first-design-approval";
    await engine.newChange({ id, profile: "standard" });
    await approveRequirements(engine, root, id);
    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });

    const revised = await engine.revise({
      changeId: id,
      source: "design.technical",
      target: "design",
      reason: "Synchronize a derived design detail without changing the approved decision",
      affectedIds: ["D-001"],
      classification: "consistency_fix",
      authorityDelta: "unchanged",
      authorExecutionId: "design-revision-author",
    });
    expect(revised.change.revisions[0]).toMatchObject({
      approval_policy: "auto",
      authority_baselines: {},
      invalidated_approvals: [],
    });

    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });
    expect((await engine.getStatus({ changeId: id })).recommended_next).toMatchObject({
      action: "approve.design",
    });
    await expect(engine.prepareReconciliation({ changeId: id, gate: "design" }))
      .rejects.toMatchObject({ code: "FIRST_APPROVAL_REQUIRES_USER" });

    const approved = await approveGate(engine, id, "design");
    expect(approved.change.approvals.design).toMatchObject({
      mode: "human",
      approved_by: "tester",
    });
  });

  it("escalates automatic reconciliation to human approval after two failed rounds", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "escalate-reconciliation-timeout";
    await engine.newChange({ id, profile: "standard" });
    await preparePlanning(engine, root, id);

    await engine.revise({
      changeId: id,
      source: "design.technical",
      target: "design",
      reason: "Synchronize a derived design detail without changing the approved decision",
      affectedIds: ["D-001"],
      classification: "consistency_fix",
      authorityDelta: "unchanged",
      authorExecutionId: "design-revision-author",
    });
    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });

    const roundOne = await engine.prepareReconciliation({ changeId: id, gate: "design" });
    await writeFailedReconciliationReview(root, id, roundOne, "design-reconciliation-reviewer-1");
    const firstFailure = await engine.completeReconciliation({ changeId: id, gate: "design" });
    expect(firstFailure.change.revisions[0]).toMatchObject({
      approval_policy: "auto",
      convergence_round: 2,
    });
    expect(firstFailure.recommended_next?.action).toBe("design.technical");

    await engine.completeAction({ changeId: id, action: "design.technical" });
    const roundTwo = await engine.prepareReconciliation({ changeId: id, gate: "design" });
    expect(roundTwo.round).toBe(2);
    await writeFailedReconciliationReview(root, id, roundTwo, "design-reconciliation-reviewer-2");
    const secondFailure = await engine.completeReconciliation({ changeId: id, gate: "design" });
    expect(secondFailure.change.revisions[0]).toMatchObject({
      approval_policy: "human",
      convergence_round: 2,
      escalation_reason: "Reconciliation did not converge within 2 rounds",
    });
    await expect(engine.prepareReconciliation({ changeId: id, gate: "design" }))
      .rejects.toMatchObject({ code: "HUMAN_APPROVAL_REQUIRED" });

    const approved = await approveGate(engine, id, "design");
    expect(approved.change.approvals.design).toMatchObject({ mode: "human" });
    expect(approved.change.revisions[0]?.status).toBe("reconciled");
  });

  it("revises Requirements from Design and reconciles every invalidated downstream artifact", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "simplify-expensive-export";
    await engine.newChange({ id, profile: "standard" });
    await preparePlanning(engine, root, id);
    await materializePlan(root, id);
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });

    const revised = await engine.revise({
      changeId: id,
      source: "design.technical",
      target: "requirements",
      reason: "R-001 is too expensive and must expose a narrower behavior",
      affectedIds: ["R-001", "S-001", "D-001"],
    });
    expect(revised.current_state).toBe("SCOPING");
    expect(revised.recommended_next).toMatchObject({
      action: "requirements.clarify",
      entry_skill: "rockspec-requirements",
    });
    expect(revised.change.approvals).toEqual({});
    expect(revised.change.reviews.requirements).toBeUndefined();
    expect(revised.change.reviews.readiness).toBeUndefined();
    expect(revised.change.tasks).toEqual({});
    expect(revised.change.revisions[0]).toMatchObject({
      id: "RV-001",
      status: "open",
      target: "requirements",
      classifications: ["decision_change"],
      authority_delta: "unknown",
      approval_policy: "human",
      affected_ids: ["D-001", "R-001", "S-001"],
      invalidated_approvals: ["spec", "design"],
      invalidated_actions: expect.arrayContaining(["requirements.clarify", "design.technical", "plan.create"]),
    });
    await expect(readFile(path.join(root, ".rockspec", "changes", id, "design.md"), "utf8"))
      .resolves.toContain("D-001");
    await expect(readFile(
      path.join(root, ".rockspec", "changes", id, "revisions", "RV-001", "before", "tasks", "T-001.md"),
      "utf8",
    )).resolves.toContain("T-001");
    await expect(readFile(path.join(root, ".rockspec", "changes", id, "tasks", "T-001.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    await materializeRequirements(root, id);
    await engine.completeAction({ changeId: id, action: "requirements.clarify" });
    await passReview(root, id, "reviews/requirements-review.md");
    await engine.completeAction({ changeId: id, action: "requirements.review" });
    await approveGate(engine, id, "spec");
    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });
    const designApproved = await approveGate(engine, id, "design");
    expect(designApproved.change.revisions[0]?.status).toBe("open");

    await materializePlan(root, id);
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });
    const reconciled = await approveGate(engine, id, "implementation");
    expect(reconciled.change.revisions[0]).toMatchObject({ status: "reconciled" });
    expect(reconciled.change.revisions[0]?.after_hashes).toMatchObject({
      "proposal.md": expect.stringMatching(/^sha256:/),
      specs: expect.stringMatching(/^sha256:/),
      "design.md": expect.stringMatching(/^sha256:/),
      "plan.md": expect.stringMatching(/^sha256:/),
    });
    expect(parse(await readFile(
      path.join(root, ".rockspec", "changes", id, "revisions", "RV-001.yaml"),
      "utf8",
    ))).toMatchObject({ status: "reconciled" });
  });

  it("opens a Finding-bound Design recovery during implementation and resumes the suspended Task", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "recover-active-task-design";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);
    const started = await engine.startTask({ changeId: id, taskId: "T-001" });
    const originalBase = started.change.tasks["T-001"]?.base_commit;
    const originalDesignAuthority = started.change.approvals.design?.authority_basis_hash;
    const originalImplementationAuthority = started.change.approvals.implementation?.authority_basis_hash;
    await writeFile(path.join(root, "feature.txt"), "implementation needing a design correction\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-001] implement behavior"], { cwd: root });
    await writeImplementedReport(
      root,
      id,
      "runtime/tasks/T-001/implementer-report.md",
      "Implemented the frozen Task and recorded focused evidence.",
    );
    await engine.runCheck({
      changeId: id,
      taskId: "T-001",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const reviewPackage = await engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-001" });
    await replace(
      root,
      id,
      "reviews/tasks/T-001-review.md",
      `---\nschema_version: 1\nverdict: BLOCKED\nreviewer_execution_id: design-gap-reviewer\nsubject:\n  base_commit: ${reviewPackage.subject.base_commit}\n  head_commit: ${reviewPackage.subject.head_commit}\n  diff_hash: ${reviewPackage.subject.diff_hash}\nround: 0\nfindings:\n  - id: F-001\n    severity: important\n    category: design-compliance\n    evidence: design.md:1\n    description: The approved component boundary is incomplete.\n    owner_domain: design\n    route_to: design.technical\n    status: open\n    classification: derived_gap\n    authority_impact: unchanged\n  - id: F-002\n    severity: important\n    category: implementation-quality\n    evidence: feature.txt:1\n    description: The current implementation also needs a focused correction.\n    owner_domain: implementation\n    route_to: task.execute\n    status: open\n    classification: implementation_fix\n    authority_impact: unchanged\n---\n\n# Review\n\nVerdict: BLOCKED\n`,
    );
    await bindExecutionInArtifact(root, id, "reviews/tasks/T-001-review.md", "design-gap-reviewer", "task.review", "task_reviewer");
    const blocked = await engine.completeAction({ changeId: id, action: "task.review", verdict: "BLOCKED" });
    expect(blocked.recommended_next?.action).toBe("revise");
    expect(blocked.recovery).toEqual({
      kind: "revision",
      review_id: "task:T-001",
      source: "task.review",
      finding_ids: ["F-001", "F-002"],
      route_to: ["design.technical", "task.execute"],
      target: "design",
      revision_kind: "upstream",
      classifications: ["derived_gap", "implementation_fix"],
      authority_delta: "unchanged",
      approval_policy: "auto",
    });
    expect(blocked.blocked_by).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FINDING_RECOVERY_REQUIRED" }),
    ]));

    await expect(engine.revise({
      changeId: id,
      reason: "The Task Review exposed an approved Design gap",
      affectedIds: ["D-001"],
      authorExecutionId: "recovery-author",
    })).rejects.toMatchObject({ code: "RECOVERY_TRIGGER_MISMATCH" });

    const revised = await engine.applyRecovery({
      changeId: id,
      affectedIds: ["D-001"],
      authorExecutionId: "recovery-author",
    });
    expect(revised.current_state).toBe("SPEC_APPROVED");
    expect(revised.change.approvals.spec).toBeDefined();
    expect(revised.change.approvals.design).toBeUndefined();
    expect(revised.change.tasks["T-001"]).toMatchObject({
      status: "suspended",
      review_attempts: 0,
      attempts: [expect.objectContaining({
        status: "suspended",
        revision_id: "RV-001",
        base_commit: originalBase,
      })],
    });
    expect(revised.change.execution).toMatchObject({ active_task: null, active_execution: null, registry: expect.any(Array) });
    expect(revised.change.reviews["task:T-001"]).toBeUndefined();
    expect(revised.change.revisions[0]?.reason).toContain("F-001: The approved component boundary is incomplete.");
    await expect(readFile(
      path.join(root, ".rockspec", "changes", id, "revisions", "RV-001", "before", "reviews", "tasks", "T-001-review.md"),
      "utf8",
    )).resolves.toContain("F-002");

    await materializeDesign(root, id);
    const designed = await engine.completeAction({ changeId: id, action: "design.technical" });
    expect(designed.recommended_next?.action).toBe("reconcile.design");
    const designPackage = await engine.prepareReconciliation({ changeId: id, gate: "design" });
    const registeredReviewer = await writeReconciliationReview(root, id, designPackage, "recovery-author");
    const reconciliationPath = path.join(root, ".rockspec", "changes", id, designPackage.report_path);
    await replace(
      root,
      id,
      designPackage.report_path,
      (await readFile(reconciliationPath, "utf8")).replace(registeredReviewer, "recovery-author"),
    );
    await expect(engine.completeReconciliation({ changeId: id, gate: "design" }))
      .rejects.toMatchObject({ code: "EXECUTION_NOT_REGISTERED" });
    await writeReconciliationReview(root, id, designPackage, "design-reconciliation-reviewer");
    const designReconciled = await engine.completeReconciliation({ changeId: id, gate: "design" });
    expect(designReconciled.current_state).toBe("DESIGN_APPROVED");
    expect(designReconciled.change.approvals.design).toMatchObject({
      mode: "auto",
      revision_id: "RV-001",
      authority_basis_hash: originalDesignAuthority,
    });
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await passReview(root, id, "reviews/readiness-review.md");
    const readiness = await engine.completeAction({ changeId: id, action: "readiness.review" });
    expect(readiness.recommended_next?.action).toBe("reconcile.implementation");
    const implementationPackage = await engine.prepareReconciliation({ changeId: id, gate: "implementation" });
    await writeReconciliationReview(root, id, implementationPackage, "implementation-reconciliation-reviewer");
    const ready = await engine.completeReconciliation({ changeId: id, gate: "implementation" });
    expect(ready.current_state).toBe("READY");
    expect(ready.change.approvals.implementation).toMatchObject({
      mode: "auto",
      revision_id: "RV-001",
      authority_basis_hash: originalImplementationAuthority,
    });
    expect(ready.change.revisions[0]).toMatchObject({
      status: "reconciled",
      approval_policy: "auto",
      authority_delta: "unchanged",
      auto_approvals: [
        expect.objectContaining({ gate: "design", reviewer_execution_id: expect.any(String) }),
        expect.objectContaining({ gate: "implementation", reviewer_execution_id: expect.any(String) }),
      ],
    });
    const resumed = await engine.startTask({ changeId: id, taskId: "T-001" });
    expect(resumed.change.tasks["T-001"]).toMatchObject({
      status: "in_progress",
      base_commit: originalBase,
      review_attempts: 0,
    });
    expect(resumed.change.tasks["T-001"]?.execution_id).not.toBe(started.change.tasks["T-001"]?.execution_id);
  }, 30_000);

  it("commits a suspended Task supersession and schedules its replacement", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "replace-suspended-task";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);
    const status = await engine.getStatus({ changeId: id });
    const replacement = status.change.tasks["T-001"]!;
    replacement.supersedes = ["T-999"];
    const suspendedAt = "2026-08-14T10:00:00Z";
    status.change.tasks["T-999"] = {
      ...structuredClone(replacement),
      id: "T-999",
      title: "Frozen implementation baseline",
      status: "suspended",
      supersedes: [],
      attempts: [{
        execution_id: "suspended-execution",
        status: "suspended",
        revision_id: "RV-001",
        base_commit: status.change.base_commit!,
        head_commit: status.change.base_commit!,
        brief_path: "revisions/RV-001/before/runtime/tasks/T-999/brief.md",
        brief_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        report_path: "revisions/RV-001/before/runtime/tasks/T-999/implementer-report.md",
        review_attempts: 0,
        suspended_at: suspendedAt,
      }],
    };
    const applyResolutions = Reflect.get(engine, "applyTaskRecoveryResolutions") as (
      change: typeof status.change,
      revision: { id: string; mode: "implementation_recovery" },
    ) => void;
    applyResolutions.call(engine, status.change, { id: "RV-001", mode: "implementation_recovery" });
    expect(status.change.tasks["T-999"]).toMatchObject({
      status: "superseded",
      superseded_by: "T-001",
      superseded_in_revision: "RV-001",
      attempts: [expect.objectContaining({ status: "superseded" })],
    });
    await replace(root, id, "change.yaml", stringify(status.change, { lineWidth: 0 }));
    await mkdir(path.join(root, ".agents", "skills", "project-skill"), { recursive: true });
    await writeFile(path.join(root, ".agents", "skills", "project-skill", "SKILL.md"), "# Project Skill\n");
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await writeFile(path.join(root, ".codex", "config.toml"), "# Host config\n");
    expect((await engine.nextTask({ changeId: id }))?.id).toBe("T-001");
    const started = await engine.startTask({ changeId: id, taskId: "T-001" });
    expect(started.change.tasks["T-001"]?.status).toBe("in_progress");
    const brief = await readFile(path.join(root, ".rockspec", "changes", id, started.change.tasks["T-001"]!.brief_path!), "utf8");
    expect(brief).toContain("### T-999");
    expect(brief).toContain("Relationship: Inherited Suspended Baseline");
    expect(brief).toContain(`Attempt Base: ${status.change.base_commit}`);
    expect(brief).toContain("Archived Brief: revisions/RV-001/before/runtime/tasks/T-999/brief.md");
    expect(brief).toContain("Archived Report: revisions/RV-001/before/runtime/tasks/T-999/implementer-report.md");
  }, 30_000);

  it("preserves a completed historical replacement during a later implementation recovery", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "preserve-historical-replacement";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);
    const status = await engine.getStatus({ changeId: id });
    const replacement = status.change.tasks["T-001"]!;
    replacement.status = "completed";
    replacement.supersedes = ["T-004"];
    replacement.finding_ids = ["F-101"];
    replacement.commit_sha = status.change.base_commit!;
    replacement.completed_at = "2026-08-14T10:00:00Z";
    status.change.tasks["T-004"] = {
      ...structuredClone(replacement),
      id: "T-004",
      title: "T-004 implementation",
      status: "superseded",
      supersedes: [],
      finding_ids: [],
      attempts: [],
      superseded_by: "T-001",
      superseded_in_revision: "RV-001",
      superseded_at: "2026-08-14T09:00:00Z",
    };
    delete status.change.tasks["T-004"]!.completed_at;
    status.change.revisions.push({
      id: "RV-002",
      source: "acceptance.validate",
      target: "plan",
      mode: "implementation_recovery",
      kind: "remediation",
      status: "open",
      reason: "A later acceptance finding requires a new remediation Task.",
      affected_ids: ["R-001", "S-001"],
      classifications: ["implementation_fix"],
      approval_policy: "auto",
      gate_policies: { spec: "preserve", design: "preserve", implementation: "auto" },
      authority_delta: "unchanged",
      author_execution_id: "rv-002-author",
      authority_baselines: {},
      convergence_round: 1,
      auto_approvals: [],
      trigger: {
        review_id: "acceptance",
        finding_ids: ["F-201"],
        review_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      amendments: [],
      before_hashes: {},
      after_hashes: {},
      invalidated_approvals: ["implementation"],
      invalidated_reviews: ["acceptance"],
      invalidated_actions: ["plan.create"],
      started_at: "2026-08-15T10:00:00Z",
    });
    await replace(
      root,
      id,
      "tasks/T-001.md",
      taskDocument({
        id: "T-001",
        scenarioIds: ["S-001"],
        allowedPath: "feature.txt",
        supersedes: ["T-004"],
        findingIds: ["F-101"],
      }),
    );
    await replace(
      root,
      id,
      "tasks/T-004.md",
      taskDocument({ id: "T-004", scenarioIds: ["S-001"], allowedPath: "feature.txt" }),
    );
    await replace(
      root,
      id,
      "tasks/T-007.md",
      taskDocument({
        id: "T-007",
        scenarioIds: ["S-001"],
        allowedPath: "remediation.txt",
        dependencies: ["T-001"],
        findingIds: ["F-201"],
      }),
    );

    const syncTasks = Reflect.get(engine, "syncTasks") as (
      changeDir: string,
      change: typeof status.change,
    ) => Promise<void>;
    await expect(syncTasks.call(
      engine,
      path.join(root, ".rockspec", "changes", id),
      status.change,
    )).resolves.toBeUndefined();
    expect(status.change.tasks["T-001"]).toMatchObject({
      status: "completed",
      supersedes: ["T-004"],
      finding_ids: ["F-101"],
    });
    expect(status.change.tasks["T-004"]).toMatchObject({
      status: "superseded",
      superseded_by: "T-001",
      superseded_in_revision: "RV-001",
    });
    expect(status.change.tasks["T-007"]).toMatchObject({
      status: "pending",
      finding_ids: ["F-201"],
    });
  }, 30_000);

  it("preserves historical supersedes when a feedback reopen resynchronizes the Plan", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "feedback-historical-supersedes";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);

    const created = await engine.getStatus({ changeId: id });
    const baseCommit = created.change.base_commit;
    if (!baseCommit) throw new Error("Expected a base commit");
    const snapshotPath = path.join(root, ".rockspec", "changes", id, "change.yaml");
    const snapshot = parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.state = "READY_TO_FINISH";
    snapshot.verification = { status: "passed", commit: baseCommit, verified_at: new Date().toISOString() };
    snapshot.delivery_head = baseCommit;
    await writeFile(snapshotPath, stringify(snapshot));

    await engine.submitFeedback({
      changeId: id,
      route: "same_change",
      interactionMode: "compact",
      reason: "Acceptance requests a bounded Composer adjustment.",
      items: ["Keep the existing send behavior while simplifying the Composer."],
      target: "requirements",
      affectedIds: ["R-001"],
    });

    const status = await engine.getStatus({ changeId: id });
    const replacement = status.change.tasks["T-001"];
    if (!replacement) throw new Error("Expected the materialized Task T-001");
    replacement.status = "completed";
    replacement.commit_sha = baseCommit;
    replacement.completed_at = "2026-08-22T10:00:00Z";
    replacement.supersedes = ["T-004"];
    replacement.requirement_ids = ["R-005"];
    replacement.scenario_ids = ["S-005"];
    const historical = {
      ...structuredClone(replacement),
      id: "T-004",
      title: "T-004 implementation",
      status: "superseded" as const,
      supersedes: [],
      requirement_ids: ["R-005"],
      scenario_ids: ["S-005"],
      finding_ids: [],
      attempts: [],
      superseded_by: "T-001",
      superseded_in_revision: "RV-000",
      superseded_at: "2026-08-21T10:00:00Z",
    };
    delete historical.completed_at;
    status.change.tasks["T-004"] = historical;

    const taskOne = await readFile(path.join(root, ".rockspec", "changes", id, "tasks", "T-001.md"), "utf8");
    await writeFile(
      path.join(root, ".rockspec", "changes", id, "tasks", "T-001.md"),
      taskOne
        .replace("supersedes: []", "supersedes: [T-004]")
        .replace('requirement_ids: ["R-001"]', 'requirement_ids: ["R-005"]')
        .replace('scenario_ids: ["S-001"]', 'scenario_ids: ["S-005"]'),
    );
    await replace(root, id, "tasks/T-004.md", taskDocument({ id: "T-004", requirementIds: ["R-005"], scenarioIds: ["S-005"], allowedPath: "feature.txt" }));
    await replace(root, id, "tasks/T-002.md", taskDocument({ id: "T-002", scenarioIds: ["S-001"], allowedPath: "feature.txt" }));

    const syncTasks = Reflect.get(engine, "syncTasks") as (
      changeDir: string,
      change: typeof status.change,
    ) => Promise<void>;
    await expect(syncTasks.call(
      engine,
      path.join(root, ".rockspec", "changes", id),
      status.change,
    )).resolves.toBeUndefined();
    expect(status.change.tasks["T-001"]).toMatchObject({ status: "completed", supersedes: ["T-004"] });
    expect(status.change.tasks["T-004"]).toMatchObject({ status: "superseded", superseded_by: "T-001" });
  }, 30_000);

  it("preserves Stage Review Findings and amends the active Revision instead of opening another", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "amend-readiness-recovery";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);

    await engine.revise({
      changeId: id,
      source: "readiness.review",
      target: "design",
      reason: "The approved Design needs a controlled correction",
      affectedIds: ["D-001"],
    });
    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });
    await approveGate(engine, id, "design");
    await materializePlan(root, id);
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await replace(
      root,
      id,
      "design.md",
      `${await readFile(path.join(root, ".rockspec", "changes", id, "design.md"), "utf8")}\nDirect correction discovered during recovery.\n`,
    );
    await replace(
      root,
      id,
      "reviews/readiness-review.md",
      `---\nschema_version: 1\nverdict: CHANGES_REQUIRED\nreviewer_execution_id: readiness-reviewer-rv001\nfindings:\n  - id: F-101\n    severity: critical\n    category: design-compliance\n    evidence: design.md:20\n    description: The corrected Design still lacks a required boundary decision.\n    owner_domain: design\n    route_to: design.technical\n    status: open\n    classification: decision_change\n    authority_impact: changed\n  - id: F-102\n    severity: important\n    category: plan-coverage\n    evidence: tasks/T-001.md:1\n    description: The Task brief does not cover the new Design boundary.\n    owner_domain: planning\n    route_to: plan.create\n    status: open\n    classification: derived_gap\n    authority_impact: unchanged\n---\n\n# Readiness Review\n\nVerdict: CHANGES_REQUIRED\n`,
    );
    await bindExecutionInArtifact(root, id, "reviews/readiness-review.md", "readiness-reviewer-rv001", "readiness.review", "readiness_reviewer");
    const reviewed = await engine.completeAction({
      changeId: id,
      action: "readiness.review",
      verdict: "CHANGES_REQUIRED",
    });
    expect(reviewed.blocked_by).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STALE_APPROVAL", paths: expect.arrayContaining(["design"]) }),
    ]));
    expect(reviewed.change.reviews.readiness).toMatchObject({
      reviewer_execution_ids: [expect.any(String)],
      findings: [
        expect.objectContaining({ id: "F-101", route_to: "design.technical" }),
        expect.objectContaining({ id: "F-102", route_to: "plan.create" }),
      ],
    });
    expect(reviewed.recommended_next).toMatchObject({
      action: "revise.amend",
      entry_skill: "rockspec-change",
    });
    expect(reviewed.recovery).toMatchObject({
      review_id: "readiness",
      finding_ids: ["F-101", "F-102"],
      target: "design",
      approval_policy: "human",
    });

    const amended = await engine.amendRevision({
      changeId: id,
      reviewId: "readiness",
      findingIds: ["F-101", "F-102"],
      reason: "Bind the newly discovered Design and Plan gaps to the active recovery",
      affectedIds: ["D-001"],
    });
    expect(amended.current_state).toBe("SPEC_APPROVED");
    expect(amended.change.revisions).toHaveLength(1);
    expect(amended.change.revisions[0]).toMatchObject({
      id: "RV-001",
      target: "design",
      approval_policy: "human",
      authority_delta: "changed",
      amendments: [{
        id: "AM-001",
        source: "readiness.review",
        target: "design",
        trigger: { review_id: "readiness", finding_ids: ["F-101", "F-102"] },
      }],
    });
    await expect(readFile(
      path.join(root, ".rockspec", "changes", id, "revisions", "RV-001", "amendments", "AM-001", "before", "reviews", "readiness-review.md"),
      "utf8",
    )).resolves.toContain("F-102");
  }, 30_000);

  it("turns an Acceptance implementation Finding into a reviewed Remediation Plan without rewriting completed Tasks", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "remediate-acceptance-finding";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);
    await engine.startTask({ changeId: id, taskId: "T-001" });
    await writeFile(path.join(root, "feature.txt"), "implemented\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-001] implement behavior"], { cwd: root });
    const completedCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeImplementedReport(root, id, "runtime/tasks/T-001/implementer-report.md", "Implemented and checked.");
    await engine.runCheck({ changeId: id, taskId: "T-001", executable: process.execPath, args: ["-e", "process.exit(0)"] });
    const taskPackage = await engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-001" });
    await writeCodeReview(root, id, "reviews/tasks/T-001-review.md", taskPackage.subject);
    await engine.completeAction({ changeId: id, action: "task.review" });
    await engine.completeTask({ changeId: id, taskId: "T-001", commitSha: completedCommit });

    await replace(root, id, "testing/test-plan.md", "# Acceptance Plan\n\nExercise S-001.\n");
    await replace(
      root,
      id,
      "testing/test-report.md",
      `---\nschema_version: 1\nverdict: CHANGES_REQUIRED\nreviewer_execution_id: acceptance-reviewer\ncommit: ${completedCommit}\nfindings:\n  - id: F-001\n    severity: important\n    category: behavior\n    evidence: feature.txt:1\n    description: The integrated implementation fails an acceptance edge case.\n    owner_domain: implementation\n    route_to: task.execute\n    status: open\n---\n\n# Acceptance\n\nVerdict: CHANGES_REQUIRED\n`,
    );
    await bindExecutionInArtifact(root, id, "testing/test-report.md", "acceptance-reviewer", "acceptance.validate", "acceptance_engineer");
    const acceptance = await engine.completeAction({
      changeId: id,
      action: "acceptance.validate",
      verdict: "CHANGES_REQUIRED",
    });
    expect(acceptance.recovery).toMatchObject({
      kind: "revision",
      review_id: "acceptance",
      target: "plan",
      revision_kind: "remediation",
      finding_ids: ["F-001"],
    });
    const revised = await engine.revise({
      changeId: id,
      reviewId: "acceptance",
      findingIds: ["F-001"],
      reason: "Acceptance requires a separately reviewed remediation",
      affectedIds: [],
    });
    expect(revised.current_state).toBe("DESIGN_APPROVED");
    expect(revised.change.tasks["T-001"]).toMatchObject({ status: "completed", commit_sha: completedCommit });

    await replace(
      root,
      id,
      "plan.md",
      "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Recovery Plan\n\nAdd a Finding-bound remediation Task.\n",
    );
    await replace(root, id, "tasks.md", "# Tasks\n\n- [x] T-001\n- [ ] T-002 Remediate F-001\n");
    await replace(
      root,
      id,
      "tasks/T-002.md",
      `---\nschema_version: 1\nid: T-002\ntitle: Remediate acceptance edge case\ndependencies: [T-001]\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-001]\nfinding_ids: [F-001]\nacceptance_criteria: [The acceptance edge case passes.]\nconsumes: []\nproduces: []\nallowed_paths: [feature.txt]\n---\n\n# T-002\n\nFix the acceptance Finding without rewriting T-001.\n`,
    );
    const planned = await engine.completeAction({ changeId: id, action: "plan.create" });
    expect(planned.change.tasks["T-001"]).toMatchObject({ status: "completed", commit_sha: completedCommit });
    expect(planned.change.tasks["T-002"]).toMatchObject({ status: "pending", finding_ids: ["F-001"] });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });
    const ready = await approveGate(engine, id, "implementation");
    expect(ready.current_state).toBe("READY");
    expect((await engine.nextTask({ changeId: id }))?.id).toBe("T-002");
    expect(ready.change.revisions[0]).toMatchObject({
      mode: "implementation_recovery",
      kind: "remediation",
      status: "reconciled",
      trigger: { review_id: "acceptance", finding_ids: ["F-001"] },
    });
  }, 30_000);

  it("attributes a historical product Commit through a Finding-bound Recovery Task", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "attribute-historical-commit";
    await engine.newChange({ id, profile: "standard", uatPolicy: "optional" });
    await makeReady(engine, root, id);

    await writeFile(path.join(root, "historical.txt"), "approved behavior introduced before Task attribution\n");
    await execFileAsync("git", ["add", "historical.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fix(worker): preserve historical routing context"], { cwd: root });
    const historicalCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const historicalParent = (await execFileAsync("git", ["rev-parse", `${historicalCommit}^`], { cwd: root })).stdout.trim();

    await engine.startTask({ changeId: id, taskId: "T-001" });
    await writeFile(path.join(root, "feature.txt"), "implemented\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-001] implement behavior"], { cwd: root });
    const implementationCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeImplementedReport(root, id, "runtime/tasks/T-001/implementer-report.md", "Implemented the planned behavior.");
    await engine.runCheck({ changeId: id, taskId: "T-001", executable: process.execPath, args: ["-e", "process.exit(0)"] });
    const firstPackage = await engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-001" });
    await writeCodeReview(root, id, "reviews/tasks/T-001-review.md", firstPackage.subject);
    await engine.completeAction({ changeId: id, action: "task.review" });
    await engine.completeTask({ changeId: id, taskId: "T-001", commitSha: implementationCommit });

    await replace(root, id, "testing/test-plan.md", "# Acceptance Plan\n\nExercise S-001.\n");
    await replace(
      root,
      id,
      "testing/test-report.md",
      `---\nschema_version: 1\nverdict: CHANGES_REQUIRED\nreviewer_execution_id: acceptance-reviewer\ncommit: ${implementationCommit}\nfindings:\n  - id: F-001\n    severity: important\n    category: commit-attribution\n    evidence: historical.txt:1\n    description: The approved historical product Commit has no Task attribution.\n    owner_domain: implementation\n    route_to: task.execute\n    status: open\n---\n\n# Acceptance\n\nVerdict: CHANGES_REQUIRED\n`,
    );
    await bindExecutionInArtifact(root, id, "testing/test-report.md", "acceptance-reviewer", "acceptance.validate", "acceptance_engineer");
    await engine.completeAction({ changeId: id, action: "acceptance.validate", verdict: "CHANGES_REQUIRED" });
    await engine.revise({
      changeId: id,
      reviewId: "acceptance",
      findingIds: ["F-001"],
      reason: "Trace the approved historical Commit through an independently reviewed attribution Task",
      affectedIds: [],
    });

    await replace(root, id, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Recovery Plan\n\nAttribute the historical Commit without rewriting Git history.\n");
    await replace(root, id, "tasks.md", "# Tasks\n\n- [x] T-001\n- [ ] T-002 Attribute F-001\n");
    await replace(root, id, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-001"],
      allowedPath: "historical.txt",
      dependencies: ["T-001"],
      findingIds: ["F-001"],
      adoptedCommit: historicalParent,
    }));
    await expect(engine.completeAction({ changeId: id, action: "plan.create" }))
      .rejects.toMatchObject({ code: "ADOPTED_COMMIT_OUT_OF_RANGE" });

    const historicalTree = (await execFileAsync("git", ["rev-parse", `${historicalCommit}^{tree}`], { cwd: root })).stdout.trim();
    const nonAncestorCommit = (await execFileAsync(
      "git",
      ["commit-tree", historicalTree, "-p", historicalParent, "-m", "fix: non-ancestor attribution candidate"],
      { cwd: root },
    )).stdout.trim();
    await replace(root, id, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-001"],
      allowedPath: "historical.txt",
      dependencies: ["T-001"],
      findingIds: ["F-001"],
      adoptedCommit: nonAncestorCommit,
    }));
    await expect(engine.completeAction({ changeId: id, action: "plan.create" }))
      .rejects.toMatchObject({ code: "ADOPTED_COMMIT_OUT_OF_RANGE" });

    await replace(root, id, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-001"],
      allowedPath: "historical.txt",
      dependencies: ["T-001"],
      findingIds: ["F-001"],
      adoptedCommit: implementationCommit,
    }));
    await expect(engine.completeAction({ changeId: id, action: "plan.create" }))
      .rejects.toMatchObject({ code: "DUPLICATE_TASK_COMMIT" });

    await replace(root, id, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-001"],
      allowedPath: "historical.txt",
      dependencies: ["T-001"],
      findingIds: ["F-001"],
      adoptedCommit: historicalCommit.slice(0, 12),
    }));
    const planned = await engine.completeAction({ changeId: id, action: "plan.create" });
    expect(planned.change.tasks["T-002"]).toMatchObject({
      status: "pending",
      adopted_commit: historicalCommit,
      finding_ids: ["F-001"],
    });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });
    await approveGate(engine, id, "implementation");

    const started = await engine.startTask({ changeId: id, taskId: "T-002" });
    const task = started.change.tasks["T-002"]!;
    expect(task.base_commit).toBe(historicalParent);
    expect(await readFile(path.join(root, ".rockspec", "changes", id, task.brief_path!), "utf8"))
      .toContain("Historical Attribution Mode");
    await writeImplementedReport(root, id, task.report_path!, "Reviewed the historical Diff and verified it against the approved behavior.");
    await engine.runCheck({ changeId: id, taskId: "T-002", executable: process.execPath, args: ["-e", "process.exit(0)"] });
    const historicalPackage = await engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-002" });
    expect(historicalPackage).toMatchObject({
      mode: "historical_attribution",
      subject: { base_commit: historicalParent, head_commit: historicalCommit },
    });
    await expect(engine.completeTask({ changeId: id, taskId: "T-002", commitSha: historicalCommit }))
      .rejects.toMatchObject({ code: "REVIEW_NOT_PASSED" });
    await writeCodeReview(root, id, "reviews/tasks/T-002-review.md", historicalPackage.subject);
    await engine.completeAction({ changeId: id, action: "task.review" });
    const attributed = await engine.completeTask({ changeId: id, taskId: "T-002", commitSha: historicalCommit });
    expect(attributed.change.tasks["T-002"]).toMatchObject({
      status: "completed",
      commit_sha: historicalCommit,
      adopted_commit: historicalCommit,
    });

    await engine.runCheck({
      changeId: id,
      actionId: "acceptance.validate",
      scenarioIds: ["S-001"],
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await passReview(root, id, "testing/test-report.md");
    const accepted = await engine.completeAction({ changeId: id, action: "acceptance.validate" });
    expect(accepted.current_state).toBe("FINAL_REVIEW");
    const deliveryPackage = await engine.prepareReviewPackage({ changeId: id, kind: "delivery" });
    await writeCodeReview(root, id, "reviews/delivery-review.md", deliveryPackage.subject);
    const delivered = await engine.completeAction({ changeId: id, action: "delivery.review" });
    expect(delivered.current_state).toBe("VERIFYING");
  }, 30_000);

  it("rejects historical Commit attribution outside implementation Recovery", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "reject-unbound-historical-attribution";
    await engine.newChange({ id, profile: "standard" });
    await preparePlanning(engine, root, id);
    await writeFile(path.join(root, "feature.txt"), "historical product change\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fix: unbound historical change"], { cwd: root });
    const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await replace(root, id, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Plan\n");
    await replace(root, id, "tasks.md", "# Tasks\n\n- [ ] T-001\n");
    await replace(root, id, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      allowedPath: "feature.txt",
      adoptedCommit: commit,
    }));
    await expect(engine.completeAction({ changeId: id, action: "plan.create" }))
      .rejects.toMatchObject({ code: "ADOPTED_COMMIT_REQUIRES_RECOVERY" });
  }, 30_000);

  it("rejects cyclic Task dependencies and interface consumers outside the producer dependency chain", async () => {
    const cycleRoot = await repository();
    const cycleEngine = new RockSpecEngine({ cwd: cycleRoot });
    await cycleEngine.init();
    const cycleId = "add-cyclic-task-plan";
    await cycleEngine.newChange({ id: cycleId, profile: "standard" });
    await preparePlanning(cycleEngine, cycleRoot, cycleId);
    await replace(cycleRoot, cycleId, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n");
    await replace(cycleRoot, cycleId, "tasks.md", "# Tasks\n\n- [ ] T-001\n- [ ] T-002\n");
    await replace(cycleRoot, cycleId, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      allowedPath: "one.ts",
      dependencies: ["T-002"],
    }));
    await replace(cycleRoot, cycleId, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-001"],
      allowedPath: "two.ts",
      dependencies: ["T-001"],
    }));
    await expect(cycleEngine.completeAction({ changeId: cycleId, action: "plan.create" }))
      .rejects.toMatchObject({ code: "TASK_DEPENDENCY_CYCLE" });

    const interfaceRoot = await repository();
    const interfaceEngine = new RockSpecEngine({ cwd: interfaceRoot });
    await interfaceEngine.init();
    const interfaceId = "add-task-interface-check";
    await interfaceEngine.newChange({ id: interfaceId, profile: "standard" });
    await preparePlanning(interfaceEngine, interfaceRoot, interfaceId);
    await replace(interfaceRoot, interfaceId, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n");
    await replace(interfaceRoot, interfaceId, "tasks.md", "# Tasks\n\n- [ ] T-001\n- [ ] T-002\n");
    await replace(interfaceRoot, interfaceId, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      allowedPath: "producer.ts",
      produces: ["profile-export.v1"],
    }));
    await replace(interfaceRoot, interfaceId, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-001"],
      allowedPath: "consumer.ts",
      consumes: ["profile-export.v1"],
    }));
    await expect(interfaceEngine.completeAction({ changeId: interfaceId, action: "plan.create" }))
      .rejects.toMatchObject({ code: "TASK_INPUT_NOT_DEPENDENCY" });
  });

  it("validates Task traceability and accepts a covered producer-consumer DAG", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "add-traceable-task-plan";
    await engine.newChange({ id, profile: "standard" });
    await preparePlanning(engine, root, id);
    await replace(root, id, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n");
    await replace(root, id, "tasks.md", "# Tasks\n\n- [ ] T-001\n");
    await replace(root, id, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-999"],
      allowedPath: "unknown.ts",
    }));
    await expect(engine.completeAction({ changeId: id, action: "plan.create" }))
      .rejects.toMatchObject({ code: "TASK_SCENARIO_NOT_FOUND" });

    const coverageRoot = await repository();
    const coverageEngine = new RockSpecEngine({ cwd: coverageRoot });
    await coverageEngine.init();
    const coverageId = "add-covered-task-plan";
    await coverageEngine.newChange({ id: coverageId, profile: "standard" });
    await replace(
      coverageRoot,
      coverageId,
      "proposal.md",
      "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\n## Why\n\nUsers need both outcomes.\n\n## What\n\nAdd both observable outcomes.\n",
    );
    await replace(
      coverageRoot,
      coverageId,
      "specs/change/spec.md",
      "## ADDED Requirements\n\n### R-001 Requirement: Observable behavior\n\nThe system MUST provide both approved outcomes.\n\n#### S-001 Scenario: Primary outcome\n\n- GIVEN a valid user context\n- WHEN the user requests the primary outcome\n- THEN the system returns it\n\n#### S-002 Scenario: Secondary outcome\n\n- GIVEN a valid user context\n- WHEN the user requests the secondary outcome\n- THEN the system returns it\n",
    );
    await coverageEngine.completeAction({ changeId: coverageId, action: "requirements.clarify" });
    await passReview(coverageRoot, coverageId, "reviews/requirements-review.md");
    await coverageEngine.completeAction({ changeId: coverageId, action: "requirements.review" });
    await approveGate(coverageEngine, coverageId, "spec");
    const coverageSpecHash = await approvedSpecHash(coverageRoot, coverageId);
    await replace(
      coverageRoot,
      coverageId,
      "design.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${coverageSpecHash}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001, S-002]\n---\n\n# Technical Design\n\n## 全局约束\n\nNone.\n\n## 总体方案比较\n\nUse one shared behavior boundary.\n\n## Decisions\n\n${completeDecisionBody("D-001", "Both outcomes", "Cover both approved outcomes through one stable boundary.")}\n\n## 未解决风险\n\nNone.\n`,
    );
    await coverageEngine.completeAction({ changeId: coverageId, action: "design.technical" });
    await approveGate(coverageEngine, coverageId, "design");
    await replace(coverageRoot, coverageId, "plan.md", "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n");
    await replace(coverageRoot, coverageId, "tasks.md", "# Tasks\n\n- [ ] T-001\n");
    await replace(coverageRoot, coverageId, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      allowedPath: "primary.ts",
    }));
    await expect(coverageEngine.completeAction({ changeId: coverageId, action: "plan.create" }))
      .rejects.toMatchObject({
        code: "SCENARIO_COVERAGE_GAP",
        details: { scenario_ids: ["S-002"] },
      });

    await replace(coverageRoot, coverageId, "tasks.md", "# Tasks\n\n- [ ] T-001\n- [ ] T-002\n");
    await replace(coverageRoot, coverageId, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      allowedPath: "primary.ts",
      produces: ["primary-result.v1"],
    }));
    await replace(coverageRoot, coverageId, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-002"],
      allowedPath: "secondary.ts",
      dependencies: ["T-001"],
      consumes: ["primary-result.v1"],
    }));
    const planned = await coverageEngine.completeAction({ changeId: coverageId, action: "plan.create" });
    expect(planned.current_state).toBe("READINESS_REVIEW");
    expect(planned.change.tasks["T-002"]).toMatchObject({
      dependencies: ["T-001"],
      consumes: ["primary-result.v1"],
      scenario_ids: ["S-002"],
    });
  });

  it("projects Task authority narrowly and gives Reviewers an independent cross-check", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "project-role-context";
    await engine.newChange({ id, profile: "standard" });
    await replace(
      root,
      id,
      "proposal.md",
      "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\nProposal marker must remain index-only.\n",
    );
    await replace(
      root,
      id,
      "specs/change/spec.md",
      "## ADDED Requirements\n\n### R-001 Requirement: Projected behavior\n\nThe system MUST provide both projected outcomes.\n\n#### S-001 Scenario: Primary projection\n\n- GIVEN a valid request\n- WHEN the primary behavior runs\n\n```bash\n# This example heading must not truncate the Scenario.\n./run-primary\n```\n\n- THEN the primary result is returned after the fenced example\n\n#### S-002 Scenario: Secondary projection\n\n- GIVEN a primary result\n- WHEN the secondary behavior runs\n- THEN the secondary result is returned\nScenario-specific trailing guidance belongs to S-002.\n",
    );
    await engine.completeAction({ changeId: id, action: "requirements.clarify" });
    await passReview(root, id, "reviews/requirements-review.md");
    await engine.completeAction({ changeId: id, action: "requirements.review" });
    await approveGate(engine, id, "spec");
    const specHash = await approvedSpecHash(root, id);
    await replace(
      root,
      id,
      "design.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${specHash}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n  - id: D-002\n    requirement_ids: [R-001]\n    scenario_ids: [S-002]\n---\n\n# Technical Design\n\n## 全局约束\n\nKeep writes inside the approved transaction boundary.\n\n## 总体方案比较\n\nUse the existing service boundary for both outcomes.\n\n## Decisions\n\n${completeDecisionBody("D-001", "Primary boundary", "Produce the primary result through the existing service boundary.\n\n~~~ts\n# This fenced line is not a section boundary.\nconst boundary = \"primary\";\n~~~\n\nContinue applying D-001 after the tilde fence.")}\n\n${completeDecisionBody("D-002", "Secondary boundary", "Consume the primary result without bypassing validation.")}\n\n## 未解决风险\n\nNone.\n`,
    );
    await engine.completeAction({ changeId: id, action: "design.technical" });
    await approveGate(engine, id, "design");
    await replace(
      root,
      id,
      "plan.md",
      "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n\nPlan marker must remain index-only.\n\n## Global Constraints\n\nPreserve the public result contract.\n",
    );
    await replace(root, id, "tasks.md", "# Tasks\n\n- [ ] T-001\n- [ ] T-002\n- [ ] T-003\n");
    await replace(root, id, "tasks/T-001.md", taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      decisionIds: ["D-001"],
      allowedPath: "primary.ts",
      produces: ["primary-result.v1"],
      validationCommands: [
        `${process.execPath} -e "process.exit(0)"`,
        `${process.execPath} -e 'process.stdout.write("validated")'`,
      ],
    }));
    await replace(root, id, "tasks/T-002.md", taskDocument({
      id: "T-002",
      scenarioIds: ["S-002"],
      decisionIds: ["D-002"],
      allowedPath: "secondary.ts",
      dependencies: ["T-001"],
      consumes: ["primary-result.v1"],
      produces: ["secondary-result.v1"],
    }));
    await replace(root, id, "tasks/T-003.md", taskDocument({
      id: "T-003",
      scenarioIds: ["S-002"],
      decisionIds: ["D-002"],
      allowedPath: "tertiary.ts",
      dependencies: ["T-002"],
      consumes: ["secondary-result.v1"],
    }));
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });
    await approveGate(engine, id, "implementation");

    const started = await engine.startTask({ changeId: id, taskId: "T-001" });
    const firstTask = started.change.tasks["T-001"]!;
    const firstBrief = await readFile(path.join(root, ".rockspec", "changes", id, firstTask.brief_path!), "utf8");
    expect(firstBrief).toContain("#### S-001 Scenario: Primary projection");
    expect(firstBrief).toContain("the primary result is returned after the fenced example");
    expect(firstBrief).toContain("### D-001 Primary boundary");
    expect(firstBrief).toContain("#### 模块与职责");
    expect(firstBrief).toContain("#### 接口与数据流");
    expect(firstBrief).toContain("#### 安全与隐私");
    expect(firstBrief).toContain("Continue applying D-001 after the tilde fence.");
    expect(firstBrief).toContain("Keep writes inside the approved transaction boundary.");
    expect(firstBrief).toContain("Preserve the public result contract.");
    expect(firstBrief).not.toContain("#### S-002 Scenario: Secondary projection");
    expect(firstBrief).not.toContain("### D-002 Secondary boundary");
    expect(firstBrief).not.toContain("Proposal marker must remain index-only.");
    expect(firstBrief).not.toContain("Plan marker must remain index-only.");

    await writeFile(path.join(root, "primary.ts"), "export const primary = 'ready';\n");
    await execFileAsync("git", ["add", "primary.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-001] produce primary result"], { cwd: root });
    const firstCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeImplementedReport(root, id, firstTask.report_path!, "Implemented the primary result.");
    await engine.runCheck({ changeId: id, taskId: "T-001", executable: process.execPath, args: ["-e", "process.exit(0)"] });
    const reviewPackage = await engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-001" });
    const reviewContent = await readFile(path.join(root, ".rockspec", "changes", id, reviewPackage.path), "utf8");
    expect(reviewPackage.hash).toBe(`sha256:${createHash("sha256").update(reviewContent).digest("hex")}`);
    expect(reviewContent).toContain("### Frozen Implementer Projection");
    expect(reviewContent).toContain("### Reviewer-only Projection Audit");
    expect(reviewContent).toContain("### D-002 Secondary boundary");
    expect(reviewContent).toContain("### Executed Evidence Index");
    await writeCodeReview(root, id, "reviews/tasks/T-001-review.md", reviewPackage.subject);
    await engine.completeAction({ changeId: id, action: "task.review" });
    await expect(engine.completeTask({ changeId: id, taskId: "T-001", commitSha: firstCommit }))
      .rejects.toMatchObject({
        code: "TASK_VALIDATION_EVIDENCE_MISSING",
        details: { missing_commands: [`${process.execPath} -e 'process.stdout.write("validated")'`] },
      });
    await engine.runCheck({
      changeId: id,
      taskId: "T-001",
      executable: process.execPath,
      args: ["-e", "process.stdout.write(\"validated\")"],
    });
    await engine.completeTask({ changeId: id, taskId: "T-001", commitSha: firstCommit });

    const secondStarted = await engine.startTask({ changeId: id, taskId: "T-002" });
    const secondTask = secondStarted.change.tasks["T-002"]!;
    const secondBrief = await readFile(path.join(root, ".rockspec", "changes", id, secondTask.brief_path!), "utf8");
    expect(secondBrief).toContain("#### S-002 Scenario: Secondary projection");
    expect(secondBrief).toContain("Scenario-specific trailing guidance belongs to S-002.");
    expect(secondBrief).toContain("### D-002 Secondary boundary");
    expect(secondBrief).not.toContain("#### S-001 Scenario: Primary projection");
    expect(secondBrief).toContain(`- Delivered Commit: ${firstCommit}`);
    expect(secondBrief).toContain("primary-result.v1");

    await writeFile(path.join(root, "secondary.ts"), "export const secondary = 'ready';\n");
    await execFileAsync("git", ["add", "secondary.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-002] produce secondary result"], { cwd: root });
    const secondCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeImplementedReport(root, id, secondTask.report_path!, "Implemented the secondary result.");
    await engine.runCheck({ changeId: id, taskId: "T-002", executable: process.execPath, args: ["-e", "process.exit(0)"] });
    const secondPackage = await engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-002" });
    await writeCodeReview(root, id, "reviews/tasks/T-002-review.md", secondPackage.subject);
    await engine.completeAction({ changeId: id, action: "task.review" });
    await engine.completeTask({ changeId: id, taskId: "T-002", commitSha: secondCommit });

    const thirdStarted = await engine.startTask({ changeId: id, taskId: "T-003" });
    const thirdTask = thirdStarted.change.tasks["T-003"]!;
    const thirdBrief = await readFile(path.join(root, ".rockspec", "changes", id, thirdTask.brief_path!), "utf8");
    expect(thirdBrief).toContain(`- Delivered Commit: ${firstCommit}`);
    expect(thirdBrief).toContain(`- Delivered Commit: ${secondCommit}`);
    expect(thirdBrief).toContain("primary-result.v1");
    expect(thirdBrief).toContain("secondary-result.v1");
  }, 30_000);

  it("fails closed when approved authority cannot be projected completely", async () => {
    const withDesign = async (id: string, body: string): Promise<{ root: string; engine: RockSpecEngine }> => {
      const root = await repository();
      const engine = new RockSpecEngine({ cwd: root });
      await engine.init();
      await engine.newChange({ id, profile: "standard" });
      await approveRequirements(engine, root, id);
      const specHash = await approvedSpecHash(root, id);
      await replace(
        root,
        id,
        "design.md",
        `---\nschema_version: 1\ninputs:\n  spec_hash: ${specHash}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n${body}\n`,
      );
      return { root, engine };
    };

    const missingDecision = await withDesign(
      "missing-decision-section",
      "## 全局约束\n\nNone.\n\n## 总体方案比较\n\nUse one boundary.\n\n## Decisions\n\n### Architecture\n\nNo stable Decision heading is present.\n\n## 未解决风险\n\nNone.",
    );
    await expect(missingDecision.engine.completeAction({ changeId: "missing-decision-section", action: "design.technical" }))
      .rejects.toMatchObject({ code: "AUTHORITY_SECTION_MISSING" });

    const missingConstraints = await withDesign(
      "missing-global-constraints",
      `## 总体方案比较\n\nUse one boundary.\n\n## Decisions\n\n${completeDecisionBody("D-001", "Existing boundary", "Use the existing module boundary.")}\n\n## 未解决风险\n\nNone.`,
    );
    await expect(missingConstraints.engine.completeAction({ changeId: "missing-global-constraints", action: "design.technical" }))
      .rejects.toMatchObject({ code: "DESIGN_GLOBAL_CONSTRAINTS_MISSING" });

    const incompleteDecision = await withDesign(
      "incomplete-design-decision",
      "## 全局约束\n\nNone.\n\n## 总体方案比较\n\nUse one boundary.\n\n## Decisions\n\n### D-001 Existing boundary\n\n#### 架构决策\n\nUse the existing module boundary.\n\n## 未解决风险\n\nNone.",
    );
    await expect(incompleteDecision.engine.completeAction({ changeId: "incomplete-design-decision", action: "design.technical" }))
      .rejects.toMatchObject({ code: "DESIGN_DECISION_INCOMPLETE", details: { decision_id: "D-001" } });

    const projectionGap = await withDesign(
      "missing-spec-projection",
      `## 全局约束\n\nNone.\n\n## 总体方案比较\n\nUse one boundary.\n\n## Decisions\n\n${completeDecisionBody("D-001", "Existing boundary", "Use the existing module boundary.")}\n\n## 未解决风险\n\nNone.`,
    );
    await finishReadiness(projectionGap.engine, projectionGap.root, "missing-spec-projection");
    const snapshotPath = path.join(projectionGap.root, ".rockspec", "changes", "missing-spec-projection", "change.yaml");
    const snapshot = parse(await readFile(snapshotPath, "utf8")) as { tasks: Record<string, { requirement_ids: string[] }> };
    snapshot.tasks["T-001"]!.requirement_ids = ["R-999"];
    await writeFile(snapshotPath, stringify(snapshot, { lineWidth: 0 }));
    await expect(projectionGap.engine.startTask({ changeId: "missing-spec-projection", taskId: "T-001" }))
      .rejects.toMatchObject({
        code: "TASK_AUTHORITY_PROJECTION_GAP",
        details: { requirement_ids: ["R-999"] },
      });
  }, 30_000);

  it("preflights implementation before approval and detects stale readiness inputs", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "implementation-preflight";
    await engine.newChange({ id, profile: "standard" });
    await approveRequirements(engine, root, id);
    await materializeDesign(root, id);
    await engine.completeAction({ changeId: id, action: "design.technical" });
    await approveGate(engine, id, "design");
    await materializePlan(root, id);
    await engine.completeAction({ changeId: id, action: "plan.create" });
    await passReview(root, id, "reviews/readiness-review.md");
    await engine.completeAction({ changeId: id, action: "readiness.review" });

    await expect(engine.preflightImplementation({ changeId: id })).resolves.toMatchObject({
      valid: true,
      change_id: id,
      current_state: "READINESS_REVIEW",
      task_count: 1,
      ready_task_ids: ["T-001"],
      review_modes: ["product", "scope_blocked", "historical_attribution"],
    });

    await replace(root, id, "tasks/T-001.md", `${taskDocument({
      id: "T-001",
      scenarioIds: ["S-001"],
      allowedPath: "feature.txt",
    })}\n`);
    await expect(engine.preflightImplementation({ changeId: id }))
      .rejects.toMatchObject({ code: "STALE_REVIEW" });
  });

  it("rejects illegal actions and blocks a missing UI provider only at prototype design", async () => {
    const root = await repository();
    const unavailable = new RockSpecEngine({ cwd: root });
    await unavailable.init();
    await unavailable.newChange({
      id: "add-settings-navigation",
      profile: "standard",
      prototypeRequired: true,
    });
    await expect(
      unavailable.completeAction({ changeId: "add-settings-navigation", action: "delivery.review" }),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
    await approveRequirements(unavailable, root, "add-settings-navigation");
    await materializeDesign(root, "add-settings-navigation");
    await unavailable.completeAction({ changeId: "add-settings-navigation", action: "design.technical" });
    const blocked = await unavailable.getStatus({ changeId: "add-settings-navigation" });
    expect(blocked.blocked_by).toContainEqual(expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }));

    const available = new RockSpecEngine({ cwd: root, availableProviders: new Set(["ui-ux-pro-max"]) });
    const snapshot = parse(await readFile(
      path.join(root, ".rockspec", "changes", "add-settings-navigation", "change.yaml"),
      "utf8",
    )) as { approvals: { spec: { aggregate_hash: string } }; artifacts: { design: { hash: string } } };
    await replace(
      root,
      "add-settings-navigation",
      "prototype/brief.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${snapshot.approvals.spec.aggregate_hash}\n  design_hash: ${snapshot.artifacts.design.hash}\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-001]\n---\n\n# Prototype Brief\n\nSettings navigation for account users.\n`,
    );
    await replace(root, "add-settings-navigation", "prototype/design-system.md", "# Design System\n\nUse existing tokens with visible focus and AA contrast.\n");
    await replace(root, "add-settings-navigation", "prototype/prototype.md", "# Prototype\n\nDesktop and mobile navigation states are defined.\n");
    await replace(
      root,
      "add-settings-navigation",
      "prototype/brief.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${snapshot.approvals.spec.aggregate_hash}\n  design_hash: ${snapshot.artifacts.design.hash}\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-999]\n---\n\n# Prototype Brief\n\nInvalid decision reference.\n`,
    );
    await expect(available.completeAction({
      changeId: "add-settings-navigation",
      action: "design.prototype",
    })).rejects.toMatchObject({ code: "PROTOTYPE_TRACEABILITY_INVALID" });
    await replace(
      root,
      "add-settings-navigation",
      "prototype/brief.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${snapshot.approvals.spec.aggregate_hash}\n  design_hash: ${snapshot.artifacts.design.hash}\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-001]\n---\n\n# Prototype Brief\n\nSettings navigation for account users.\n`,
    );
    const completed = await available.completeAction({
      changeId: "add-settings-navigation",
      action: "design.prototype",
    });
    expect(completed.change.prototype.status).toBe("completed");
    expect(completed.recommended_next?.action).toBe("design.technical");
    await available.completeAction({ changeId: "add-settings-navigation", action: "design.technical" });
    expect((await available.getStatus({ changeId: "add-settings-navigation" })).change.prototype.status)
      .toBe("reconciled");
  });

  it("enforces Task commit/evidence and the TE to Final CR order", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "support-order-cancellation", profile: "standard", uatPolicy: "required" });
    await makeReady(engine, root, "support-order-cancellation");
    const specPath = path.join(
      root,
      ".rockspec",
      "changes",
      "support-order-cancellation",
      "specs",
      "change",
      "spec.md",
    );
    const approvedSpec = await readFile(specPath, "utf8");
    await writeFile(specPath, `${approvedSpec}\nChanged after downstream approval.\n`);
    await expect(
      engine.startTask({ changeId: "support-order-cancellation", taskId: "T-001" }),
    ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    await writeFile(specPath, approvedSpec);
    await engine.startTask({ changeId: "support-order-cancellation", taskId: "T-001" });
    await expect(engine.revise({
      changeId: "support-order-cancellation",
      source: "task.execute",
      target: "requirements",
      reason: "Too late to change approved scope in place",
      affectedIds: ["R-001"],
    })).rejects.toMatchObject({ code: "RECOVERY_FINDING_REQUIRED" });
    await passReview(root, "support-order-cancellation", "reviews/tasks/T-001-review.md");
    await writeFile(path.join(root, "feature.txt"), "implemented\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat(order): T-001 support cancellation"], { cwd: root });
    const invalidCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await expect(engine.completeTask({
      changeId: "support-order-cancellation",
      taskId: "T-001",
      commitSha: invalidCommit,
    })).rejects.toMatchObject({ code: "TASK_COMMIT_MESSAGE" });
    await execFileAsync("git", ["commit", "--amend", "-m", "feat(order): [T-001] support cancellation"], { cwd: root });
    const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeImplementedReport(
      root,
      "support-order-cancellation",
      "runtime/tasks/T-001/implementer-report.md",
      "Implemented feature.txt and verified observable behavior.",
    );
    await engine.runCheck({
      changeId: "support-order-cancellation",
      taskId: "T-001",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const taskPackage = await engine.prepareReviewPackage({
      changeId: "support-order-cancellation",
      kind: "task",
      taskId: "T-001",
    });
    await writeCodeReview(
      root,
      "support-order-cancellation",
      "reviews/tasks/T-001-review.md",
      taskPackage.subject,
    );
    await engine.completeAction({ changeId: "support-order-cancellation", action: "task.review" });
    const taskDone = await engine.completeTask({
      changeId: "support-order-cancellation",
      taskId: "T-001",
      commitSha: commit,
    });
    expect(taskDone.current_state).toBe("ACCEPTANCE_VALIDATING");
    await expect(
      engine.completeAction({ changeId: "support-order-cancellation", action: "delivery.review" }),
    ).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });

    const uncommittedTest = path.join(root, "acceptance.e2e.ts");
    await writeFile(uncommittedTest, "// pending TE asset\n");
    await expect(
      engine.completeAction({ changeId: "support-order-cancellation", action: "acceptance.validate" }),
    ).rejects.toMatchObject({ code: "UNCOMMITTED_PRODUCT_CHANGES" });
    await rm(uncommittedTest);

    await passReview(root, "support-order-cancellation", "testing/test-report.md");
    await engine.runCheck({
      changeId: "support-order-cancellation",
      actionId: "acceptance.validate",
      scenarioIds: ["S-001"],
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const accepted = await engine.completeAction({
      changeId: "support-order-cancellation",
      action: "acceptance.validate",
    });
    expect(accepted.current_state).toBe("UAT_PENDING");
    expect(accepted.recommended_next?.action).toBe("acceptance.uat");
    await replace(
      root,
      "support-order-cancellation",
      "testing/uat-report.md",
      `---\nschema_version: 1\nverdict: CONFIRMED\nconfirmed_by: product-owner\ncommit: ${commit}\nscenario_ids: [S-999]\nnotes: This report references a Scenario outside the approved Spec.\n---\n\n# User Acceptance\n\nInvalid Scenario.\n`,
    );
    await expect(engine.completeUat({ changeId: "support-order-cancellation" })).rejects.toMatchObject({
      code: "UAT_SCENARIO_NOT_FOUND",
    });
    await confirmUat(engine, root, "support-order-cancellation");
    const deliveryPackage = await engine.prepareReviewPackage({
      changeId: "support-order-cancellation",
      kind: "delivery",
    });
    await replace(
      root,
      "support-order-cancellation",
      "reviews/delivery-review.md",
      `---\nschema_version: 1\nverdict: CHANGES_REQUIRED\nreviewer_execution_id: delivery-reviewer-execution\nsubject:\n  base_commit: ${deliveryPackage.subject.base_commit}\n  head_commit: ${deliveryPackage.subject.head_commit}\n  diff_hash: ${deliveryPackage.subject.diff_hash}\nround: 0\nfindings:\n  - id: F-001\n    severity: important\n    category: test-quality\n    evidence: testing/test-report.md:1\n    description: Acceptance evidence misses an edge case.\n    owner_domain: testing\n    route_to: acceptance.validate\n    status: open\n---\n\n# Delivery Review\n\nVerdict: CHANGES_REQUIRED\n`,
    );
    await bindExecutionInArtifact(root, "support-order-cancellation", "reviews/delivery-review.md", "delivery-reviewer-execution", "delivery.review", "delivery_reviewer");
    const returnedToAcceptance = await engine.completeAction({
      changeId: "support-order-cancellation",
      action: "delivery.review",
    });
    expect(returnedToAcceptance.current_state).toBe("ACCEPTANCE_VALIDATING");
    expect(returnedToAcceptance.recovery).toBeNull();
    expect(returnedToAcceptance.change.reviews.delivery).toBeUndefined();
    await expect(readFile(
      path.join(root, ".rockspec", "changes", "support-order-cancellation", "reviews", "history", "delivery-review-attempt-001.md"),
      "utf8",
    )).resolves.toContain("F-001");

    await passReview(root, "support-order-cancellation", "testing/test-report.md");
    const acceptedAgain = await engine.completeAction({
      changeId: "support-order-cancellation",
      action: "acceptance.validate",
    });
    expect(acceptedAgain.current_state).toBe("UAT_PENDING");
    await confirmUat(engine, root, "support-order-cancellation");
    expect((await engine.getStatus({ changeId: "support-order-cancellation" })).recommended_next?.action).toBe("delivery.review");

    const nextDeliveryPackage = await engine.prepareReviewPackage({
      changeId: "support-order-cancellation",
      kind: "delivery",
    });
    await writeCodeReview(
      root,
      "support-order-cancellation",
      "reviews/delivery-review.md",
      nextDeliveryPackage.subject,
      "PASS",
    );
    const reviewed = await engine.completeAction({
      changeId: "support-order-cancellation",
      action: "delivery.review",
    });
    expect(reviewed.current_state).toBe("VERIFYING");
    await engine.runCheck({
      changeId: "support-order-cancellation",
      actionId: "change.verify",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const finished = await engine.verify({ changeId: "support-order-cancellation" });
    expect(finished.current_state).toBe("READY_TO_FINISH");
  }, 30_000);

  it("recovers only expired locks whose owner process is gone", async () => {
    const root = await repository();
    const rocksRoot = path.join(root, ".rockspec");
    await mkdir(path.join(rocksRoot, ".lock"), { recursive: true });
    const ownerPath = path.join(rocksRoot, ".lock", "owner.json");

    await writeFile(ownerPath, `${JSON.stringify({
      pid: process.pid,
      started_at: "2000-01-01T00:00:00.000Z",
      token: "live-owner",
    })}\n`);
    await expect(withFileLock(rocksRoot, async () => undefined, 50, 1))
      .rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    await expect(readFile(ownerPath, "utf8")).resolves.toContain("live-owner");

    await writeFile(ownerPath, `${JSON.stringify({
      pid: 2_147_483_647,
      started_at: "2000-01-01T00:00:00.000Z",
      token: "dead-owner",
    })}\n`);
    await expect(withFileLock(rocksRoot, async () => "recovered", 500, 1)).resolves.toBe("recovered");
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(path.join(rocksRoot, ".lock"), { recursive: true });
    await writeFile(path.join(rocksRoot, ".lock", "reclaim"), `${JSON.stringify({
      pid: 2_147_483_647,
      started_at: "2000-01-01T00:00:00.000Z",
      token: "dead-reclaimer",
    })}\n`);
    await expect(withFileLock(rocksRoot, async () => "recovered-reclaimer", 500, 1))
      .resolves.toBe("recovered-reclaimer");
  });

  it("does not release a lock after its owner token changes", async () => {
    const root = await repository();
    const rocksRoot = path.join(root, ".rockspec");
    const ownerPath = path.join(rocksRoot, ".lock", "owner.json");
    await withFileLock(rocksRoot, async () => {
      await writeFile(ownerPath, `${JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        token: "replacement-owner",
      })}\n`);
    });
    await expect(readFile(ownerPath, "utf8")).resolves.toContain("replacement-owner");
  });

  it("permits an explicit scope-blocked Task Review before any product Commit", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "scope-blocked-task-review";
    await engine.newChange({ id, profile: "standard" });
    await makeReady(engine, root, id);
    const started = await engine.startTask({ changeId: id, taskId: "T-001" });

    await expect(engine.prepareReviewPackage({ changeId: id, kind: "task", taskId: "T-001" }))
      .rejects.toMatchObject({ code: "TASK_COMMIT_COUNT" });
    await replace(
      root,
      id,
      "runtime/tasks/T-001/implementer-report.md",
      "# Implementer Report\n\nThe implementation is blocked because the frozen scope omits a required product boundary.\n",
    );
    await expect(engine.prepareReviewPackage({
      changeId: id,
      kind: "task",
      taskId: "T-001",
      mode: "scope_blocked",
    })).rejects.toMatchObject({ code: "MISSING_FRONTMATTER" });
    const task = started.change.tasks["T-001"]!;
    const blockedReport = stringify({
      schema_version: 1,
      task_id: task.id,
      execution_id: task.execution_id,
      base_commit: task.base_commit,
      brief_path: task.brief_path,
      brief_hash: task.brief_hash,
      outcome: "blocked",
      blocker: {
        kind: "contract_conflict",
        source_refs: ["tasks/T-001.md: acceptance_criteria", "D-001"],
        summary: "The Task omits the Admin API contract required by its acceptance criteria.",
        recommended_route: "plan.create",
      },
    }, { lineWidth: 0 }).trimEnd();
    await replace(
      root,
      id,
      "runtime/tasks/T-001/implementer-report.md",
      `---\n${blockedReport}\n---\n\n# Implementer Report\n\nImplementation stopped before product changes.\n`,
    );
    const prepared = await engine.prepareReviewPackage({
      changeId: id,
      kind: "task",
      taskId: "T-001",
      mode: "scope_blocked",
    });
    expect(prepared.mode).toBe("scope_blocked");
    expect(prepared.subject.base_commit).toBe(started.change.tasks["T-001"]?.base_commit);
    expect(prepared.subject.head_commit).toBe(prepared.subject.base_commit);
    expect(await readFile(path.join(root, ".rockspec", "changes", id, prepared.path), "utf8"))
      .toContain("# Mode: scope_blocked");

    await replace(
      root,
      id,
      "reviews/tasks/T-001-review.md",
      `---\nschema_version: 1\nverdict: BLOCKED\nreviewer_execution_id: scope-reviewer\nsubject:\n  base_commit: ${prepared.subject.base_commit}\n  head_commit: ${prepared.subject.head_commit}\n  diff_hash: ${prepared.subject.diff_hash}\nround: 0\nfindings:\n  - id: F-001\n    severity: important\n    category: task-scope\n    evidence: tasks/T-001.md:1\n    description: The Task does not include the Admin API contract required by its acceptance criteria.\n    owner_domain: planning\n    route_to: plan.create\n    status: open\n    classification: derived_gap\n    authority_impact: unchanged\n---\n\n# Review\n\nVerdict: BLOCKED\n`,
    );
    await bindExecutionInArtifact(root, id, "reviews/tasks/T-001-review.md", "scope-reviewer", "task.review", "task_reviewer");
    const blocked = await engine.completeAction({ changeId: id, action: "task.review", verdict: "BLOCKED" });
    expect(blocked.recovery).toMatchObject({
      kind: "revision",
      review_id: "task:T-001",
      finding_ids: ["F-001"],
      route_to: ["plan.create"],
      target: "plan",
    });
    expect(blocked.recommended_next?.action).toBe("revise");
    const revised = await engine.revise({
      changeId: id,
      reviewId: "task:T-001",
      findingIds: ["F-001"],
      reason: "Expand the Plan to cover the required Admin API contract.",
      affectedIds: ["D-001"],
      authorExecutionId: "scope-recovery-author",
    });
    expect(revised.current_state).toBe("DESIGN_APPROVED");
    expect(revised.change.tasks["T-001"]?.status).toBe("suspended");
  });

  it("pins Task history, reports scope expansion, Reviewer identity, and non-PASS Findings", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "harden-task-review", profile: "standard" });
    await makeReady(engine, root, "harden-task-review");
    const started = await engine.startTask({ changeId: "harden-task-review", taskId: "T-001" });
    const task = started.change.tasks["T-001"];
    expect(task?.base_commit).toBeDefined();
    expect(task?.execution_id).toBeDefined();
    const frozenBrief = await readFile(
      path.join(root, ".rockspec", "changes", "harden-task-review", task!.brief_path!),
      "utf8",
    );
    await expect(
      readFile(
        path.join(root, ".rockspec", "changes", "harden-task-review", task!.report_path!),
        "utf8",
      ),
    ).resolves.toContain(`- Brief Hash: ${task!.brief_hash}`);

    await writeFile(path.join(root, "feature.txt"), "implemented\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-001] implement behavior"], { cwd: root });
    await writeFile(path.join(root, "extra.txt"), "outside scope\n");
    await execFileAsync("git", ["add", "extra.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "test: second task commit"], { cwd: root });
    await expect(engine.prepareReviewPackage({
      changeId: "harden-task-review",
      kind: "task",
      taskId: "T-001",
    })).rejects.toMatchObject({ code: "TASK_COMMIT_COUNT" });

    await execFileAsync("git", ["reset", "--soft", task?.base_commit ?? ""], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: [T-001] squash task"], { cwd: root });
    await writeImplementedReport(
      root,
      "harden-task-review",
      "runtime/tasks/T-001/implementer-report.md",
      "Implemented the approved behavior with a reviewed path expansion.",
    );
    const expandedPackage = await engine.prepareReviewPackage({
      changeId: "harden-task-review",
      kind: "task",
      taskId: "T-001",
    });
    expect(expandedPackage.scope).toEqual({
      planned_paths: ["feature.txt"],
      changed_paths: ["extra.txt", "feature.txt"],
      expanded_paths: ["extra.txt"],
    });
    expect(await readFile(
      path.join(root, ".rockspec", "changes", "harden-task-review", expandedPackage.path),
      "utf8",
    )).toContain("Expanded paths\n- extra.txt");
    await writeCodeReview(
      root,
      "harden-task-review",
      "reviews/tasks/T-001-review.md",
      expandedPackage.subject,
    );
    await expect(engine.completeAction({
      changeId: "harden-task-review",
      action: "task.review",
    })).rejects.toMatchObject({
      code: "SCOPE_ASSESSMENT_MISMATCH",
      details: { expected_paths: ["extra.txt"], assessed_paths: [] },
    });

    await rm(path.join(root, "extra.txt"));
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "--amend", "--no-edit"], { cwd: root });
    await writeImplementedReport(
      root,
      "harden-task-review",
      "runtime/tasks/T-001/implementer-report.md",
      "Implemented the approved behavior and ran focused verification.",
    );
    await engine.runCheck({
      changeId: "harden-task-review",
      taskId: "T-001",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await replace(
      root,
      "harden-task-review",
      task!.brief_path!,
      `${frozenBrief}\nTampered after Task start.\n`,
    );
    await expect(engine.prepareReviewPackage({
      changeId: "harden-task-review",
      kind: "task",
      taskId: "T-001",
    })).rejects.toMatchObject({ code: "STALE_TASK_BRIEF" });
    await replace(root, "harden-task-review", task!.brief_path!, frozenBrief);
    const reviewPackage = await engine.prepareReviewPackage({
      changeId: "harden-task-review",
      kind: "task",
      taskId: "T-001",
    });
    await writeCodeReview(
      root,
      "harden-task-review",
      "reviews/tasks/T-001-review.md",
      reviewPackage.subject,
      "PASS",
      task!.execution_id!,
    );
    await expect(engine.completeAction({
      changeId: "harden-task-review",
      action: "task.review",
    })).rejects.toMatchObject({ code: "EXECUTION_NOT_REGISTERED" });

    await replace(
      root,
      "harden-task-review",
      "reviews/tasks/T-001-review.md",
      `---\nschema_version: 1\nverdict: CHANGES_REQUIRED\nreviewer_execution_id: independent-reviewer\nsubject:\n  base_commit: ${reviewPackage.subject.base_commit}\n  head_commit: ${reviewPackage.subject.head_commit}\n  diff_hash: ${reviewPackage.subject.diff_hash}\nround: 0\nfindings:\n  - id: F-001\n    severity: important\n    category: test-quality\n    evidence: feature.txt:1\n    description: Regression coverage is incomplete.\n    owner_domain: implementation\n    route_to: task.execute\n    status: open\n---\n\n# Review\n\nVerdict: CHANGES_REQUIRED\n`,
    );
    await bindExecutionInArtifact(root, "harden-task-review", "reviews/tasks/T-001-review.md", "independent-reviewer", "task.review", "task_reviewer");
    const reviewed = await engine.completeAction({
      changeId: "harden-task-review",
      action: "task.review",
      verdict: "CHANGES_REQUIRED",
    });
    expect(reviewed.current_state).toBe("IMPLEMENTING");
    expect(reviewed.change.reviews["task:T-001"]).toMatchObject({
      verdict: "CHANGES_REQUIRED",
      findings: [expect.objectContaining({ id: "F-001", status: "open" })],
    });
    expect(reviewed.change.completed_actions).not.toContain("task.review");
    await expect(engine.completeAction({
      changeId: "harden-task-review",
      action: "task.review",
      verdict: "CHANGES_REQUIRED",
    })).rejects.toMatchObject({
      code: "REVIEW_ROUND_MISMATCH",
      details: { expected_round: 1, reported_round: 0 },
    });
  }, 30_000);

  it("archives a completed Change and preserves global ID uniqueness", async () => {
    const root = await repository();
    const fixed = new Date("2026-08-10T12:00:00.000Z");
    const engine = new RockSpecEngine({ cwd: root, now: () => fixed });
    await engine.init();
    await engine.newChange({ id: "fix-login-copy", profile: "lite", kind: "copy" });
    await replace(root, "fix-login-copy", "brief.md", "# Fix login copy\n\n## Scope\n\nFix one label.\n\n## Verification\n\nRun focused tests.\n");
    await engine.apply({ changeId: "fix-login-copy" });
    await engine.runCheck({
      changeId: "fix-login-copy",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const verified = await engine.verify({ changeId: "fix-login-copy" });
    const deliveryHead = verified.change.delivery_head!;
    await writeFile(path.join(root, "downstream-change.txt"), "belongs to the next Change\n");
    await execFileAsync("git", ["add", "downstream-change.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: downstream Change commit"], { cwd: root });
    await writeNoChangeKnowledgeDelta(root, "fix-login-copy");
    await engine.completeAction({ changeId: "fix-login-copy", action: "knowledge.evolve" });
    const pending = await engine.finish({ changeId: "fix-login-copy", disposition: "push" });
    expect(pending.change.finish_disposition).toMatchObject({
      choice: "push",
      status: "pending_external_action",
    });
    expect(pending.change.finished_at).toBeUndefined();
    await expect(engine.archive({ changeId: "fix-login-copy" })).rejects.toMatchObject({ code: "ARCHIVE_GATE_FAILED" });
    const finished = await engine.finish({
      changeId: "fix-login-copy",
      disposition: "push",
      executed: true,
      resultRef: "refs/heads/rockspec/fix-login-copy",
      resultCommit: deliveryHead,
    });
    expect(finished.change.finish_disposition).toMatchObject({
      choice: "push",
      status: "completed",
      result_ref: "refs/heads/rockspec/fix-login-copy",
      result_commit: deliveryHead,
    });
    const archived = await engine.archive({ changeId: "fix-login-copy" });
    expect(archived.current_state).toBe("ARCHIVED");
    expect(archived.archive_path).toBe(path.join(root, ".rockspec", "archive", "2026", "08", "fix-login-copy"));
    await expect(readFile(
      path.join(root, ".rockspec", "knowledge", ".evolution", "fix-login-copy.yaml"),
      "utf8",
    )).resolves.toContain("status: no_change");
    await expect(engine.newChange({ id: "fix-login-copy", profile: "lite", kind: "copy" }))
      .rejects.toMatchObject({ code: "CHANGE_ID_CONFLICT" });
  });

  it("rejects Finish when rewritten history drops the frozen delivery Commit", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    const id = "preserve-delivery-lineage";
    await engine.newChange({ id, profile: "lite", kind: "copy" });
    await replace(root, id, "brief.md", "# Delivery lineage\n\n## Scope\n\nPreserve one verified label.\n\n## Verification\n\nRun the focused check.\n");
    await engine.apply({ changeId: id });
    await writeFile(path.join(root, "delivery.txt"), "verified delivery\n");
    await execFileAsync("git", ["add", "delivery.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: verified delivery"], { cwd: root });
    await engine.runCheck({ changeId: id, executable: process.execPath, args: ["-e", "process.exit(0)"] });
    const verified = await engine.verify({ changeId: id });
    const deliveryHead = verified.change.delivery_head!;
    await writeNoChangeKnowledgeDelta(root, id);
    await engine.completeAction({ changeId: id, action: "knowledge.evolve" });
    const parent = (await execFileAsync("git", ["rev-parse", `${deliveryHead}^`], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["reset", "--hard", parent], { cwd: root });
    await writeFile(path.join(root, "diverged.txt"), "rewritten history\n");
    await execFileAsync("git", ["add", "diverged.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat: divergent delivery"], { cwd: root });
    await expect(engine.finish({ changeId: id })).rejects.toMatchObject({ code: "DELIVERY_HISTORY_DIVERGED" });
  });

  it("applies derived knowledge without an independent Review and returns an idempotent receipt", async () => {
    const root = await repository();
    const fixed = new Date("2026-08-21T09:30:00.000Z");
    const engine = new RockSpecEngine({ cwd: root, now: () => fixed });
    await engine.init();
    await engine.newChange({ id: "standardize-form-feedback", profile: "lite", kind: "copy" });
    await replace(
      root,
      "standardize-form-feedback",
      "brief.md",
      "# Standardize form feedback\n\n## Scope\n\nAdd a verified form state pattern.\n\n## Verification\n\nRun focused tests.\n",
    );
    await engine.apply({ changeId: "standardize-form-feedback" });
    await engine.runCheck({
      changeId: "standardize-form-feedback",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const verified = await engine.verify({ changeId: "standardize-form-feedback" });
    expect(verified.recommended_next).toMatchObject({
      action: "knowledge.evolve",
      entry_skill: "rockspec-evolve",
    });
    await expect(engine.finish({ changeId: "standardize-form-feedback", disposition: "keep" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_EVOLUTION_REQUIRED" });

    await replace(
      root,
      "standardize-form-feedback",
      "knowledge-delta.md",
      `---\nschema_version: 1\nchange_id: standardize-form-feedback\nauthor_execution_id: knowledge-author\noutcome: proposed\nupdates:\n  - target: experience/form-feedback.md\n    operation: new\n    authority: derived\n    summary: Preserve the verified async form feedback pattern.\n    sources:\n      - brief.md#Scope\n      - evidence/verification.yaml\n---\n\n# Knowledge Delta\n\nPromote the verified reusable pattern.\n`,
    );
    await bindExecutionInArtifact(
      root,
      "standardize-form-feedback",
      "knowledge-delta.md",
      "knowledge-author",
      "knowledge.evolve.author",
      "knowledge_author",
    );
    const deltaPath = path.join(root, ".rockspec", "changes", "standardize-form-feedback", "knowledge-delta.md");
    const validDelta = await readFile(deltaPath, "utf8");
    await writeFile(deltaPath, validDelta.replace("brief.md#Scope", "missing-source.md#Scope"));
    await expect(engine.prepareKnowledgePackage({ changeId: "standardize-form-feedback" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_SOURCE_MISSING" });
    await writeFile(deltaPath, validDelta);
    const candidateDir = path.join(
      root,
      ".rockspec",
      "changes",
      "standardize-form-feedback",
      "knowledge",
      "updates",
      "experience",
    );
    await mkdir(candidateDir, { recursive: true });
    await writeFile(
      path.join(candidateDir, "form-feedback.md"),
      "# Form Feedback\n\nAsync forms must expose pending, success, and error feedback without shifting layout.\n",
    );
    const prepared = await engine.prepareKnowledgePackage({ changeId: "standardize-form-feedback" });
    expect(prepared).toMatchObject({
      already_evolved: false,
      status: "pending",
      review_required: false,
      requires_human_approval: false,
      semantic_warnings: [{
        code: "POSSIBLE_NORMATIVE_MODAL_CHANGE",
        target: "experience/form-feedback.md",
        before_markers: [],
        after_markers: ["must"],
      }],
    });
    expect(prepared.review_path).toBeUndefined();
    await expect(engine.startExecution({
      changeId: "standardize-form-feedback",
      action: "knowledge.evolve.review",
      role: "knowledge_reviewer",
    })).rejects.toMatchObject({ code: "KNOWLEDGE_REVIEW_NOT_REQUIRED" });
    const evolved = await engine.completeAction({
      changeId: "standardize-form-feedback",
      action: "knowledge.evolve",
    });
    expect(evolved.change.knowledge_evolution.status).toBe("approved");
    expect(evolved.change.knowledge_evolution.review).toBeUndefined();
    await expect(engine.prepareKnowledgePackage({ changeId: "standardize-form-feedback" }))
      .resolves.toMatchObject({ already_evolved: true, status: "approved" });
    await engine.finish({ changeId: "standardize-form-feedback", disposition: "keep" });
    await engine.archive({ changeId: "standardize-form-feedback" });

    await expect(readFile(
      path.join(root, ".rockspec", "knowledge", "experience", "form-feedback.md"),
      "utf8",
    )).resolves.toContain("pending, success, and error");
    await expect(engine.prepareKnowledgePackage({ changeId: "standardize-form-feedback" }))
      .resolves.toMatchObject({ already_evolved: true, status: "applied" });
    const canonicalReceipt = parse(await readFile(
      path.join(root, ".rockspec", "knowledge", ".evolution", "standardize-form-feedback.yaml"),
      "utf8",
    )) as { status?: string; applied_at?: string };
    expect(canonicalReceipt).toMatchObject({ status: "applied", applied_at: fixed.toISOString() });
  });

  it("keeps independent Review mandatory for normative knowledge", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    const id = "establish-shared-form-rule";
    await engine.init();
    await engine.newChange({ id, profile: "lite", kind: "copy" });
    await replace(root, id, "brief.md", "# Shared form rule\n\n## Scope\n\nEstablish one reusable rule.\n\n## Verification\n\nRun focused tests.\n");
    await engine.apply({ changeId: id });
    await engine.runCheck({ changeId: id, executable: process.execPath, args: ["-e", "process.exit(0)"] });
    await engine.verify({ changeId: id });
    await replace(
      root,
      id,
      "knowledge-delta.md",
      `---\nschema_version: 1\nchange_id: ${id}\nauthor_execution_id: knowledge-author\noutcome: proposed\nupdates:\n  - target: experience/shared-form-rule.md\n    operation: new\n    authority: normative\n    summary: Establish the shared form rule.\n    sources:\n      - brief.md#Scope\napproval:\n  approved_by: product-owner\n  approved_at: 2026-08-26T00:00:00.000Z\n---\n\n# Knowledge Delta\n\nEstablish a rule for future Changes.\n`,
    );
    await bindExecutionInArtifact(root, id, "knowledge-delta.md", "knowledge-author", "knowledge.evolve.author", "knowledge_author");
    const candidateDir = path.join(root, ".rockspec", "changes", id, "knowledge", "updates", "experience");
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, "shared-form-rule.md"), "# Shared Form Rule\n\nFuture forms MUST preserve stable feedback layout.\n");

    const prepared = await engine.prepareKnowledgePackage({ changeId: id });
    expect(prepared).toMatchObject({
      review_required: true,
      review_path: "reviews/knowledge-review.md",
      requires_human_approval: true,
    });
    await expect(engine.completeAction({ changeId: id, action: "knowledge.evolve" }))
      .rejects.toMatchObject({ code: "MISSING_ARTIFACT" });

    await writeKnowledgeReview(root, id, {
      source_digest: prepared.source_digest,
      delta_hash: prepared.delta_hash!,
      baseline_hashes: prepared.baseline_hashes,
      candidate_hashes: prepared.candidate_hashes,
    });
    const evolved = await engine.completeAction({ changeId: id, action: "knowledge.evolve" });
    expect(evolved.change.knowledge_evolution).toMatchObject({
      status: "approved",
      review: { report_path: "reviews/knowledge-review.md" },
      approval: { approved_by: "product-owner" },
    });
  });

  it("rejects a second active Change in one workspace and detects nested roots", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "fix-first-case", profile: "lite", kind: "copy" });
    await expect(engine.newChange({ id: "fix-second-case", profile: "lite", kind: "copy" }))
      .rejects.toMatchObject({ code: "WORKSPACE_ALREADY_BOUND" });
    await expect(engine.getStatus()).resolves.toMatchObject({ change: { id: "fix-first-case" } });

    const child = path.join(root, "packages", "nested");
    await mkdir(path.join(child, ".rockspec"), { recursive: true });
    const nested = new RockSpecEngine({ cwd: child });
    await expect(nested.getStatus({ changeId: "fix-first-case" })).rejects.toSatisfy((error: unknown) =>
      error instanceof RockSpecError && error.code === "NESTED_ROCKSPEC_ROOT",
    );
  });

  it("binds managed Changes to one linked Worktree and rejects cross-worktree duplicates", async () => {
    const root = await repository();
    const primary = new RockSpecEngine({ cwd: root });
    await primary.init();
    await execFileAsync("git", ["add", ".rockspec/config.yaml"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "test: add RockSpec config"], { cwd: root });

    const firstRoot = path.join(root, ".worktrees", "add-export");
    await execFileAsync("git", ["worktree", "add", firstRoot, "-b", "rockspec/add-export", "main"], {
      cwd: root,
    });
    const first = new RockSpecEngine({ cwd: firstRoot });
    const created = await first.newChange({
      id: "add-export",
      profile: "standard",
      baseRef: "main",
      workspaceManaged: true,
    });
    expect(created.change.workspace).toEqual({
      mode: "worktree",
      branch: "rockspec/add-export",
      managed: true,
    });
    expect(created.change.base_ref).toBe("main");

    const secondRoot = path.join(root, ".worktrees", "other-change");
    await execFileAsync("git", ["worktree", "add", secondRoot, "-b", "rockspec/other-change", "main"], {
      cwd: root,
    });
    const second = new RockSpecEngine({ cwd: secondRoot });
    await expect(second.newChange({ id: "add-export", profile: "lite", kind: "copy", workspaceManaged: true }))
      .rejects.toMatchObject({ code: "CHANGE_ID_CONFLICT" });

    await execFileAsync("git", ["checkout", "--detach"], { cwd: firstRoot });
    const status = await first.getStatus({ changeId: "add-export" });
    expect(status.blocked_by).toContainEqual(expect.objectContaining({
      code: "WORKSPACE_BRANCH_MISMATCH",
    }));
    await expect(first.promote({ changeId: "add-export", profile: "strict" }))
      .rejects.toMatchObject({ code: "WORKSPACE_BRANCH_MISMATCH" });
  });

  it("requires two independent reviewers plus the aggregate review in Strict", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "secure-payment-retry", profile: "strict" });
    await materializeRequirements(root, "secure-payment-retry");
    await engine.completeAction({ changeId: "secure-payment-retry", action: "requirements.clarify" });
    await passReview(root, "secure-payment-retry", "reviews/requirements-review.md");
    await passReview(root, "secure-payment-retry", "reviews/requirements-review-reviewer-1.md");
    await rm(
      path.join(
        root,
        ".rockspec",
        "changes",
        "secure-payment-retry",
        "reviews",
        "requirements-review-reviewer-2.md",
      ),
    );
    await expect(
      engine.completeAction({ changeId: "secure-payment-retry", action: "requirements.review" }),
    ).rejects.toMatchObject({ code: "MISSING_REVIEW" });

    await passReview(root, "secure-payment-retry", "reviews/requirements-review-reviewer-2.md");
    await engine.completeAction({ changeId: "secure-payment-retry", action: "requirements.review" });
    const approved = await approveGate(engine, "secure-payment-retry", "spec");
    expect(approved.current_state).toBe("SPEC_APPROVED");
  });

  it("rejects a Requirements Review that predates the current Spec", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "add-audit-export", profile: "standard" });
    await materializeRequirements(root, "add-audit-export");
    await engine.completeAction({ changeId: "add-audit-export", action: "requirements.clarify" });
    await passReview(root, "add-audit-export", "reviews/requirements-review.md");
    await engine.completeAction({ changeId: "add-audit-export", action: "requirements.review" });
    await replace(
      root,
      "add-audit-export",
      "proposal.md",
      "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\n## Why\n\nAuditors need exports.\n\n## What\n\nAdd an observable audit export with explicit scope.\n",
    );
    await expect(
      (async () => {
        const approvalPackage = await engine.prepareApproval({ changeId: "add-audit-export", gate: "spec" });
        return engine.approve({ changeId: "add-audit-export", gate: "spec", approvedBy: "tester", packageHash: approvalPackage.hash });
      })(),
    ).rejects.toMatchObject({ code: "STALE_REVIEW" });
  });

  it("rejects an empty required artifact directory", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "add-empty-check", profile: "standard" });
    await replace(
      root,
      "add-empty-check",
      "proposal.md",
      "# Proposal\n\n## Why\n\nValidate empty directories.\n\n## What\n\nReject incomplete artifacts.\n",
    );
    await rm(path.join(root, ".rockspec", "changes", "add-empty-check", "specs", "change", "spec.md"));
    await expect(
      engine.completeAction({ changeId: "add-empty-check", action: "requirements.clarify" }),
    ).rejects.toMatchObject({ code: "MISSING_ARTIFACT" });
  });

  it("returns structured invalid results for premature and unknown Gates", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "add-gate-check", profile: "standard" });
    const premature = await engine.gate({ changeId: "add-gate-check", gate: "spec" });
    expect(premature.valid).toBe(false);
    expect(premature.errors).toContainEqual(expect.objectContaining({ code: "GATE_STATE" }));
    const unknown = await engine.gate({ changeId: "add-gate-check", gate: "unknown" });
    expect(unknown.valid).toBe(false);
    expect(unknown.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_GATE" }));
  });

  it("promotes Lite to Standard without losing the original Brief", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "rename-account-label", profile: "lite", kind: "copy" });
    const brief = "# Rename account label\n\n## Scope\n\nRename the visible label only.\n\n## Verification\n\nRun the focused UI test.\n";
    await replace(root, "rename-account-label", "brief.md", brief);

    const promoted = await engine.promote({
      changeId: "rename-account-label",
      profile: "standard",
    });

    expect(promoted.change.profile).toBe("standard");
    expect(promoted.current_state).toBe("SCOPING");
    await expect(
      readFile(path.join(root, ".rockspec", "changes", "rename-account-label", "brief.md"), "utf8"),
    ).resolves.toBe(brief);
    await expect(
      readFile(path.join(root, ".rockspec", "changes", "rename-account-label", "proposal.md"), "utf8"),
    ).resolves.toContain("# 需求提案");
  });

  it("routes acceptance feedback back into the same Change and preserves a frozen parent boundary", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root, availableProviders: new Set(["ui-ux-pro-max"]) });
    await engine.init();
    const created = await engine.newChange({ id: "feedback-parent", profile: "standard" });
    const baseCommit = created.change.base_commit;
    if (!baseCommit) throw new Error("Expected a base commit");
    const snapshotPath = path.join(root, ".rockspec", "changes", "feedback-parent", "change.yaml");
    const snapshot = parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.state = "READY_TO_FINISH";
    snapshot.verification = { status: "passed", commit: baseCommit, verified_at: new Date().toISOString() };
    snapshot.delivery_head = baseCommit;
    await writeFile(snapshotPath, stringify(snapshot));

    const routed = await engine.submitFeedback({
      changeId: "feedback-parent",
      route: "same_change",
      interactionMode: "compact",
      reason: "Acceptance found a behavior adjustment.",
      items: ["The result should be visible after reset.", "The empty state should be explicit."],
      target: "requirements",
      affectedIds: ["R-001"],
    });
    expect(routed.change.state).toBe("SCOPING");
    expect(routed.change.revisions[0]?.mode).toBe("feedback_reopen");
    expect(routed.change.revisions[0]?.interaction_mode).toBe("compact");
    expect(routed.change.revisions[0]?.approval_policy).toBe("human");
    expect(routed.change.revisions[0]?.authority_delta).toBe("changed");
    expect(routed.change.revisions[0]?.trigger).toBeUndefined();
    expect(routed.change.feedback_batches[0]?.revision_id).toBe("RV-001");
    expect(routed.change.delivery_head).toBeUndefined();

    const parentSnapshot = parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    parentSnapshot.state = "READY_TO_FINISH";
    parentSnapshot.verification = { status: "passed", commit: baseCommit, verified_at: new Date().toISOString() };
    parentSnapshot.delivery_head = baseCommit;
    await writeFile(snapshotPath, stringify(parentSnapshot));
    const child = await engine.newChange({
      id: "feedback-child",
      profile: "lite",
      kind: "copy",
      basedOnChange: "feedback-parent",
      reuseWorkspace: true,
    });
    expect(child.change.based_on_change).toBe("feedback-parent");
    expect(child.change.parent_delivery_head).toBe(baseCommit);
    expect(child.change.base_commit).toBe(baseCommit);
  });

  it("grades same-Change feedback without weakening approval or review policy", async () => {
    const prepareFeedbackChange = async (id: string, withAuthorityBaseline = false): Promise<RockSpecEngine> => {
      const root = await repository();
      const engine = new RockSpecEngine({ cwd: root });
      await engine.init();
      const created = await engine.newChange({ id, profile: "standard" });
      const baseCommit = created.change.base_commit;
      if (!baseCommit) throw new Error("Expected a base commit");
      const snapshotPath = path.join(root, ".rockspec", "changes", id, "change.yaml");
      const snapshot = parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
      snapshot.state = "READY_TO_FINISH";
      snapshot.verification = { status: "passed", commit: baseCommit, verified_at: new Date().toISOString() };
      snapshot.delivery_head = baseCommit;
      if (withAuthorityBaseline) {
        const authorityHash = `sha256:${"a".repeat(64)}`;
        snapshot.approvals = {
          spec: {
            gate: "spec",
            artifact_hashes: { "specs/reset/spec.md": authorityHash },
            aggregate_hash: authorityHash,
            approved_by: "product-owner",
            approved_at: new Date().toISOString(),
            mode: "human",
          },
        };
      }
      await writeFile(snapshotPath, stringify(snapshot));
      return engine;
    };

    const reconcileEngine = await prepareFeedbackChange("feedback-reconcile", true);
    const reconciled = await reconcileEngine.submitFeedback({
      changeId: "feedback-reconcile",
      route: "same_change",
      interactionMode: "reconcile",
      reason: "Restore behavior already fixed by the approved Spec.",
      items: ["Restore the approved reset result."],
      target: "requirements",
      affectedIds: ["R-001"],
      authorExecutionId: "feedback-author",
    });
    expect(reconciled.change.feedback_batches[0]?.interaction_mode).toBe("reconcile");
    expect(reconciled.change.revisions[0]).toMatchObject({
      interaction_mode: "reconcile",
      classifications: ["consistency_fix"],
      authority_delta: "unchanged",
      approval_policy: "auto",
      author_execution_id: "feedback-author",
    });

    const noBaselineEngine = await prepareFeedbackChange("feedback-no-baseline");
    await expect(noBaselineEngine.submitFeedback({
      changeId: "feedback-no-baseline",
      route: "same_change",
      interactionMode: "reconcile",
      reason: "Attempt to reconcile without approved authority.",
      items: ["Restore behavior."],
      target: "requirements",
      affectedIds: ["R-001"],
      authorExecutionId: "feedback-author",
    })).rejects.toMatchObject({ code: "FEEDBACK_AUTHORITY_BASELINE_REQUIRED" });

    const fullEngine = await prepareFeedbackChange("feedback-full");
    const full = await fullEngine.submitFeedback({
      changeId: "feedback-full",
      route: "same_change",
      interactionMode: "full",
      reason: "Acceptance exposed a product choice that needs exploration.",
      items: ["Choose how reset behaves for retained drafts."],
      target: "requirements",
      affectedIds: ["R-001"],
    });
    expect(full.change.revisions[0]).toMatchObject({
      interaction_mode: "full",
      classifications: ["decision_change"],
      authority_delta: "changed",
      approval_policy: "human",
    });

    await expect(fullEngine.submitFeedback({
      changeId: "feedback-full",
      route: "same_change",
      interactionMode: "reconcile",
      reason: "Missing author identity.",
      items: ["Restore approved behavior."],
      target: "requirements",
      affectedIds: ["R-001"],
    })).rejects.toMatchObject({ code: "REVISION_AUTHOR_REQUIRED" });
  });
});
