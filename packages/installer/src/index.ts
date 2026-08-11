import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RockSpecEngine } from "@rockspec/engine";
import {
  InstallLockSchema,
  InstallManifestSchema,
  type InstallHost,
  type InstallLock,
  type InstallManifest,
  type ManagedInstallPath,
} from "@rockspec/protocol";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const LOCK_PATH = ".rockspec/install.lock.yaml";
const NOTICES_PATH = ".rockspec/third-party-notices.md";
const RUNTIME_PATH = ".rockspec/bin/rockspec.mjs";

export class InstallerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.details = details;
  }
}

export interface InstallProjectOptions {
  cwd?: string;
  projectRoot?: string;
  sourceRoot?: string;
  hosts: InstallHost[];
  withCapabilities?: string[];
  withoutCapabilities?: string[];
  externalSkills?: Record<string, string>;
  acceptUnknownLicense?: boolean;
  dryRun?: boolean;
  repair?: boolean;
  upgradeDependencies?: boolean;
  now?: () => Date;
}

export interface InstallPlanItem {
  path: string;
  kind: "file" | "directory" | "symlink";
  action: "create" | "replace" | "keep" | "remove";
  owner: "rockspec" | "external" | "adapter";
}

export interface InstallProjectResult {
  schema_version: 1;
  project_root: string;
  rockspec_version: string;
  dry_run: boolean;
  hosts: InstallHost[];
  capabilities: string[];
  plan: InstallPlanItem[];
  lock_path: string;
}

export interface DoctorFinding {
  code: string;
  path?: string;
  message: string;
}

export interface DoctorResult {
  schema_version: 1;
  project_root: string;
  valid: boolean;
  rockspec_version?: string;
  findings: DoctorFinding[];
}

export interface UninstallResult {
  schema_version: 1;
  project_root: string;
  removed: string[];
  retained: string[];
}

interface PlannedEntry {
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  owner: "rockspec" | "external" | "adapter";
  sourcePath?: string;
  linkTarget?: string;
  integrity: string;
}

interface ResolvedSkill {
  name: string;
  owner: "rockspec" | "external";
  capability?: string;
  sourceType: "bundled" | "local" | "git";
  sourceRef: string;
  license: string;
  sourcePath: string;
  integrity: string;
  cleanupRoot?: string;
}

export async function installProject(options: InstallProjectOptions): Promise<InstallProjectResult> {
  if (options.hosts.length === 0) {
    throw new InstallerError("HOST_REQUIRED", "Select at least one host");
  }
  const hosts = [...new Set(options.hosts)];
  const projectRoot = await resolveProjectRoot(options.projectRoot ?? options.cwd ?? process.cwd());
  const sourceRoot = await resolveSourceRoot(options.sourceRoot);
  const manifest = await readManifest(sourceRoot);
  const existingLock = await readInstallLock(projectRoot);
  const capabilities = selectedCapabilities(manifest, options.withCapabilities, options.withoutCapabilities);
  const skills = await resolveSkills(sourceRoot, projectRoot, manifest, capabilities, existingLock, options);
  try {
    const entries = await createEntries(sourceRoot, manifest, hosts, skills);
    const plan = await buildPlan(projectRoot, entries, existingLock, options.repair ?? false);
    if (!options.dryRun) {
      await commitInstall(projectRoot, manifest, hosts, capabilities, skills, entries, plan, existingLock, options.now ?? (() => new Date()));
    }
    return {
      schema_version: 1,
      project_root: projectRoot,
      rockspec_version: manifest.rockspec.version,
      dry_run: options.dryRun ?? false,
      hosts,
      capabilities,
      plan,
      lock_path: LOCK_PATH,
    };
  } finally {
    await Promise.all(skills.flatMap((skill) => skill.cleanupRoot ? [rm(skill.cleanupRoot, { recursive: true, force: true })] : []));
  }
}

