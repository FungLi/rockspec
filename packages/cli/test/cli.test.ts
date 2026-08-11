import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";

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

async function writeArtifact(
  root: string,
  changeId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(root, ".rockspec", "changes", changeId, relativePath), content);
}

async function writeCodeReview(
  root: string,
  changeId: string,
  relativePath: string,
  subject: { base_commit: string; head_commit: string; diff_hash: string },
  reviewerExecutionId: string,
): Promise<void> {
  await writeArtifact(
    root,
    changeId,
    relativePath,
    `---\nschema_version: 1\nverdict: PASS\nreviewer_execution_id: ${reviewerExecutionId}\nsubject:\n  base_commit: ${subject.base_commit}\n  head_commit: ${subject.head_commit}\n  diff_hash: ${subject.diff_hash}\nround: 0\nfindings: []\n---\n\n# Review\n\nVerdict: PASS\n`,
  );
}

describe("rockspec CLI", () => {
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
      data: { current_state: "READY_TO_FINISH" },
    });
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

  it("wires the Standard approvals, Task, Acceptance, and post-TE Final CR commands", async () => {
    const root = await createRepository();
    const id = "add-profile-export";
    await run(root, ["init"]);
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
      "# Proposal\n\n## Why\n\nUsers need portable profile data.\n\n## What\n\nAdd profile export behavior.\n",
    );
    await writeArtifact(
      root,
      id,
      "specs/change/spec.md",
      "## ADDED Requirements\n\n### R-001 Requirement: Export a profile\n\nThe system MUST export valid profile data.\n\n#### S-001 Scenario: Export succeeds\n\n- GIVEN a user has valid profile data\n- WHEN the user requests an export\n- THEN the system returns the profile data\n",
    );
    expect((await run(root, ["action", "complete", "requirements.clarify", id])).exitCode).toBe(0);
    await writeArtifact(root, id, "reviews/requirements-review.md", "# Review\n\nVerdict: PASS\n");
    expect((await run(root, ["action", "complete", "requirements.review", id, "--verdict", "PASS"])).exitCode).toBe(0);
    expect((await run(root, ["approve", "spec", id])).json).toMatchObject({
      data: {
        current_state: "SPEC_APPROVED",
        recommended_next: { entry_skill: "rockspec-design", action: "design.technical" },
      },
    });

    await writeArtifact(
      root,
      id,
      "design.md",
      "---\nschema_version: 1\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Context\n\nExport through the existing public service boundary.\n\n## Decisions\n\n### D-001\n\nUse a deterministic JSON response.\n",
    );
    await run(root, ["action", "complete", "design.technical", id]);
    expect((await run(root, ["approve", "design", id])).json).toMatchObject({
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
      "---\nschema_version: 1\nid: T-001\ntitle: Implement profile export\ndependencies: []\nrequirement_ids: [R-001]\nscenario_ids: [S-001]\nacceptance_criteria: [Profile data is exported.]\nconsumes: []\nproduces: []\nallowed_paths: [profile-export.ts]\n---\n\n# T-001\n\n## Goal\n\nImplement profile export.\n\n## Traceability\n\n- R-001\n- S-001\n- D-001\n\n## Acceptance Criteria\n\nProfile data is exported.\n\n## Verification\n\nRun focused tests.\n",
    );
    await run(root, ["action", "complete", "plan.create", id]);
    await writeArtifact(root, id, "reviews/readiness-review.md", "# Review\n\nVerdict: PASS\n");
    await run(root, ["action", "complete", "readiness.review", id, "--verdict", "PASS"]);
    expect((await run(root, ["approve", "implementation", id])).json).toMatchObject({
      data: {
        current_state: "READY",
        recommended_next: { entry_skill: "rockspec-implement", action: "task.execute" },
      },
    });

    await run(root, ["task", "start", "T-001", id]);
    await writeFile(path.join(root, "profile-export.ts"), "export const profileExport = true;\n");
    await writeArtifact(root, id, "reviews/tasks/T-001-review.md", "# Review\n\nVerdict: PASS\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feat(profile): [T-001] add profile export"], { cwd: root });
    const taskCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeArtifact(
      root,
      id,
      "runtime/tasks/T-001/implementer-report.md",
      "# Implementer Report\n\nImplemented and verified profile export.\n",
    );
    await run(root, [
      "check", "run", "--change", id, "--task", "T-001", "--",
      process.execPath, "-e", "process.exit(0)",
    ]);
    const taskPackage = await run(root, ["review", "package", "task", id, "--task", "T-001"]);
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
    await writeArtifact(root, id, "testing/test-report.md", "# Acceptance Test Report\n\nVerdict: PASS\n");
    await run(root, [
      "check", "run", "--change", id, "--action", "acceptance.validate", "--",
      process.execPath, "-e", "process.exit(0)",
    ]);
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
        recommended_next: { entry_skill: "rockspec-finish", action: "finish" },
      },
    });
    expect((await run(root, ["gate", "finish", id])).json).toMatchObject({
      ok: true,
      data: { valid: true },
    });
  });
});
