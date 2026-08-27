import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  type Config,
  parseChangeSnapshot as parseProtocolChangeSnapshot,
  parseConfig as parseProtocolConfig,
} from "@rockspec/protocol";
import { RockSpecError } from "./error.js";
import type {
  ChangeSnapshot,
  EventRecord,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySummary,
} from "./types.js";

const execFileAsync = promisify(execFile);

export type RockSpecConfig = Config;

export interface GitWorkspaceContext {
  mode: "current" | "worktree";
  branch: string | null;
  root: string;
  gitDir: string;
  gitCommonDir: string;
}

export const DEFAULT_CONFIG: RockSpecConfig = {
  schema_version: 1,
  default_profile: "standard",
  artifact_language: "zh-CN",
  max_review_rounds: 3,
  max_reconciliation_rounds: 2,
  environment_preflight: [],
  workspace: {
    mode: "auto",
    directory: ".worktrees",
    branch_prefix: "rockspec/",
    auto_create: false,
  },
  capabilities: {
    "ui.prototype": {
      provider: "ui-ux-pro-max",
      distribution: "installed",
    },
  },
};

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepository(cwd: string): Promise<{ root: string; rocksRoot: string }> {
  let root: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    root = await realpath(path.resolve(result.stdout.trim()));
  } catch (error) {
    throw new RockSpecError("NOT_GIT_REPOSITORY", "RockSpec must run inside a Git repository", {
      cwd,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const absoluteCwd = await realpath(path.resolve(cwd));
  const relative = path.relative(root, absoluteCwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RockSpecError("REPOSITORY_ROOT_MISMATCH", "Resolved Git root does not contain cwd", {
      cwd: absoluteCwd,
      root,
    });
  }

  const nested: string[] = [];
  let cursor = absoluteCwd;
  while (cursor !== root) {
    const candidate = path.join(cursor, ".rockspec");
    if (await exists(candidate)) nested.push(candidate);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (nested.length > 0) {
    throw new RockSpecError(
      "NESTED_ROCKSPEC_ROOT",
      "A nested .rockspec directory conflicts with the repository root",
      { root, nested },
    );
  }

  return { root, rocksRoot: path.join(root, ".rockspec") };
}

export async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd: root });
    return result.stdout.trimEnd();
  } catch (error) {
    throw new RockSpecError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed`, {
      args,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function optionalGit(root: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", args, { cwd: root });
    return result.stdout.trimEnd();
  } catch {
    return null;
  }
}

async function resolveGitPath(root: string, value: string): Promise<string> {
  const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
  return realpath(absolute);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function inspectGitWorkspace(root: string): Promise<GitWorkspaceContext> {
  const [gitDirText, commonDirText, superproject, branchText] = await Promise.all([
    git(root, ["rev-parse", "--git-dir"]),
    git(root, ["rev-parse", "--git-common-dir"]),
    optionalGit(root, ["rev-parse", "--show-superproject-working-tree"]),
    optionalGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  const [gitDir, gitCommonDir] = await Promise.all([
    resolveGitPath(root, gitDirText),
    resolveGitPath(root, commonDirText),
  ]);
  return {
    mode: !superproject && !samePath(gitDir, gitCommonDir) ? "worktree" : "current",
    branch: branchText || null,
    root,
    gitDir,
    gitCommonDir,
  };
}

export async function registeredWorktreeRoots(root: string): Promise<string[]> {
  const output = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const roots = output
    .split("\0")
    .filter((token) => token.startsWith("worktree "))
    .map((token) => token.slice("worktree ".length));
  const resolved = await Promise.all(roots.map(async (candidate) => {
    try {
      return await realpath(candidate);
    } catch {
      return null;
    }
  }));
  return [...new Set(resolved.filter((candidate): candidate is string => candidate !== null))].sort();
}

export async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withFileLock<T>(
  rocksRoot: string,
  operation: () => Promise<T>,
  timeoutMs = 2_000,
  staleMs = 30_000,
): Promise<T> {
  const lockPath = path.join(rocksRoot, ".lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const reclaimPath = path.join(lockPath, "reclaim");
  const started = Date.now();
  const owner = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    token: randomUUID(),
  };
  while (true) {
    try {
      await mkdir(lockPath, { recursive: true });
      if (await exists(reclaimPath)) throw lockContentionError();
      const handle = await open(ownerPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "LOCK_CONTENDED") throw error;
      await clearStaleReclaim(reclaimPath, staleMs);
      await reclaimStaleLock(ownerPath, reclaimPath, staleMs);
      if (Date.now() - started >= timeoutMs) {
        throw new RockSpecError("LOCK_TIMEOUT", "Timed out waiting for the RockSpec state lock", {
          lock_path: lockPath,
          timeout_ms: timeoutMs,
          stale_ms: staleMs,
        });
      }
      await sleep(25);
    }
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(ownerPath, owner.token);
    try {
      await rmdir(lockPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
}

function lockContentionError(): Error & { code: string } {
  return Object.assign(new Error("RockSpec lock recovery is in progress"), { code: "LOCK_CONTENDED" });
}

interface LockOwner {
  pid: number | null;
  startedAt: number;
  token: string | null;
}

async function inspectLockOwner(ownerPath: string): Promise<LockOwner | null> {
  let metadata;
  try {
    metadata = await stat(ownerPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    const parsedStartedAt = typeof parsed.started_at === "string" ? Date.parse(parsed.started_at) : Number.NaN;
    return {
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : metadata.mtimeMs,
      token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null,
    };
  } catch {
    return { pid: null, startedAt: metadata.mtimeMs, token: null };
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code !== "ESRCH";
  }
}

function isStaleOwner(owner: LockOwner, staleMs: number): boolean {
  if (Date.now() - owner.startedAt < staleMs) return false;
  return owner.pid === null || !processExists(owner.pid);
}

async function reclaimStaleLock(ownerPath: string, reclaimPath: string, staleMs: number): Promise<void> {
  const observed = await inspectLockOwner(ownerPath);
  if (!observed || !isStaleOwner(observed, staleMs)) return;

  let claim;
  const claimOwner = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    token: randomUUID(),
  };
  try {
    claim = await open(reclaimPath, "wx", 0o600);
    await claim.writeFile(`${JSON.stringify(claimOwner)}\n`, "utf8");
    await claim.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST" || code === "ENOENT") return;
    throw error;
  } finally {
    await claim?.close();
  }

  try {
    const current = await inspectLockOwner(ownerPath);
    if (!current || !isStaleOwner(current, staleMs)) return;
    if (observed.token !== current.token || observed.pid !== current.pid || observed.startedAt !== current.startedAt) return;
    await rm(ownerPath, { force: true });
  } finally {
    await releaseOwnedLock(reclaimPath, claimOwner.token);
  }
}

async function clearStaleReclaim(reclaimPath: string, staleMs: number): Promise<void> {
  const observed = await inspectLockOwner(reclaimPath);
  if (!observed || !isStaleOwner(observed, staleMs)) return;
  const current = await inspectLockOwner(reclaimPath);
  if (!current || !isStaleOwner(current, staleMs)) return;
  if (observed.token !== current.token || observed.pid !== current.pid || observed.startedAt !== current.startedAt) return;
  await rm(reclaimPath, { force: true });
}

async function releaseOwnedLock(ownerPath: string, token: string): Promise<void> {
  const current = await inspectLockOwner(ownerPath);
  if (current?.token === token) await rm(ownerPath, { force: true });
}

export function parseConfigText(text: string, source: string): RockSpecConfig {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new RockSpecError("INVALID_YAML", `Cannot parse ${source}`, {
      source,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return parseProtocolConfig(value) as RockSpecConfig;
  } catch (error) {
    throw new RockSpecError("INVALID_CONFIG", "config.yaml does not match the RockSpec protocol", {
      source,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseChangeText(text: string, source: string): ChangeSnapshot {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new RockSpecError("INVALID_YAML", `Cannot parse ${source}`, {
      source,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return parseProtocolChangeSnapshot(value) as unknown as ChangeSnapshot;
  } catch (error) {
    throw new RockSpecError("INVALID_CHANGE", "change.yaml does not match the RockSpec protocol", {
      source,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readConfig(rocksRoot: string): Promise<RockSpecConfig> {
  const source = path.join(rocksRoot, "config.yaml");
  if (!(await exists(source))) {
    throw new RockSpecError("NOT_INITIALIZED", "RockSpec is not initialized in this repository", {
      expected: source,
    });
  }
  return parseConfigText(await readFile(source, "utf8"), source);
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function snapshotText(change: ChangeSnapshot): string {
  return stringify(parseProtocolChangeSnapshot(change), { lineWidth: 0 });
}

async function recoverStateTransaction(changeDir: string): Promise<void> {
  const journalPath = path.join(changeDir, "runtime", "state-transaction.yaml");
  if (!(await exists(journalPath))) return;
  const raw = parse(await readFile(journalPath, "utf8")) as {
    schema_version?: number;
    before_hash?: string | null;
    after_hash?: string;
    after_snapshot?: unknown;
    event?: EventRecord;
  };
  if (raw.schema_version !== 1 || !raw.after_hash || !raw.after_snapshot || !raw.event) {
    throw new RockSpecError("STATE_TRANSACTION_INVALID", "Pending state transaction journal is invalid", { path: journalPath });
  }
  const after = parseProtocolChangeSnapshot(raw.after_snapshot);
  const afterContent = stringify(after, { lineWidth: 0 });
  if (digest(afterContent) !== raw.after_hash) {
    throw new RockSpecError("STATE_TRANSACTION_INVALID", "Pending state transaction snapshot hash is invalid", { path: journalPath });
  }
  const statePath = path.join(changeDir, "change.yaml");
  const currentContent = await exists(statePath) ? await readFile(statePath, "utf8") : null;
  const currentHash = currentContent === null ? null : digest(currentContent);
  if (currentHash !== raw.before_hash && currentHash !== raw.after_hash) {
    throw new RockSpecError("STATE_TRANSACTION_DIVERGED", "Change state diverged while a transaction was pending", {
      current_hash: currentHash,
      before_hash: raw.before_hash ?? null,
      after_hash: raw.after_hash,
    });
  }
  if (currentHash !== raw.after_hash) await atomicWrite(statePath, afterContent);

  const eventsPath = path.join(changeDir, "events.ndjson");
  const events = await exists(eventsPath)
    ? (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventRecord)
    : [];
  const sameSequence = events.find((event) => event.sequence === raw.event!.sequence);
  if (sameSequence && JSON.stringify(sameSequence) !== JSON.stringify(raw.event)) {
    throw new RockSpecError("STATE_TRANSACTION_DIVERGED", "Event sequence conflicts with a pending state transaction", {
      sequence: raw.event.sequence,
    });
  }
  if (!sameSequence) await appendEvent(changeDir, raw.event);
  await rm(journalPath, { force: true });
}

export async function readChange(changeDir: string): Promise<ChangeSnapshot> {
  await recoverStateTransaction(changeDir);
  const source = path.join(changeDir, "change.yaml");
  if (!(await exists(source))) {
    throw new RockSpecError("CHANGE_NOT_FOUND", "The change snapshot does not exist", { source });
  }
  return parseChangeText(await readFile(source, "utf8"), source);
}

export async function commitChangeMutation(
  changeDir: string,
  _before: ChangeSnapshot | null,
  after: ChangeSnapshot,
  event: EventRecord,
): Promise<void> {
  const statePath = path.join(changeDir, "change.yaml");
  const beforeContent = await exists(statePath) ? await readFile(statePath, "utf8") : null;
  const afterContent = snapshotText(after);
  const journalPath = path.join(changeDir, "runtime", "state-transaction.yaml");
  await atomicWrite(journalPath, stringify({
    schema_version: 1,
    before_hash: beforeContent === null ? null : digest(beforeContent),
    after_hash: digest(afterContent),
    after_snapshot: parseProtocolChangeSnapshot(after),
    event,
  }, { lineWidth: 0 }));
  await atomicWrite(statePath, afterContent);
  await appendEvent(changeDir, event);
  await rm(journalPath, { force: true });
}

export async function writeChange(changeDir: string, change: ChangeSnapshot): Promise<void> {
  let parsed: unknown;
  try {
    parsed = parseProtocolChangeSnapshot(change);
  } catch (error) {
    throw new RockSpecError("INVALID_CHANGE", "Refusing to write an invalid change snapshot", {
      source: path.join(changeDir, "change.yaml"),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  await atomicWrite(path.join(changeDir, "change.yaml"), stringify(parsed, { lineWidth: 0 }));
}

export async function appendEvent(changeDir: string, event: EventRecord): Promise<void> {
  await appendFile(path.join(changeDir, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function eventCount(changeDir: string): Promise<number> {
  try {
    const text = await readFile(path.join(changeDir, "events.ndjson"), "utf8");
    return text.split("\n").filter(Boolean).length;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return 0;
    throw error;
  }
}

export async function appendRuntimeTelemetry(
  cwd: string,
  record: RuntimeTelemetryRecord,
): Promise<void> {
  const { rocksRoot } = await resolveRepository(cwd);
  if (!(await exists(rocksRoot))) return;
  const telemetryRoot = path.join(rocksRoot, "telemetry");
  await mkdir(telemetryRoot, { recursive: true });
  await appendFile(
    path.join(telemetryRoot, "commands.ndjson"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

export async function summarizeRuntimeTelemetry(
  cwd: string,
  changeId?: string,
): Promise<RuntimeTelemetrySummary> {
  const { root, rocksRoot } = await resolveRepository(cwd);
  const telemetryPath = path.join(rocksRoot, "telemetry", "commands.ndjson");
  const sourcePath = path.relative(root, telemetryPath);
  let records: RuntimeTelemetryRecord[] = [];
  if (await exists(telemetryPath)) {
    const lines = (await readFile(telemetryPath, "utf8")).split("\n").filter(Boolean);
    records = lines.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<RuntimeTelemetryRecord>;
        return parsed.schema_version === 1 &&
            typeof parsed.command === "string" &&
            typeof parsed.duration_ms === "number" &&
            (parsed.result === "success" || parsed.result === "error")
          ? [parsed as RuntimeTelemetryRecord]
          : [];
      } catch {
        return [];
      }
    });
  }
  if (changeId) records = records.filter((record) => record.change_id === changeId);

  const byCommand: RuntimeTelemetrySummary["by_command"] = {};
  const byErrorCode: Record<string, number> = {};
  for (const record of records) {
    const aggregate = byCommand[record.command] ?? {
      count: 0,
      success_count: 0,
      error_count: 0,
      duration_ms: 0,
      response_bytes: 0,
    };
    aggregate.count += 1;
    aggregate.duration_ms += record.duration_ms;
    aggregate.response_bytes += record.response_bytes;
    if (record.result === "success") aggregate.success_count += 1;
    else aggregate.error_count += 1;
    byCommand[record.command] = aggregate;
    if (record.error_code) byErrorCode[record.error_code] = (byErrorCode[record.error_code] ?? 0) + 1;
  }

  const agentExecutions: RuntimeTelemetrySummary["agent_executions"] = {
    total_count: 0,
    completed_count: 0,
    incomplete_count: 0,
    total_duration_ms: 0,
    by_role: {},
  };
  const humanApprovalWait: RuntimeTelemetrySummary["human_approval_wait"] = {
    count: 0,
    total_duration_ms: 0,
    by_gate: {},
  };
  const tokenUsage: RuntimeTelemetrySummary["token_usage"] = {
    execution_count: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    by_role: {},
  };
  if (changeId) {
    const activePath = path.join(rocksRoot, "changes", changeId);
    const changeDir = await exists(activePath) ? activePath : await findArchivedChange(rocksRoot, changeId);
    if (changeDir) {
      const change = await readChange(changeDir);
      for (const execution of change.execution.registry) {
        const aggregate = agentExecutions.by_role[execution.role] ?? {
          count: 0,
          completed_count: 0,
          success_count: 0,
          error_count: 0,
          cancelled_count: 0,
          unknown_count: 0,
          duration_ms: 0,
        };
        const usage = execution.usage ?? {};
        const tokenAggregate = tokenUsage.by_role[execution.role] ?? {
          execution_count: 0,
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
        };
        tokenAggregate.execution_count += 1;
        tokenAggregate.input_tokens += usage.input_tokens ?? 0;
        tokenAggregate.cached_input_tokens += usage.cached_input_tokens ?? 0;
        tokenAggregate.output_tokens += usage.output_tokens ?? 0;
        tokenAggregate.reasoning_tokens += usage.reasoning_tokens ?? 0;
        tokenUsage.execution_count += 1;
        tokenUsage.input_tokens += usage.input_tokens ?? 0;
        tokenUsage.cached_input_tokens += usage.cached_input_tokens ?? 0;
        tokenUsage.output_tokens += usage.output_tokens ?? 0;
        tokenUsage.reasoning_tokens += usage.reasoning_tokens ?? 0;
        tokenUsage.by_role[execution.role] = tokenAggregate;
        aggregate.count += 1;
        agentExecutions.total_count += 1;
        if (execution.completed_at) {
          const duration = Math.max(0, Date.parse(execution.completed_at) - Date.parse(execution.started_at));
          aggregate.completed_count += 1;
          aggregate.duration_ms += duration;
          if (execution.outcome === "success") aggregate.success_count += 1;
          else if (execution.outcome === "error") aggregate.error_count += 1;
          else if (execution.outcome === "cancelled") aggregate.cancelled_count += 1;
          else aggregate.unknown_count += 1;
          agentExecutions.completed_count += 1;
          agentExecutions.total_duration_ms += duration;
        }
        agentExecutions.by_role[execution.role] = aggregate;
      }
      agentExecutions.incomplete_count = agentExecutions.total_count - agentExecutions.completed_count;
      agentExecutions.by_role = Object.fromEntries(
        Object.entries(agentExecutions.by_role).sort(([left], [right]) => left.localeCompare(right)),
      );
      tokenUsage.by_role = Object.fromEntries(
        Object.entries(tokenUsage.by_role).sort(([left], [right]) => left.localeCompare(right)),
      );

      const eventsPath = path.join(changeDir, "events.ndjson");
      if (await exists(eventsPath)) {
        const pending = new Map<string, number>();
        for (const line of (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)) {
          let event: EventRecord;
          try {
            event = JSON.parse(line) as EventRecord;
          } catch {
            continue;
          }
          const prepared = /^approval\.(spec|design|implementation)\.package\.prepared$/.exec(event.event);
          if (prepared?.[1]) pending.set(prepared[1], Date.parse(event.occurred_at));
          const recorded = /^approval\.(spec|design|implementation)\.recorded$/.exec(event.event);
          if (!recorded?.[1]) continue;
          const startedAt = pending.get(recorded[1]);
          if (startedAt === undefined) continue;
          const duration = Math.max(0, Date.parse(event.occurred_at) - startedAt);
          const aggregate = humanApprovalWait.by_gate[recorded[1]] ?? { count: 0, duration_ms: 0 };
          aggregate.count += 1;
          aggregate.duration_ms += duration;
          humanApprovalWait.by_gate[recorded[1]] = aggregate;
          humanApprovalWait.count += 1;
          humanApprovalWait.total_duration_ms += duration;
          pending.delete(recorded[1]);
        }
      }
    }
  }

  return {
    schema_version: 1,
    source_path: sourcePath,
    ...(changeId ? { change_id: changeId } : {}),
    record_count: records.length,
    success_count: records.filter((record) => record.result === "success").length,
    error_count: records.filter((record) => record.result === "error").length,
    internal_error_count: records.filter((record) => record.internal_error).length,
    total_duration_ms: records.reduce((total, record) => total + record.duration_ms, 0),
    first_started_at: records[0]?.started_at ?? null,
    last_finished_at: records.at(-1)?.finished_at ?? null,
    by_command: Object.fromEntries(Object.entries(byCommand).sort(([left], [right]) => left.localeCompare(right))),
    by_error_code: Object.fromEntries(Object.entries(byErrorCode).sort(([left], [right]) => left.localeCompare(right))),
    agent_executions: agentExecutions,
    human_approval_wait: humanApprovalWait,
    token_usage: tokenUsage,
  };
}

export async function activeChangeIds(rocksRoot: string): Promise<string[]> {
  const directory = path.join(rocksRoot, "changes");
  if (!(await exists(directory))) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function findArchivedChange(rocksRoot: string, id: string): Promise<string | undefined> {
  const archiveRoot = path.join(rocksRoot, "archive");
  if (!(await exists(archiveRoot))) return undefined;
  for (const year of await readdir(archiveRoot, { withFileTypes: true })) {
    if (!year.isDirectory()) continue;
    const yearPath = path.join(archiveRoot, year.name);
    for (const month of await readdir(yearPath, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const candidate = path.join(yearPath, month.name, id);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function changeLocationsAcrossWorktrees(root: string, id: string): Promise<string[]> {
  const locations: string[] = [];
  for (const worktreeRoot of await registeredWorktreeRoots(root)) {
    const rocksRoot = path.join(worktreeRoot, ".rockspec");
    const active = path.join(rocksRoot, "changes", id);
    if (await exists(active)) locations.push(active);
    const archived = await findArchivedChange(rocksRoot, id);
    if (archived) locations.push(archived);
  }
  return locations.sort();
}

export async function walkFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  if ((await stat(directory)).isFile()) return [directory];
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  }
  await visit(directory);
  return result.sort();
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