export async function doctorProject(cwd = process.cwd()): Promise<DoctorResult> {
  const projectRoot = await resolveProjectRoot(cwd);
  const lock = await readInstallLock(projectRoot);
  if (!lock) {
    return {
      schema_version: 1,
      project_root: projectRoot,
      valid: false,
      findings: [{ code: "INSTALL_LOCK_MISSING", path: LOCK_PATH, message: "RockSpec is not installed in this project" }],
    };
  }
  const findings: DoctorFinding[] = [];
  for (const managed of lock.managed_paths) {
    const absolute = path.join(projectRoot, managed.path);
    if (!(await exists(absolute))) {
      findings.push({ code: "MANAGED_PATH_MISSING", path: managed.path, message: "Managed installation path is missing" });
      continue;
    }
    const actual = await hashPath(absolute);
    if (actual !== managed.integrity) {
      findings.push({ code: "MANAGED_PATH_MODIFIED", path: managed.path, message: "Managed installation path differs from install.lock.yaml" });
    }
  }
  for (const skill of Object.values(lock.skills)) {
    const skillFile = path.join(projectRoot, skill.canonical_path, "SKILL.md");
    if (!(await exists(skillFile))) {
      findings.push({ code: "SKILL_INVALID", path: `${skill.canonical_path}/SKILL.md`, message: `${skill.name} has no SKILL.md` });
    }
  }
  return {
    schema_version: 1,
    project_root: projectRoot,
    valid: findings.length === 0,
    rockspec_version: lock.rockspec.version,
    findings,
  };
}

export async function uninstallProject(cwd = process.cwd()): Promise<UninstallResult> {
  const projectRoot = await resolveProjectRoot(cwd);
  const lock = await readInstallLock(projectRoot);
  if (!lock) throw new InstallerError("INSTALL_LOCK_MISSING", "RockSpec is not installed in this project");
  const removed: string[] = [];
  const retained: string[] = [];
  for (const managed of [...lock.managed_paths].sort((left, right) => right.path.length - left.path.length)) {
    const absolute = path.join(projectRoot, managed.path);
    if (!(await exists(absolute))) continue;
    if (await hashPath(absolute) !== managed.integrity) {
      retained.push(managed.path);
      continue;
    }
    await rm(absolute, { recursive: true, force: true });
    removed.push(managed.path);
  }
  await rm(path.join(projectRoot, LOCK_PATH), { force: true });
  return { schema_version: 1, project_root: projectRoot, removed, retained };
}

export async function repairProject(options: Omit<InstallProjectOptions, "hosts" | "withCapabilities"> & { hosts?: InstallHost[] } = {}): Promise<InstallProjectResult> {
  const projectRoot = await resolveProjectRoot(options.projectRoot ?? options.cwd ?? process.cwd());
  const lock = await readInstallLock(projectRoot);
  if (!lock) throw new InstallerError("INSTALL_LOCK_MISSING", "RockSpec is not installed in this project");
  const sourceRoot = await resolveSourceRoot(options.sourceRoot);
  const manifest = await readManifest(sourceRoot);
  const capabilities = Object.values(lock.skills)
    .flatMap((skill) => skill.capability ? [skill.capability] : []);
  const unselectedCapabilities = Object.keys(manifest.capabilities)
    .filter((capability) => !capabilities.includes(capability));
  return installProject({
    ...options,
    projectRoot,
    sourceRoot,
    hosts: options.hosts ?? Object.keys(lock.hosts) as InstallHost[],
    withCapabilities: capabilities,
    withoutCapabilities: unselectedCapabilities,
    repair: true,
  });
}

export async function upgradeProject(options: Omit<InstallProjectOptions, "hosts" | "withCapabilities"> & { hosts?: InstallHost[] } = {}): Promise<InstallProjectResult> {
  return repairProject(options);
}

export async function findSourceRoot(explicit?: string): Promise<string> {
  return resolveSourceRoot(explicit);
}

export async function listInstalledProviders(cwd = process.cwd()): Promise<string[]> {
  let projectRoot: string;
  try {
    projectRoot = await resolveProjectRoot(cwd);
  } catch (error) {
    if (error instanceof InstallerError && error.code === "GIT_ROOT_REQUIRED") return [];
    throw error;
  }
  const lock = await readInstallLock(projectRoot);
  if (!lock) return [];
  return Object.values(lock.skills)
    .filter((skill) => skill.owner === "external" && skill.capability)
    .map((skill) => skill.name)
    .sort();
}

