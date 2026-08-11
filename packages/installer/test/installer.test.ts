import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { InstallLockSchema } from "@rockspec/protocol";
import {
  InstallerError,
  doctorProject,
  installProject,
  listInstalledProviders,
  repairProject,
  uninstallProject,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];
const sourceRoot = process.cwd();

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rockspec-installer-")));
  repositories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "installer-test@rockspec.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RockSpec Installer Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: initial"], { cwd: root });
  return root;
}

describe("RockSpec project installer", () => {
  it("installs idempotent project Skills, host adapters, Runtime, and repairs missing files", async () => {
    const root = await repository();
    const installed = await installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex", "claude"],
      withoutCapabilities: ["ui.prototype"],
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });

    expect(installed.plan.filter((item) => item.owner === "rockspec" && item.kind === "directory")).toHaveLength(13);
    const lock = InstallLockSchema.parse(parse(await readFile(path.join(root, ".rockspec", "install.lock.yaml"), "utf8")));
    expect(Object.keys(lock.skills)).toHaveLength(13);
    expect(lock.hosts).toMatchObject({
      codex: { skills_root: ".agents/skills", mode: "canonical" },
      claude: { skills_root: ".claude/skills", mode: process.platform === "win32" ? "copy" : "symlink" },
    });
    if (process.platform !== "win32") {
      await expect(readlink(path.join(root, ".claude", "skills", "rockspec-change")))
        .resolves.toBe("../../.agents/skills/rockspec-change");
    }
    await expect(readFile(path.join(root, ".rockspec", "bin", "rockspec.mjs"), "utf8"))
      .resolves.toContain("#!/usr/bin/env node");
    await expect(doctorProject(root)).resolves.toMatchObject({ valid: true, findings: [] });

    const repeated = await installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex", "claude"],
      withoutCapabilities: ["ui.prototype"],
    });
    expect(repeated.plan.every((item) => item.action === "keep")).toBe(true);

    await rm(path.join(root, ".agents", "skills", "rockspec-debug"), { recursive: true });
    expect((await doctorProject(root)).findings).toContainEqual(expect.objectContaining({
      code: "MANAGED_PATH_MISSING",
      path: ".agents/skills/rockspec-debug",
    }));
    await repairProject({ projectRoot: root, sourceRoot });
    await expect(doctorProject(root)).resolves.toMatchObject({ valid: true });

    const reduced = await installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex"],
      withoutCapabilities: ["ui.prototype"],
    });
    expect(reduced.plan.filter((item) => item.action === "remove" && item.owner === "adapter"))
      .toHaveLength(13);
    await expect(readlink(path.join(root, ".claude", "skills", "rockspec-change")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const reducedLock = InstallLockSchema.parse(parse(await readFile(path.join(root, ".rockspec", "install.lock.yaml"), "utf8")));
    expect(reducedLock.hosts).toEqual({
      codex: { skills_root: ".agents/skills", mode: "canonical" },
    });
  });

  it("installs an explicitly accepted external Skill and records its provenance", async () => {
    const root = await repository();
    const externalRoot = path.join(root, "external-source", "ui-ux-pro-max");
    await mkdir(path.join(externalRoot, "references"), { recursive: true });
    await writeFile(path.join(externalRoot, "SKILL.md"), "---\nname: ui-ux-pro-max\ndescription: Test UI provider.\n---\n\n# UI Provider\n");
    await writeFile(path.join(externalRoot, "references", "rules.md"), "# Rules\n");

    await expect(installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex"],
      externalSkills: { "ui-ux-pro-max": externalRoot },
    })).rejects.toSatisfy((error: unknown) => error instanceof InstallerError && error.code === "EXTERNAL_LICENSE_UNCONFIRMED");

    await installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex"],
      externalSkills: { "ui-ux-pro-max": externalRoot },
      acceptUnknownLicense: true,
    });
    const lock = InstallLockSchema.parse(parse(await readFile(path.join(root, ".rockspec", "install.lock.yaml"), "utf8")));
    expect(lock.skills["ui-ux-pro-max"]).toMatchObject({
      owner: "external",
      capability: "ui.prototype",
      source_type: "local",
      source_ref: "explicit-local:ui-ux-pro-max",
      license: "UNKNOWN",
    });
    await expect(readFile(path.join(root, ".rockspec", "third-party-notices.md"), "utf8"))
      .resolves.toContain("## ui-ux-pro-max");
    await expect(listInstalledProviders(root)).resolves.toEqual(["ui-ux-pro-max"]);

    const withoutExternal = await installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex"],
      withoutCapabilities: ["ui.prototype"],
    });
    expect(withoutExternal.plan).toContainEqual(expect.objectContaining({
      path: ".agents/skills/ui-ux-pro-max",
      action: "remove",
      owner: "external",
    }));
    await expect(readFile(path.join(root, ".agents", "skills", "ui-ux-pro-max", "SKILL.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const reducedLock = InstallLockSchema.parse(parse(await readFile(path.join(root, ".rockspec", "install.lock.yaml"), "utf8")));
    expect(reducedLock.skills["ui-ux-pro-max"]).toBeUndefined();
    await expect(listInstalledProviders(root)).resolves.toEqual([]);
  });

  it("refuses modified managed paths and only uninstalls unchanged files", async () => {
    const root = await repository();
    await installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex"],
      withoutCapabilities: ["ui.prototype"],
    });
    const modified = path.join(root, ".agents", "skills", "rockspec-change", "SKILL.md");
    await writeFile(modified, `${await readFile(modified, "utf8")}\nLocal project customization.\n`);

    await expect(installProject({
      projectRoot: root,
      sourceRoot,
      hosts: ["codex"],
      withoutCapabilities: ["ui.prototype"],
    })).rejects.toSatisfy((error: unknown) => error instanceof InstallerError && error.code === "INSTALL_PATH_CONFLICT");
    expect((await doctorProject(root)).valid).toBe(false);

    const uninstalled = await uninstallProject(root);
    expect(uninstalled.retained).toContain(".agents/skills/rockspec-change");
    expect(uninstalled.removed).toContain(".rockspec/bin/rockspec.mjs");
    await expect(readFile(modified, "utf8")).resolves.toContain("Local project customization");
    await expect(readFile(path.join(root, ".rockspec", "config.yaml"), "utf8")).resolves.toContain("schema_version");
  });
});
