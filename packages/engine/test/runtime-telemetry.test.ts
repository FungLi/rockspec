import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { appendRuntimeTelemetry, summarizeRuntimeTelemetry } from "../src/storage.js";
import { RockSpecEngine } from "../src/index.js";
import { stringify } from "yaml";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rockspec-telemetry-")));
  repositories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "telemetry@rockspec.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RockSpec Telemetry Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: initial"], { cwd: root });
  await mkdir(path.join(root, ".rockspec"), { recursive: true });
  return root;
}

describe("Runtime telemetry", () => {
  it("records privacy-safe command facts and summarizes them by Change", async () => {
    const root = await repository();
    await appendRuntimeTelemetry(root, {
      schema_version: 1,
      invocation_id: "run-1",
      command: "status",
      change_id: "sample-change",
      started_at: "2026-08-23T00:00:00.000Z",
      finished_at: "2026-08-23T00:00:00.010Z",
      duration_ms: 10,
      result: "success",
      internal_error: false,
      response_bytes: 120,
    });
    await appendRuntimeTelemetry(root, {
      schema_version: 1,
      invocation_id: "run-2",
      command: "recover.apply",
      change_id: "sample-change",
      started_at: "2026-08-23T00:00:01.000Z",
      finished_at: "2026-08-23T00:00:01.025Z",
      duration_ms: 25,
      result: "error",
      error_code: "INTERNAL_ERROR",
      internal_error: true,
      response_bytes: 80,
    });
    await appendRuntimeTelemetry(root, {
      schema_version: 1,
      invocation_id: "run-3",
      command: "status",
      change_id: "other-change",
      started_at: "2026-08-23T00:00:02.000Z",
      finished_at: "2026-08-23T00:00:02.005Z",
      duration_ms: 5,
      result: "success",
      internal_error: false,
      response_bytes: 40,
    });
    await appendFile(path.join(root, ".rockspec", "telemetry", "commands.ndjson"), "not-json\n", "utf8");

    await expect(summarizeRuntimeTelemetry(root, "sample-change")).resolves.toMatchObject({
      change_id: "sample-change",
      record_count: 2,
      success_count: 1,
      error_count: 1,
      internal_error_count: 1,
      total_duration_ms: 35,
      by_command: {
        "recover.apply": { count: 1, error_count: 1, duration_ms: 25, response_bytes: 80 },
        status: { count: 1, success_count: 1, duration_ms: 10, response_bytes: 120 },
      },
      by_error_code: { INTERNAL_ERROR: 1 },
    });
  });

  it("records execution token receipts and aggregates them by role", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root, now: () => new Date("2026-08-23T00:00:00.000Z") });
    await engine.init();
    await engine.newChange({ id: "token-receipt", profile: "standard" });
    const started = await engine.startExecution({
      changeId: "token-receipt",
      action: "requirements.review",
      role: "requirements_reviewer",
      modelTier: "balanced",
    });
    await engine.completeExecution({
      changeId: "token-receipt",
      executionId: started.started_execution.id,
      usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_tokens: 7 },
    });
    const status = await engine.getStatus({ changeId: "token-receipt" });
    expect(status.change.execution.registry[0]?.usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 20,
      reasoning_tokens: 7,
    });
    await expect(summarizeRuntimeTelemetry(root, "token-receipt")).resolves.toMatchObject({
      token_usage: {
        execution_count: 1,
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 20,
        reasoning_tokens: 7,
        by_role: { requirements_reviewer: { execution_count: 1, input_tokens: 100 } },
      },
    });
  });

  it("reuses matching executed evidence and blocks duplicate Acceptance executions", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await engine.newChange({ id: "check-cache", profile: "standard" });
    const first = await engine.runCheck({
      changeId: "check-cache",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      actionId: "acceptance.validate",
      scenarioIds: [],
    });
    const second = await engine.runCheck({
      changeId: "check-cache",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      actionId: "acceptance.validate",
      scenarioIds: [],
    });
    expect(first.check.cached).toBe(false);
    expect(second.check).toMatchObject({ cached: true, evidence_id: first.check.evidence_id });

    await engine.startExecution({ changeId: "check-cache", action: "acceptance.validate", role: "acceptance_engineer" });
    await expect(engine.startExecution({
      changeId: "check-cache",
      action: "acceptance.validate",
      role: "acceptance_engineer",
    })).rejects.toMatchObject({ code: "EXECUTION_ALREADY_ACTIVE" });
  });

  it("runs configured environment probes without exposing their output", async () => {
    const root = await repository();
    const engine = new RockSpecEngine({ cwd: root });
    await engine.init();
    await writeFile(path.join(root, ".rockspec", "config.yaml"), stringify({
      schema_version: 1,
      default_profile: "standard",
      capabilities: { "ui.prototype": { provider: "ui-ux-pro-max", distribution: "installed" } },
      environment_preflight: [{ id: "credential-probe", kind: "credential", command: process.execPath, args: ["-e", "process.stdout.write('secret')"] }],
    }));
    await engine.newChange({ id: "environment-probe", profile: "standard" });
    const result = await engine.preflightEnvironment({ changeId: "environment-probe" });
    expect(result.valid).toBe(true);
    expect(result.checks).toMatchObject([{ id: "credential-probe", kind: "credential", status: "passed" }]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
