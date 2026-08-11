import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { RockSpecEngine, RockSpecError } from "../src/index.js";

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

async function passReview(root: string, changeId: string, relativePath: string): Promise<void> {
  await replace(root, changeId, relativePath, "# Review\n\nVerdict: PASS\n\nNo blocking findings.\n");
}

async function writeCodeReview(
  root: string,
  changeId: string,
  relativePath: string,
  subject: { base_commit: string; head_commit: string; diff_hash: string },
  verdict: "PASS" | "CHANGES_REQUIRED" = "PASS",
  reviewerExecutionId = "reviewer-execution-1",
): Promise<void> {
  await replace(
    root,
    changeId,
    relativePath,
    `---\nschema_version: 1\nverdict: ${verdict}\nreviewer_execution_id: ${reviewerExecutionId}\nsubject:\n  base_commit: ${subject.base_commit}\n  head_commit: ${subject.head_commit}\n  diff_hash: ${subject.diff_hash}\nround: 0\nfindings: []\n---\n\n# Review\n\nVerdict: ${verdict}\n\nNo blocking findings.\n`,
  );
}

async function materializeRequirements(root: string, changeId: string): Promise<void> {
  await replace(
    root,
    changeId,
    "proposal.md",
    "# Proposal\n\n## Why\n\nUsers need this behavior.\n\n## What\n\nAdd the requested observable behavior.\n",
  );
  await replace(
    root,
    changeId,
    "specs/change/spec.md",
    "## ADDED Requirements\n\n### R-001 Requirement: Observable behavior\n\nThe system MUST provide the requested behavior.\n\n#### S-001 Scenario: Successful behavior\n\n- GIVEN a valid user context\n- WHEN the user requests the behavior\n- THEN the system returns the expected result\n",
  );
}

async function materializeDesign(root: string, changeId: string): Promise<void> {
  await replace(
    root,
    changeId,
    "design.md",
    "---\nschema_version: 1\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001]\n---\n\n# Technical Design\n\n## Context\n\nImplement R-001 without changing unrelated contracts.\n\n## Decisions\n\n### D-001\n\nUse the existing module boundary and verification stack.\n",
  );
}

function taskDocument(input: {
  id: string;
  scenarioIds: string[];
  allowedPath: string;
  dependencies?: string[];
  requirementIds?: string[];
  consumes?: string[];
  produces?: string[];
}): string {
  const list = (values: string[]): string => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  return `---\nschema_version: 1\nid: ${input.id}\ntitle: ${input.id} implementation\ndependencies: ${list(input.dependencies ?? [])}\nrequirement_ids: ${list(input.requirementIds ?? ["R-001"])}\nscenario_ids: ${list(input.scenarioIds)}\nacceptance_criteria: [The mapped behavior is observable.]\nconsumes: ${list(input.consumes ?? [])}\nproduces: ${list(input.produces ?? [])}\nallowed_paths: [${input.allowedPath}]\n---\n\n# ${input.id}\n\n## Goal\n\nImplement the mapped behavior.\n`;
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
  await engine.approve({ changeId: id, gate: "spec", approvedBy: "tester" });
}

async function makeReady(engine: RockSpecEngine, root: string, id: string): Promise<void> {
  await approveRequirements(engine, root, id);
  await materializeDesign(root, id);
  await engine.completeAction({ changeId: id, action: "design.technical" });
  await engine.approve({ changeId: id, gate: "design", approvedBy: "tester" });
  await materializePlan(root, id);
  await engine.completeAction({ changeId: id, action: "plan.create" });
  await passReview(root, id, "reviews/readiness-review.md");
  await engine.completeAction({ changeId: id, action: "readiness.review" });
  await engine.approve({ changeId: id, gate: "implementation", approvedBy: "tester" });
}

async function preparePlanning(engine: RockSpecEngine, root: string, id: string): Promise<void> {
  await approveRequirements(engine, root, id);
  await materializeDesign(root, id);
  await engine.completeAction({ changeId: id, action: "design.technical" });
  await engine.approve({ changeId: id, gate: "design", approvedBy: "tester" });
}

