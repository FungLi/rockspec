import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { parse } from "yaml";
import type { RockSpecEngine } from "@rockspec/engine";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];
const sourceRoot = process.cwd();

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })),
  );
});

async function createRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rockspec-cli-")));
  repositories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "cli-test@rockspec.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RockSpec CLI Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: initial"], { cwd: root });
  return root;
}

async function run(root: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  json: Record<string, unknown> | undefined;
}> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const program = createProgram({
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    setExitCode: (value) => { exitCode = value; },
  });
  await program.parseAsync(["node", "rockspec", "--cwd", root, "--json", ...args]);
  const serialized = stdout.trim() || stderr.trim();
  return {
    stdout,
    stderr,
    exitCode,
    json: serialized ? JSON.parse(serialized) as Record<string, unknown> : undefined,
  };
}

async function runWithEngine(
  root: string,
  args: string[],
  engine: Partial<Pick<RockSpecEngine, "revise" | "amendRevision" | "applyRecovery" | "completeExecution" | "prepareReconciliation" | "completeReconciliation" | "submitFeedback">>,
): Promise<{ stdout: string; stderr: string; exitCode: number; json: Record<string, unknown> | undefined }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const program = createProgram({
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    setExitCode: (value) => { exitCode = value; },
    engineFactory: () => engine as RockSpecEngine,
  });
  await program.parseAsync(["node", "rockspec", "--cwd", root, "--json", ...args]);
  const serialized = stdout.trim() || stderr.trim();
  return {
    stdout,
    stderr,
    exitCode,
    json: serialized ? JSON.parse(serialized) as Record<string, unknown> : undefined,
  };
}

async function writeArtifact(
  root: string,
  changeId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(root, ".rockspec", "changes", changeId, relativePath), content);
}