async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return await realpath(stdout.trim());
  } catch (error) {
    throw new InstallerError("GIT_ROOT_REQUIRED", "RockSpec installation requires a Git repository", {
      cwd,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveSourceRoot(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.ROCKSPEC_DISTRIBUTION_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    let current = path.resolve(candidate);
    while (true) {
      if (await exists(path.join(current, "distribution", "install-manifest.yaml")) && await exists(path.join(current, "skills"))) {
        return await realpath(current);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new InstallerError("DISTRIBUTION_NOT_FOUND", "Cannot locate the RockSpec distribution root");
}

async function readManifest(sourceRoot: string): Promise<InstallManifest> {
  const manifestPath = path.join(sourceRoot, "distribution", "install-manifest.yaml");
  const parsed = InstallManifestSchema.safeParse(parse(await readFile(manifestPath, "utf8")));
  if (!parsed.success) {
    throw new InstallerError("INVALID_INSTALL_MANIFEST", "distribution/install-manifest.yaml is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

async function readInstallLock(projectRoot: string): Promise<InstallLock | null> {
  const lockPath = path.join(projectRoot, LOCK_PATH);
  if (!(await exists(lockPath))) return null;
  const parsed = InstallLockSchema.safeParse(parse(await readFile(lockPath, "utf8")));
  if (!parsed.success) {
    throw new InstallerError("INVALID_INSTALL_LOCK", `${LOCK_PATH} is invalid`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function selectedCapabilities(manifest: InstallManifest, withCapabilities: string[] = [], withoutCapabilities: string[] = []): string[] {
  const selected = new Set(
    Object.entries(manifest.capabilities)
      .filter(([, binding]) => binding.default)
      .map(([capability]) => capability),
  );
  for (const capability of withCapabilities) {
    if (!(capability in manifest.capabilities)) {
      throw new InstallerError("CAPABILITY_NOT_FOUND", `Unknown install capability ${capability}`);
    }
    selected.add(capability);
  }
  for (const capability of withoutCapabilities) selected.delete(capability);
  return [...selected].sort();
}

async function resolveSkills(
  sourceRoot: string,
  projectRoot: string,
  manifest: InstallManifest,
  capabilities: string[],
  existingLock: InstallLock | null,
  options: InstallProjectOptions,
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];
  for (const name of manifest.rockspec.skills) {
    const sourcePath = path.join(sourceRoot, "skills", name);
    await validateSkill(sourcePath, name);
    resolved.push({
      name,
      owner: "rockspec",
      sourceType: "bundled",
      sourceRef: `rockspec@${manifest.rockspec.version}`,
      license: "MIT",
      sourcePath,
      integrity: await hashPath(sourcePath),
    });
  }
  for (const capability of capabilities) {
    const binding = manifest.capabilities[capability];
    if (!binding) continue;
    const name = binding.provider;
    const dependency = manifest.external_skills[name];
    if (!dependency) throw new InstallerError("EXTERNAL_SKILL_NOT_DECLARED", `No dependency declaration exists for ${name}`);
    const preserved = existingLock?.skills[name];
    const preservedPath = preserved ? path.join(projectRoot, preserved.canonical_path) : undefined;
    if (preserved && preservedPath && await exists(preservedPath) && !options.upgradeDependencies && !options.externalSkills?.[name]) {
      resolved.push({
        name,
        owner: "external",
        capability,
        sourceType: preserved.source_type === "git" ? "git" : "local",
        sourceRef: preserved.source_ref,
        license: preserved.license,
        sourcePath: preservedPath,
        integrity: await hashPath(preservedPath),
      });
      continue;
    }
    const explicit = options.externalSkills?.[name];
    const external = explicit
      ? { sourcePath: path.resolve(explicit), sourceType: "local" as const, sourceRef: `explicit-local:${name}` }
      : await resolveExternalSource(name, dependency);
    if (dependency.license === "UNKNOWN" && !options.acceptUnknownLicense) {
      if (external.cleanupRoot) await rm(external.cleanupRoot, { recursive: true, force: true });
      throw new InstallerError("EXTERNAL_LICENSE_UNCONFIRMED", `${name} has no verified license`, {
        skill: name,
        capability,
      });
    }
    await validateSkill(external.sourcePath, name);
    const integrity = await hashPath(external.sourcePath);
    if (dependency.source.type === "git" && integrity !== dependency.source.integrity) {
      if (external.cleanupRoot) await rm(external.cleanupRoot, { recursive: true, force: true });
      throw new InstallerError("EXTERNAL_INTEGRITY_MISMATCH", `${name} does not match its pinned integrity`, {
        expected: dependency.source.integrity,
        actual: integrity,
      });
    }
    resolved.push({
      name,
      owner: "external",
      capability,
      sourceType: external.sourceType,
      sourceRef: external.sourceRef,
      license: dependency.license,
      sourcePath: external.sourcePath,
      integrity,
      ...(external.cleanupRoot ? { cleanupRoot: external.cleanupRoot } : {}),
    });
  }
  return resolved;
}

async function resolveExternalSource(name: string, dependency: InstallManifest["external_skills"][string]): Promise<{
  sourcePath: string;
  sourceType: "local" | "git";
  sourceRef: string;
  cleanupRoot?: string;
}> {
  if (dependency.source.type === "local-discovery") {
    for (const candidate of dependency.source.candidates) {
      const absolute = path.join(os.homedir(), candidate);
      if (await exists(absolute)) {
        return { sourcePath: absolute, sourceType: "local", sourceRef: `user-skill-root:${name}` };
      }
    }
    throw new InstallerError("EXTERNAL_SKILL_NOT_FOUND", `Cannot find required external Skill ${name}`, {
      candidates: dependency.source.candidates,
    });
  }
  const checkout = await mkdtemp(path.join(os.tmpdir(), `rockspec-${name}-`));
  try {
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", dependency.source.repository, checkout]);
    await execFileAsync("git", ["checkout", "--quiet", "--detach", dependency.source.commit], { cwd: checkout });
    return {
      sourcePath: path.join(checkout, dependency.source.subdirectory),
      sourceType: "git",
      sourceRef: `${dependency.source.repository}@${dependency.source.commit}:${dependency.source.subdirectory}`,
      cleanupRoot: checkout,
    };
  } catch (error) {
    await rm(checkout, { recursive: true, force: true });
    throw new InstallerError("EXTERNAL_FETCH_FAILED", `Failed to fetch ${name}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createEntries(
  sourceRoot: string,
  manifest: InstallManifest,
  hosts: InstallHost[],
  skills: ResolvedSkill[],
): Promise<PlannedEntry[]> {
  const entries: PlannedEntry[] = [];
  for (const skill of skills) {
    entries.push({
      relativePath: `.agents/skills/${skill.name}`,
      kind: "directory",
      owner: skill.owner,
      sourcePath: skill.sourcePath,
      integrity: skill.integrity,
    });
  }
  if (hosts.includes("claude")) {
    for (const skill of skills) {
      if (process.platform === "win32") {
        entries.push({
          relativePath: `.claude/skills/${skill.name}`,
          kind: "directory",
          owner: "adapter",
          sourcePath: skill.sourcePath,
          integrity: skill.integrity,
        });
      } else {
        const target = `../../.agents/skills/${skill.name}`;
        entries.push({
          relativePath: `.claude/skills/${skill.name}`,
          kind: "symlink",
          owner: "adapter",
          linkTarget: target,
          integrity: hashBytes(`symlink:${target}`),
        });
      }
    }
  }
  const runtimeSource = path.join(sourceRoot, manifest.rockspec.runtime);
  if (!(await exists(runtimeSource))) {
    throw new InstallerError("RUNTIME_NOT_BUILT", `Build the project Runtime before installation`, {
      path: manifest.rockspec.runtime,
    });
  }
  entries.push({
    relativePath: RUNTIME_PATH,
    kind: "file",
    owner: "rockspec",
    sourcePath: runtimeSource,
    integrity: await hashPath(runtimeSource),
  });
  const notices = noticesContent(skills);
  entries.push({
    relativePath: NOTICES_PATH,
    kind: "file",
    owner: "rockspec",
    integrity: hashBytes(notices),
    sourcePath: `content:${notices}`,
  });
  return entries;
}

async function buildPlan(projectRoot: string, entries: PlannedEntry[], lock: InstallLock | null, repair: boolean): Promise<InstallPlanItem[]> {
  const managed = new Map(lock?.managed_paths.map((entry) => [entry.path, entry]) ?? []);
  const desired = new Set(entries.map((entry) => entry.relativePath));
  const plan: InstallPlanItem[] = [];
  for (const entry of entries) {
    const absolute = path.join(projectRoot, entry.relativePath);
    if (!(await exists(absolute))) {
      plan.push({ path: entry.relativePath, kind: entry.kind, action: "create", owner: entry.owner });
      continue;
    }
    const current = await hashPath(absolute);
    if (current === entry.integrity) {
      plan.push({ path: entry.relativePath, kind: entry.kind, action: "keep", owner: entry.owner });
      continue;
    }
    const previous = managed.get(entry.relativePath);
    if (!previous || current !== previous.integrity) {
      throw new InstallerError("INSTALL_PATH_CONFLICT", `Refusing to overwrite a modified or unmanaged path`, {
        path: entry.relativePath,
        expected_previous: previous?.integrity,
        actual: current,
        repair,
      });
    }
    plan.push({ path: entry.relativePath, kind: entry.kind, action: "replace", owner: entry.owner });
  }
  for (const previous of lock?.managed_paths ?? []) {
    if (desired.has(previous.path)) continue;
    const absolute = path.join(projectRoot, previous.path);
    if (!(await exists(absolute))) continue;
    const current = await hashPath(absolute);
    if (current !== previous.integrity) {
      throw new InstallerError("INSTALL_PATH_CONFLICT", "Refusing to remove a modified managed path", {
        path: previous.path,
        expected_previous: previous.integrity,
        actual: current,
        repair,
      });
    }
    plan.push({
      path: previous.path,
      kind: previous.kind,
      action: "remove",
      owner: previousOwner(previous.path, lock),
    });
  }
  return plan;
}

function previousOwner(pathName: string, lock: InstallLock | null): InstallPlanItem["owner"] {
  if (pathName.startsWith(".claude/skills/")) return "adapter";
  const skill = Object.values(lock?.skills ?? {}).find((candidate) => candidate.canonical_path === pathName);
  return skill?.owner ?? "rockspec";
}

async function commitInstall(
  projectRoot: string,
  manifest: InstallManifest,
  hosts: InstallHost[],
  capabilities: string[],
  skills: ResolvedSkill[],
  entries: PlannedEntry[],
  plan: InstallPlanItem[],
  existingLock: InstallLock | null,
  now: () => Date,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(projectRoot, ".rockspec-install-"));
  const stagedRoot = path.join(tempRoot, "staged");
  const backupRoot = path.join(tempRoot, "backup");
  const committed: string[] = [];
  const backedUp: string[] = [];
  const configExisted = await exists(path.join(projectRoot, ".rockspec", "config.yaml"));
  try {
    for (const entry of entries) {
      if (plan.find((item) => item.path === entry.relativePath)?.action === "keep") continue;
      const staged = path.join(stagedRoot, entry.relativePath);
      await mkdir(path.dirname(staged), { recursive: true });
      if (entry.kind === "symlink") {
        await symlink(entry.linkTarget!, staged);
      } else if (entry.kind === "directory") {
        await cp(entry.sourcePath!, staged, { recursive: true, dereference: false, errorOnExist: true });
      } else if (entry.sourcePath?.startsWith("content:")) {
        await writeFile(staged, entry.sourcePath.slice("content:".length));
      } else {
        await cp(entry.sourcePath!, staged);
      }
    }
    for (const item of plan.filter((candidate) => candidate.action !== "keep")) {
      const target = path.join(projectRoot, item.path);
      if (item.action === "replace" || item.action === "remove") {
        const backup = path.join(backupRoot, item.path);
        await mkdir(path.dirname(backup), { recursive: true });
        await rename(target, backup);
        backedUp.push(item.path);
      }
      if (item.action === "remove") continue;
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(stagedRoot, item.path), target);
      committed.push(item.path);
    }
    await new RockSpecEngine({ cwd: projectRoot }).init();
    const managedPaths: ManagedInstallPath[] = entries.map((entry) => ({
      path: entry.relativePath,
      kind: entry.kind,
      integrity: entry.integrity,
    }));
    const runtime = entries.find((entry) => entry.relativePath === RUNTIME_PATH)!;
    const lock: InstallLock = {
      schema_version: 1,
      rockspec: {
        version: manifest.rockspec.version,
        runtime_path: RUNTIME_PATH,
        integrity: runtime.integrity,
      },
      installed_at: now().toISOString(),
      hosts: Object.fromEntries(hosts.map((host) => [host, {
        skills_root: host === "codex" ? ".agents/skills" : ".claude/skills",
        mode: host === "codex" ? "canonical" : process.platform === "win32" ? "copy" : "symlink",
      }])) as InstallLock["hosts"],
      skills: Object.fromEntries(skills.map((skill) => [skill.name, {
        name: skill.name,
        owner: skill.owner,
        ...(skill.capability ? { capability: skill.capability } : {}),
        source_type: skill.sourceType,
        source_ref: skill.sourceRef,
        license: skill.license,
        integrity: skill.integrity,
        canonical_path: `.agents/skills/${skill.name}`,
      }])),
      managed_paths: managedPaths,
    };
    const parsedLock = InstallLockSchema.parse(lock);
    const lockTarget = path.join(projectRoot, LOCK_PATH);
    const lockTemp = path.join(tempRoot, "install.lock.yaml");
    await writeFile(lockTemp, stringify(parsedLock, { lineWidth: 0 }));
    await mkdir(path.dirname(lockTarget), { recursive: true });
    if (await exists(lockTarget)) {
      const backup = path.join(backupRoot, LOCK_PATH);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(lockTarget, backup);
      backedUp.push(LOCK_PATH);
    }
    await rename(lockTemp, lockTarget);
    committed.push(LOCK_PATH);
    void capabilities;
  } catch (error) {
    for (const relative of [...committed].reverse()) {
      await rm(path.join(projectRoot, relative), { recursive: true, force: true });
    }
    for (const relative of [...backedUp].reverse()) {
      const backup = path.join(backupRoot, relative);
      if (await exists(backup)) {
        const target = path.join(projectRoot, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(backup, target);
      }
    }
    if (!configExisted) await rm(path.join(projectRoot, ".rockspec", "config.yaml"), { force: true });
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  void existingLock;
}

async function validateSkill(skillRoot: string, expectedName: string): Promise<void> {
  if (!(await exists(skillRoot))) throw new InstallerError("SKILL_SOURCE_MISSING", `Skill source ${expectedName} does not exist`);
  const canonical = await realpath(skillRoot);
  const skillFile = path.join(canonical, "SKILL.md");
  if (!(await exists(skillFile))) throw new InstallerError("SKILL_INVALID", `${expectedName} has no SKILL.md`);
  const content = await readFile(skillFile, "utf8");
  const name = /^---\s*\nname:\s*["']?([^\n"']+)["']?/m.exec(content)?.[1]?.trim();
  if (name !== expectedName) {
    throw new InstallerError("SKILL_NAME_MISMATCH", `Skill ${expectedName} declares name ${name ?? "missing"}`);
  }
  for (const file of await walk(canonical)) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(file);
      if (resolved !== canonical && !resolved.startsWith(`${canonical}${path.sep}`)) {
        throw new InstallerError("SKILL_SYMLINK_ESCAPE", `${expectedName} contains a symlink outside its root`, {
          path: path.relative(canonical, file),
        });
      }
    }
  }
}

async function hashPath(target: string): Promise<string> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) return hashBytes(`symlink:${await readlink(target)}`);
  if (info.isFile()) return hashBytes(await readFile(target));
  const hash = createHash("sha256");
  for (const file of await walk(target)) {
    const relative = path.relative(target, file).split(path.sep).join("/");
    const child = await lstat(file);
    if (child.isDirectory()) {
      hash.update(`directory:${relative}\0`);
    } else if (child.isSymbolicLink()) {
      hash.update(`symlink:${relative}:${await readlink(file)}\0`);
    } else {
      hash.update(`file:${relative}\0`);
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function hashBytes(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function walk(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      result.push(absolute);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolute);
    }
  };
  await visit(root);
  return result;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT" ? Promise.reject(error) : false;
  }
}

function noticesContent(skills: ResolvedSkill[]): string {
  const external = skills.filter((skill) => skill.owner === "external");
  const lines = [
    "# RockSpec Third-Party Skill Notices",
    "",
    "External Skills are installed as transparent project files and are not authored or redistributed as part of RockSpec itself.",
    "",
  ];
  if (external.length === 0) lines.push("No external Skills are installed.", "");
  for (const skill of external) {
    lines.push(`## ${skill.name}`, "", `- Capability: ${skill.capability ?? "UNKNOWN"}`, `- Source: ${skill.sourceRef}`, `- License: ${skill.license}`, `- Integrity: ${skill.integrity}`, "");
  }
  return `${lines.join("\n")}\n`;
}