describe("RockSpecEngine", () => {
  it("initializes at the Git root and runs the Lite lifecycle", async () => {
    const root = await repository();
    const visibleRoot = root.startsWith("/private/var/") ? root.slice("/private".length) : root;
    const child = path.join(visibleRoot, "apps", "web");
    await mkdir(child, { recursive: true });
    const engine = new RockSpecEngine({ cwd: child });

    const initialized = await engine.init();
    expect(initialized.repository_root).toBe(root);
    const created = await engine.newChange({ id: "rename-submit-button", profile: "lite" });
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
      .resolves.toContain("Technical Design");

    await approveRequirements(engine, root, "add-profile-export");
    await replace(
      root,
      "add-profile-export",
      "specs/change/spec.md",
      "## ADDED Requirements\n\n### R-001 Requirement: export\nThe system MUST export.\n",
    );
    const status = await engine.getStatus({ changeId: "add-profile-export" });
    expect(status.blocked_by.some((blocker) => blocker.code === "STALE_APPROVAL")).toBe(true);
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
    await replace(
      root,
      id,
      "design.md",
      "---\nschema_version: 1\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: []\n---\n\n# Technical Design\n\n## Decisions\n\n### D-001\n\nImplement only part of the approved behavior.\n",
    );

    await expect(engine.completeAction({ changeId: id, action: "design.technical" }))
      .rejects.toMatchObject({
        code: "DESIGN_COVERAGE_GAP",
        details: { scenario_ids: ["S-001"] },
      });
  });

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
      "# Proposal\n\n## Why\n\nUsers need both outcomes.\n\n## What\n\nAdd both observable outcomes.\n",
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
    await coverageEngine.approve({ changeId: coverageId, gate: "spec", approvedBy: "tester" });
    await replace(
      coverageRoot,
      coverageId,
      "design.md",
      "---\nschema_version: 1\ndecisions:\n  - id: D-001\n    requirement_ids: [R-001]\n    scenario_ids: [S-001, S-002]\n---\n\n# Technical Design\n\n## Decisions\n\n### D-001\n\nCover both outcomes.\n",
    );
    await coverageEngine.completeAction({ changeId: coverageId, action: "design.technical" });
    await coverageEngine.approve({ changeId: coverageId, gate: "design", approvedBy: "tester" });
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
    await replace(root, "add-settings-navigation", "prototype/brief.md", "# Prototype Brief\n\nSettings navigation for account users.\n");
    await replace(root, "add-settings-navigation", "prototype/design-system.md", "# Design System\n\nUse existing tokens with visible focus and AA contrast.\n");
    await replace(root, "add-settings-navigation", "prototype/prototype.md", "# Prototype\n\nDesktop and mobile navigation states are defined.\n");
    const completed = await available.completeAction({
      changeId: "add-settings-navigation",
      action: "design.prototype",
    });
    expect(completed.change.prototype.status).toBe("completed");
  });

  it("enforces Task commit/evidence and the TE to Final CR order", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "support-order-cancellation", profile: "standard" });
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
    await replace(
      root,
      "support-order-cancellation",
      "runtime/tasks/T-001/implementer-report.md",
      "# T-001 Implementer Report\n\nImplemented feature.txt and verified observable behavior.\n",
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
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const accepted = await engine.completeAction({
      changeId: "support-order-cancellation",
      action: "acceptance.validate",
    });
    expect(accepted.current_state).toBe("FINAL_REVIEW");
    const deliveryPackage = await engine.prepareReviewPackage({
      changeId: "support-order-cancellation",
      kind: "delivery",
    });
    await writeCodeReview(
      root,
      "support-order-cancellation",
      "reviews/delivery-review.md",
      deliveryPackage.subject,
      "PASS",
      "delivery-reviewer-execution",
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

  it("pins Task history, file scope, Reviewer identity, and non-PASS Findings", async () => {
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
    await expect(engine.prepareReviewPackage({
      changeId: "harden-task-review",
      kind: "task",
      taskId: "T-001",
    })).rejects.toMatchObject({ code: "TASK_SCOPE_VIOLATION" });

    await rm(path.join(root, "extra.txt"));
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "--amend", "--no-edit"], { cwd: root });
    await replace(
      root,
      "harden-task-review",
      "runtime/tasks/T-001/implementer-report.md",
      "# Implementer Report\n\nImplemented the approved behavior and ran focused verification.\n",
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
    })).rejects.toMatchObject({ code: "REVIEWER_NOT_INDEPENDENT" });

    await replace(
      root,
      "harden-task-review",
      "reviews/tasks/T-001-review.md",
      `---\nschema_version: 1\nverdict: CHANGES_REQUIRED\nreviewer_execution_id: independent-reviewer\nsubject:\n  base_commit: ${reviewPackage.subject.base_commit}\n  head_commit: ${reviewPackage.subject.head_commit}\n  diff_hash: ${reviewPackage.subject.diff_hash}\nround: 0\nfindings:\n  - id: F-001\n    severity: important\n    category: test-quality\n    evidence: feature.txt:1\n    description: Regression coverage is incomplete.\n    owner_domain: implementation\n    route_to: task.execute\n    status: open\n---\n\n# Review\n\nVerdict: CHANGES_REQUIRED\n`,
    );
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
    await engine.newChange({ id: "fix-login-copy", profile: "lite" });
    await replace(root, "fix-login-copy", "brief.md", "# Fix login copy\n\n## Scope\n\nFix one label.\n\n## Verification\n\nRun focused tests.\n");
    await engine.apply({ changeId: "fix-login-copy" });
    await engine.runCheck({
      changeId: "fix-login-copy",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await engine.verify({ changeId: "fix-login-copy" });
    await engine.finish({ changeId: "fix-login-copy", disposition: "keep" });
    const archived = await engine.archive({ changeId: "fix-login-copy" });
    expect(archived.current_state).toBe("ARCHIVED");
    expect(archived.archive_path).toBe(path.join(root, ".rockspec", "archive", "2026", "08", "fix-login-copy"));
    await expect(engine.newChange({ id: "fix-login-copy", profile: "lite" }))
      .rejects.toMatchObject({ code: "CHANGE_ID_CONFLICT" });
  });

  it("rejects a second active Change in one workspace and detects nested roots", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "fix-first-case", profile: "lite" });
    await expect(engine.newChange({ id: "fix-second-case", profile: "lite" }))
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
    await expect(second.newChange({ id: "add-export", profile: "lite", workspaceManaged: true }))
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
    const approved = await engine.approve({
      changeId: "secure-payment-retry",
      gate: "spec",
      approvedBy: "tester",
    });
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
      "# Proposal\n\n## Why\n\nAuditors need exports.\n\n## What\n\nAdd an observable audit export with explicit scope.\n",
    );
    await expect(
      engine.approve({ changeId: "add-audit-export", gate: "spec", approvedBy: "tester" }),
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
    await engine.newChange({ id: "rename-account-label", profile: "lite" });
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
    ).resolves.toContain("# Proposal");
  });
});