async function writeImplementedReport(root: string, changeId: string, relativePath: string, body: string): Promise<void> {
  const current = await readFile(path.join(root, ".rockspec", "changes", changeId, relativePath), "utf8");
  const frontmatterEnd = current.indexOf("\n---\n", 4);
  if (!current.startsWith("---\n") || frontmatterEnd < 0) throw new Error(`Missing generated report metadata in ${relativePath}`);
  await writeArtifact(root, changeId, relativePath, `${current.slice(0, frontmatterEnd + 5)}\n# Implementer Report\n\n${body}\n`);
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

async function writeCodeReview(
  root: string,
  changeId: string,
  relativePath: string,
  subject: { base_commit: string; head_commit: string; diff_hash: string },
  _reviewerExecutionId?: string,
): Promise<void> {
  const action = relativePath.includes("delivery") ? "delivery.review" : "task.review";
  const role = relativePath.includes("delivery") ? "delivery_reviewer" : "task_reviewer";
  const taskId = /^reviews\/tasks\/(T-\d{3,})-review\.md$/.exec(relativePath)?.[1];
  const packagePath = action === "delivery.review"
    ? `runtime/reviews/delivery-${subject.base_commit.slice(0, 7)}..${subject.head_commit.slice(0, 7)}.diff`
    : `runtime/reviews/task-${taskId}-${subject.base_commit.slice(0, 7)}..${subject.head_commit.slice(0, 7)}.diff`;
  const packageContent = await readFile(path.join(root, ".rockspec", "changes", changeId, packagePath));
  const reviewerExecutionId = await startExecutionCli(root, changeId, action, role, {
    path: packagePath,
    hash: `sha256:${createHash("sha256").update(packageContent).digest("hex")}`,
  });
  await writeArtifact(
    root,
    changeId,
    relativePath,
    `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${reviewerExecutionId}\nsubject:\n  base_commit: ${subject.base_commit}\n  head_commit: ${subject.head_commit}\n  diff_hash: ${subject.diff_hash}\nround: 0\nscope_assessment: []\nfindings: []\n---\n\n# Review\n\nVerdict: PASS\n`,
  );
}

async function startExecutionCli(
  root: string,
  changeId: string,
  action: string,
  role: string,
  context?: { path: string; hash: string },
): Promise<string> {
  const result = await run(root, [
    "execution", "start", action, changeId, "--role", role,
    ...(context ? ["--context-package", context.path, "--context-hash", context.hash] : []),
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  return ((result.json?.data as { started_execution: { id: string } }).started_execution.id);
}

async function writeStageReview(
  root: string,
  changeId: string,
  relativePath: string,
  action: "requirements.review" | "readiness.review",
): Promise<void> {
  const role = action === "requirements.review" ? "requirements_reviewer" : "readiness_reviewer";
  const executionId = await startExecutionCli(root, changeId, action, role);
  await writeArtifact(
    root,
    changeId,
    relativePath,
    `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${executionId}\nfindings: []\n---\n\n# Review\n\nVerdict: PASS\n`,
  );
}

async function approveCli(root: string, changeId: string, gate: "spec" | "design" | "implementation") {
  const prepared = await run(root, ["approval", "package", gate, changeId]);
  expect(prepared.exitCode, prepared.stderr).toBe(0);
  const hash = (prepared.json?.data as { hash: string }).hash;
  return run(root, ["approve", gate, changeId, "--package", hash]);
}

describe("rockspec CLI", () => {
  it("collects the first and repeated feedback items without an undefined accumulator", async () => {
    const root = await createRepository();
    let received: Parameters<RockSpecEngine["submitFeedback"]>[0] | undefined;
    const result = await runWithEngine(root, [
      "feedback", "submit", "feedback-parser",
      "--reason", "Acceptance feedback",
      "--item", "First adjustment",
      "--item", "Second adjustment",
      "--interaction", "compact",
      "--target", "requirements",
      "--affected", "R-001",
    ], {
      submitFeedback: async (input) => {
        received = input;
        return { current_state: "SCOPING" } as Awaited<ReturnType<RockSpecEngine["submitFeedback"]>>;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(received).toEqual({
      changeId: "feedback-parser",
      route: "same_change",
      interactionMode: "compact",
      reason: "Acceptance feedback",
      items: ["First adjustment", "Second adjustment"],
      target: "requirements",
      affectedIds: ["R-001"],
      submittedBy: "user",
    });
  });

  it("returns compact status by default and accepts the --change compatibility alias", async () => {
    const root = await createRepository();
    expect((await run(root, ["init"])).exitCode).toBe(0);
    expect((await run(root, ["new", "compact-status", "--kind", "copy"])).exitCode).toBe(0);

    const summary = await run(root, ["status", "--change", "compact-status"]);
    expect(summary.json).toMatchObject({
      ok: true,
      command: "status",
      data: {
        view: "summary",
        change_id: "compact-status",
        change: { id: "compact-status", task_counts: {} },
      },
    });
    expect((summary.json?.data as Record<string, unknown>).evidence).toBeUndefined();

    const resume = await run(root, ["status", "compact-status", "--view", "resume"]);
    expect(resume.json).toMatchObject({
      ok: true,
      data: {
        view: "resume",
        change_id: "compact-status",
        remaining_tasks: [],
        open_executions: [],
        resume_note: expect.stringContaining("Engine 已持久化状态"),
      },
    });

    const full = await run(root, ["status", "compact-status", "--full"]);
    expect(full.json).toMatchObject({
      data: { current_state: "SCOPING", change: { id: "compact-status", evidence: [] } },
    });

    const conflict = await run(root, ["status", "compact-status", "--change", "another-change"]);
    expect(conflict.json).toMatchObject({ ok: false, error: { code: "CHANGE_ID_CONFLICT" } });

    await writeArtifact(
      root,
      "compact-status",
      "brief.md",
      "# Compact status\n\n## Scope\n\nUpdate copy only.\n\n## Verification\n\nRun the focused copy check.\n",
    );
    expect((await run(root, [
      "--summary", "action", "complete", "change.triage", "compact-status",
    ])).json).toMatchObject({
      data: {
        view: "summary",
        change_id: "compact-status",
        current_state: "IMPLEMENTING",
      },
    });
  });

  it("installs non-interactively, validates the project Runtime, and uninstalls conservatively", async () => {
    const root = await createRepository();
    const installed = await run(root, [
      "install",
      "--project", root,
      "--source-root", sourceRoot,
      "--hosts", "codex,claude",
      "--without", "ui.prototype",
      "--yes",
    ]);
    expect(installed.exitCode).toBe(0);
    expect(installed.json).toMatchObject({
      ok: true,
      command: "install",
      data: {
        project_root: root,
        hosts: ["codex", "claude"],
        dry_run: false,
      },
    });

    expect((await run(root, ["doctor", "--project", root])).json).toMatchObject({
      ok: true,
      command: "doctor",
      data: { valid: true, project_root: root },
    });

    const runtimePath = path.join(root, ".rockspec", "bin", "rockspec.mjs");
    const runtime = await execFileAsync(process.execPath, [
      runtimePath,
      "--json",
      "doctor",
      "--project", root,
    ], { cwd: root });
    expect(JSON.parse(runtime.stdout)).toMatchObject({
      ok: true,
      command: "doctor",
      data: { valid: true },
    });

    const uninstalled = await run(root, ["uninstall", "--project", root, "--yes"]);
    expect(uninstalled.json).toMatchObject({
      ok: true,
      command: "uninstall",
      data: {
        project_root: root,
        removed: expect.arrayContaining([".rockspec/bin/rockspec.mjs"]),
      },
    });
    await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, ".rockspec", "config.yaml"), "utf8"))
      .resolves.toContain("schema_version");
  });

  it("returns a structured error when the interactive installer has no TTY", async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    const root = await createRepository();
    const result = await run(root, []);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      command: "install",
      error: { code: "INTERACTIVE_REQUIRED" },
    });
  });

  it("runs an auto-triaged Lite change through archive in a real Git repository", async () => {
    const root = await createRepository();

    expect((await run(root, ["init"])).json).toMatchObject({
      schema_version: 1,
      ok: true,
      command: "init",
    });

    const created = await run(root, [
      "new",
      "rename-submit-button",
      "--title",
      "Rename submit button",
      "--kind",
      "copy",
    ]);
    expect(created.exitCode).toBe(0);
    expect(created.json).toMatchObject({
      ok: true,
      data: {
        current_state: "SCOPING",
        change: {
          workspace: { mode: "current", branch: "main", managed: false },
        },
        recommended_next: { entry_skill: "rockspec-triage", action: "change.triage" },
        triage: { profile: "lite", minimumProfile: "lite" },
      },
    });
    await writeFile(
      path.join(root, ".rockspec", "changes", "rename-submit-button", "brief.md"),
      "# Rename submit button\n\n## Scope\n\nRename only the submit button label.\n\n## Verification\n\nRun the focused button test.\n",
    );

    const triaged = await run(root, [
      "action",
      "complete",
      "change.triage",
      "rename-submit-button",
    ]);
    expect(triaged.json).toMatchObject({ data: { current_state: "IMPLEMENTING" } });

    const evidence = await run(root, [
      "check", "run", "--change", "rename-submit-button", "--",
      process.execPath, "-e", "process.exit(0)",
    ]);
    expect(evidence.exitCode).toBe(0);

    expect((await run(root, ["verify", "rename-submit-button"])).json).toMatchObject({
      data: {
        current_state: "READY_TO_FINISH",
        recommended_next: { action: "knowledge.evolve", entry_skill: "rockspec-evolve" },
      },
    });
    const knowledgeAuthor = await startExecutionCli(
      root,
      "rename-submit-button",
      "knowledge.evolve.author",
      "knowledge_author",
    );
    await writeArtifact(
      root,
      "rename-submit-button",
      "knowledge-delta.md",
      `---\nschema_version: 1\nchange_id: rename-submit-button\nauthor_execution_id: ${knowledgeAuthor}\noutcome: no_change\nupdates: []\n---\n\n# Knowledge Delta\n\nNo reusable knowledge.\n`,
    );
    expect((await run(root, ["knowledge", "package", "rename-submit-button"])).json).toMatchObject({
      data: { already_evolved: false, status: "pending", candidate_hashes: {} },
    });
    expect((await run(root, ["action", "complete", "knowledge.evolve", "rename-submit-button"])).json)
      .toMatchObject({ data: { change: { knowledge_evolution: { status: "no_change" } } } });
    expect((await run(root, ["finish", "rename-submit-button"])).exitCode).toBe(0);
    expect((await run(root, ["archive", "rename-submit-button"])).json).toMatchObject({
      data: { current_state: "ARCHIVED" },
    });
  });

  it("returns versioned protocol errors for a forbidden risk downgrade", async () => {
    const root = await createRepository();
    await run(root, ["init"]);

    const result = await run(root, [
      "new",
      "fix-payment-copy",
      "--kind",
      "payment",
      "--profile",
      "lite",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.json).toMatchObject({
      schema_version: 1,
      ok: false,
      command: "new",
      error: {
        code: "ROCKSPEC_PROTOCOL_VALIDATION_ERROR",
        details: [expect.objectContaining({ code: "profile_downgrade_forbidden" })],
      },
    });
  });

  it("opens a controlled Revision through the CLI", async () => {
    const root = await createRepository();
    const id = "simplify-costly-behavior";
    await run(root, ["init"]);
    await run(root, ["new", id, "--profile", "standard"]);
    await writeArtifact(root, id, "proposal.md", "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\n## Why\n\nUsers need the behavior.\n");
    await writeArtifact(root, id, "specs/change/spec.md", "## ADDED Requirements\n\n### R-001 Requirement: Costly behavior\n\nThe system MUST provide it.\n\n#### S-001 Scenario: Success\n\n- GIVEN a user\n- WHEN they request it\n- THEN it succeeds\n");
    await run(root, ["action", "complete", "requirements.clarify", id]);
    await writeStageReview(root, id, "reviews/requirements-review.md", "requirements.review");
    await run(root, ["action", "complete", "requirements.review", id, "--verdict", "PASS"]);
    await approveCli(root, id, "spec");

    const revision = await run(root, [
      "revise", id,
      "--source", "design.technical",
      "--target", "requirements",
      "--reason", "The approved behavior is disproportionately expensive",
      "--affected", "R-001",
      "--affected", "S-001",
    ]);
    expect(revision.exitCode).toBe(0);
    expect(revision.json).toMatchObject({
      ok: true,
      command: "revise",
      data: {
        current_state: "SCOPING",
        recommended_next: { action: "requirements.clarify", entry_skill: "rockspec-requirements" },
        change: {
          approvals: {},
          revisions: [{ id: "RV-001", target: "requirements", status: "open" }],
        },
      },
    });
    await expect(readFile(path.join(root, ".rockspec", "changes", id, "revisions", "RV-001", "before", "proposal.md"), "utf8"))
      .resolves.toContain("Users need the behavior");
  });

  it("passes Review and Finding bindings to an implementation Recovery Revision", async () => {
    const root = await createRepository();
    let received: Parameters<RockSpecEngine["revise"]>[0] | undefined;
    const result = await runWithEngine(root, [
      "revise", "recover-task-design",
      "--review", "task:T-004",
      "--finding", "F-001",
      "--finding", "F-003",
      "--reason", "Task Review exposed an approved Design gap",
      "--affected", "D-003",
      "--classification", "derived_gap",
      "--authority-impact", "unchanged",
      "--author-execution", "recovery-author",
    ], {
      revise: async (input) => {
        received = input;
        return {
          current_state: "SPEC_APPROVED",
          recovery: null,
        } as Awaited<ReturnType<RockSpecEngine["revise"]>>;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      command: "revise",
      data: { current_state: "SPEC_APPROVED" },
    });
    expect(received).toEqual({
      changeId: "recover-task-design",
      reviewId: "task:T-004",
      findingIds: ["F-001", "F-003"],
      reason: "Task Review exposed an approved Design gap",
      affectedIds: ["D-003"],
      classification: "derived_gap",
      authorityDelta: "unchanged",
      authorExecutionId: "recovery-author",
    });
  });

  it("dispatches --amend to the active Revision amendment path", async () => {
    const root = await createRepository();
    let received: Parameters<RockSpecEngine["amendRevision"]>[0] | undefined;
    const result = await runWithEngine(root, [
      "revise", "recover-task-design",
      "--amend",
      "--review", "readiness",
      "--finding", "F-101",
      "--finding", "F-102",
      "--reason", "Readiness exposed another Design gap",
      "--affected", "D-003",
    ], {
      amendRevision: async (input) => {
        received = input;
        return {
          current_state: "SPEC_APPROVED",
          recovery: null,
        } as Awaited<ReturnType<RockSpecEngine["amendRevision"]>>;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      command: "revise.amend",
      data: { current_state: "SPEC_APPROVED" },
    });
    expect(received).toEqual({
      changeId: "recover-task-design",
      reviewId: "readiness",
      findingIds: ["F-101", "F-102"],
      reason: "Readiness exposed another Design gap",
      affectedIds: ["D-003"],
    });
  });

  it("dispatches recover apply without caller-supplied Review bindings", async () => {
    const root = await createRepository();
    let received: Parameters<RockSpecEngine["applyRecovery"]>[0] | undefined;
    const result = await runWithEngine(root, [
      "recover", "apply", "recover-task-design",
      "--affected", "D-003",
      "--author-execution", "recovery-author",
    ], {
      applyRecovery: async (input) => {
        received = input;
        return {
          current_state: "SPEC_APPROVED",
          recovery: null,
        } as Awaited<ReturnType<RockSpecEngine["applyRecovery"]>>;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      command: "recover.apply",
      data: { current_state: "SPEC_APPROVED" },
    });
    expect(received).toEqual({
      changeId: "recover-task-design",
      affectedIds: ["D-003"],
      authorExecutionId: "recovery-author",
    });
  });

  it("dispatches Reconciliation prepare and complete commands", async () => {
    const root = await createRepository();
    const calls: string[] = [];
    const engine = {
      prepareReconciliation: async (input: Parameters<RockSpecEngine["prepareReconciliation"]>[0]) => {
        calls.push(`prepare:${input.gate}:${input.changeId}`);
        return { revision_id: "RV-001", gate: input.gate, round: 1 } as Awaited<ReturnType<RockSpecEngine["prepareReconciliation"]>>;
      },
      completeReconciliation: async (input: Parameters<RockSpecEngine["completeReconciliation"]>[0]) => {
        calls.push(`complete:${input.gate}:${input.changeId}:${input.verdict}`);
        return { current_state: "DESIGN_APPROVED" } as Awaited<ReturnType<RockSpecEngine["completeReconciliation"]>>;
      },
    };

    expect((await runWithEngine(root, ["reconcile", "prepare", "design", "recover-design"], engine)).exitCode).toBe(0);
    expect((await runWithEngine(root, [
      "reconcile", "complete", "design", "recover-design", "--verdict", "PASS",
    ], engine)).exitCode).toBe(0);
    expect(calls).toEqual([
      "prepare:design:recover-design",
      "complete:design:recover-design:PASS",
    ]);
  });

  it("wires the Standard approvals, Task, Acceptance, and post-TE Final CR commands", async () => {
    const root = await createRepository();
    const id = "add-profile-export";
    expect((await run(root, [
      "install",
      "--project", root,
      "--source-root", sourceRoot,
      "--hosts", "codex",
      "--without", "ui.prototype",
      "--yes",
    ])).exitCode).toBe(0);
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "chore: install rockspec"], { cwd: root });
    expect((await run(root, ["new", id, "--kind", "feature"])).json).toMatchObject({
      data: {
        recommended_next: {
          entry_skill: "rockspec-requirements",
          action: "requirements.clarify",
        },
      },
    });
    const prematureGate = await run(root, ["gate", "spec", id]);
    expect(prematureGate.exitCode).toBe(1);
    expect(prematureGate.json).toMatchObject({
      ok: false,
      error: { code: "GATE_FAILED" },
    });

    await writeArtifact(
      root,
      id,
      "proposal.md",
      "---\nschema_version: 1\nnon_goals: []\nassumptions: []\nopen_questions: []\n---\n\n# Proposal\n\n## Why\n\nUsers need portable profile data.\n\n## What\n\nAdd profile export behavior.\n",
    );
    await writeArtifact(
      root,
      id,
      "specs/change/spec.md",
      "## ADDED Requirements\n\n### R-001 Requirement: Export a profile\n\nThe system MUST export valid profile data.\n\n#### S-001 Scenario: Export succeeds\n\n- GIVEN a user has valid profile data\n- WHEN the user requests an export\n- THEN the system returns the profile data\n",
    );
    expect((await run(root, ["action", "complete", "requirements.clarify", id])).exitCode).toBe(0);
    await writeStageReview(root, id, "reviews/requirements-review.md", "requirements.review");
    expect((await run(root, ["action", "complete", "requirements.review", id, "--verdict", "PASS"])).exitCode).toBe(0);
    expect((await approveCli(root, id, "spec")).json).toMatchObject({
      data: {
        current_state: "SPEC_APPROVED",
        recommended_next: { entry_skill: "rockspec-design", action: "design.technical" },
      },
    });
    const specHash = await approvedSpecHash(root, id);

    await writeArtifact(
      root,
      id,
      "design.md",
      `---\nschema_version: 1\ninputs:\n  spec_hash: ${specHash}\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Context\n\nExport through the existing public service boundary.\n\n## 全局约束\n\nNone.\n\n## 总体方案比较\n\nUse the existing service instead of adding a parallel export stack.\n\n## Decisions\n\n### D-001 Deterministic export\n\n#### 目标与覆盖范围\n\nCover R-001 and S-001 only.\n\n#### 架构决策\n\nUse a deterministic JSON response.\n\n#### 模块与职责\n\nThe existing export service owns serialization.\n\n#### 接口与数据流\n\nThe request flows through the public export service to JSON serialization.\n\n#### 失败与边界行为\n\nInvalid profile data returns the existing validation error.\n\n#### 安全与隐私\n\nDo not log profile data.\n\n#### 兼容、迁移与回滚\n\nPreserve the public API; rollback reverts the implementation commit.\n\n#### 验证策略\n\nRun focused export and regression tests.\n\n#### 取舍与剩余风险\n\nPrefer compatibility; residual risk is None.\n\n## 未解决风险\n\nNone.\n`,
    );
    await run(root, ["action", "complete", "design.technical", id]);
    expect((await approveCli(root, id, "design")).json).toMatchObject({
      data: {
        current_state: "DESIGN_APPROVED",
        recommended_next: { entry_skill: "rockspec-plan", action: "plan.create" },
      },
    });

    await writeArtifact(
      root,
      id,
      "plan.md",
      "---\nschema_version: 1\nverification_only_scenario_ids: []\n---\n\n# Implementation Plan\n\n## Approach\n\nImplement and test the public export behavior.\n\n## Task DAG\n\n- T-001\n",
    );
    await writeArtifact(root, id, "tasks.md", "# Tasks\n\n- [ ] T-001 Implement profile export\n");
    await writeArtifact(
      root,
      id,
      "tasks/T-001.md",
      "---\nschema_version: 1\nid: T-001\ntitle: Implement profile export\ndependencies: []\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\ndecision_ids: [D-001]\nacceptance_criteria: [Profile data is exported.]\nconsumes: []\nproduces: []\nallowed_paths: [profile-export.ts]\n---\n\n# T-001\n\n## Goal\n\nImplement profile export.\n\n## Traceability\n\n- R-001\n- S-001\n- D-001\n\n## Acceptance Criteria\n\nProfile data is exported.\n\n## Verification\n\nRun focused tests.\n",
    );
    await run(root, ["action", "complete", "plan.create", id]);
    await writeStageReview(root, id, "reviews/readiness-review.md", "readiness.review");
    await run(root, ["action", "complete", "readiness.review", id, "--verdict", "PASS"]);
    expect((await run(root, ["preflight", "implementation", "--change", id])).json).toMatchObject({
      ok: true,
      command: "preflight",
      data: {
        valid: true,
        change_id: id,
        task_count: 1,
        review_modes: ["product", "scope_blocked", "historical_attribution"],
        installation: { valid: true, project_root: root },
      },
    });
    expect((await approveCli(root, id, "implementation")).json).toMatchObject({
      data: {
        current_state: "READY",
        recommended_next: { entry_skill: "rockspec-implement", action: "task.execute" },
      },
    });

    expect((await run(root, ["task", "start", "T-001", id])).exitCode).toBe(0);
    await writeFile(path.join(root, "profile-export.ts"), "export const profileExport = true;\n");
    await writeArtifact(root, id, "reviews/tasks/T-001-review.md", "# Review\n\nVerdict: PASS\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat(profile): [T-001] add profile export"], { cwd: root });
    const taskCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeImplementedReport(
      root,
      id,
      "runtime/tasks/T-001/implementer-report.md",
      "Implemented and verified profile export.",
    );
    await run(root, [
      "check", "run", "--change", id, "--task", "T-001", "--",
      process.execPath, "-e", "process.exit(0)",
    ]);
    const taskPackage = await run(root, ["review", "package", "task", id, "--task", "T-001"]);
    expect(taskPackage.exitCode, taskPackage.stderr).toBe(0);
    const taskSubject = (taskPackage.json?.data as { subject: {
      base_commit: string;
      head_commit: string;
      diff_hash: string;
    } }).subject;
    await writeCodeReview(root, id, "reviews/tasks/T-001-review.md", taskSubject, "task-reviewer-1");
    await run(root, ["action", "complete", "task.review", id, "--verdict", "PASS"]);
    expect((await run(root, ["task", "complete", "T-001", id, "--commit", taskCommit])).json)
      .toMatchObject({
        data: {
          current_state: "ACCEPTANCE_VALIDATING",
          recommended_next: {
            entry_skill: "rockspec-acceptance",
            action: "acceptance.validate",
          },
        },
      });

    await writeFile(path.join(root, "profile-export.e2e.ts"), "// committed TE coverage\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "test(profile): add export acceptance coverage"], { cwd: root });
    const acceptanceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeArtifact(root, id, "testing/test-plan.md", "# Acceptance Test Plan\n\nCover S-001 through E2E.\n");
    const acceptanceEvidence = await run(root, [
      "check", "run", "--change", id, "--action", "acceptance.validate", "--scenario", "S-001", "--",
      process.execPath, "-e", "process.exit(0)",
    ]);
    expect(acceptanceEvidence.exitCode, acceptanceEvidence.stderr).toBe(0);
    const acceptanceEvidenceId = (acceptanceEvidence.json?.data as { check: { evidence_id: string } }).check.evidence_id;
    const acceptanceReviewer = await startExecutionCli(root, id, "acceptance.validate", "acceptance_engineer");
    await writeArtifact(
      root,
      id,
      "testing/test-report.md",
      `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${acceptanceReviewer}\ncommit: ${acceptanceCommit}\nscenario_coverage:\n  - scenario_id: S-001\n    test_ids: [AT-001]\n    evidence_ids: [${acceptanceEvidenceId}]\nui_evidence: []\nfindings: []\n---\n\n# Acceptance Test Report\n\nVerdict: PASS\n`,
    );
    expect((await run(root, ["action", "complete", "acceptance.validate", id, "--verdict", "PASS"])).json)
      .toMatchObject({
        data: {
          current_state: "FINAL_REVIEW",
          recommended_next: { entry_skill: "rockspec-review", action: "delivery.review" },
        },
      });

    const deliveryPackage = await run(root, ["review", "package", "delivery", id]);
    const deliverySubject = (deliveryPackage.json?.data as { subject: {
      base_commit: string;
      head_commit: string;
      diff_hash: string;
    } }).subject;
    await writeCodeReview(root, id, "reviews/delivery-review.md", deliverySubject, "delivery-reviewer-1");
    expect((await run(root, ["action", "complete", "delivery.review", id, "--verdict", "PASS"])).json)
      .toMatchObject({
        data: {
          current_state: "VERIFYING",
          recommended_next: { entry_skill: "rockspec-finish", action: "change.verify" },
        },
      });
    await run(root, [
      "check", "run", "--change", id, "--action", "change.verify", "--",
      process.execPath, "-e", "process.exit(0)",
    ]);
    expect((await run(root, ["verify", id])).json).toMatchObject({
      data: {
        current_state: "READY_TO_FINISH",
        recommended_next: { entry_skill: "rockspec-evolve", action: "knowledge.evolve" },
      },
    });
    const standardKnowledgeAuthor = await startExecutionCli(root, id, "knowledge.evolve.author", "knowledge_author");
    await writeArtifact(
      root,
      id,
      "knowledge-delta.md",
      `---\nschema_version: 1\nchange_id: ${id}\nauthor_execution_id: ${standardKnowledgeAuthor}\noutcome: no_change\nupdates: []\n---\n\n# Knowledge Delta\n\nNo reusable knowledge.\n`,
    );
    await run(root, ["action", "complete", "knowledge.evolve", id]);
    expect((await run(root, ["gate", "finish", id])).json).toMatchObject({
      ok: true,
      data: { valid: true },
    });
  });
});
