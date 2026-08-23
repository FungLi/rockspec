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
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  type Config,
  parseChangeSnapshot as parseProtocolChangeSnapshot,
  parseConfig as parseProtocolConfig,
} from "@rockspec/protocol";
import { RockSpecError } from "./error.js";
import type { ChangeSnapshot, EventRecord } from "./types.js";

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
  max_reconciliation_rounds: 2,
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

export async function readChange(changeDir: string): Promise<ChangeSnapshot> {
  const source = path.join(changeDir, "change.yaml");
  if (!(await exists(source))) {
    throw new RockSpecError("CHANGE_NOT_FOUND", "The change snapshot does not exist", { source });
  }
  return parseChangeText(await readFile(source, "utf8"), source);
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
