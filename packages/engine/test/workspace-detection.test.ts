import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectGitWorkspace } from "../src/storage.js";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

async function initRepository(root: string, file: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "workspace-test@rockspec.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RockSpec Workspace Test"], { cwd: root });
  await writeFile(path.join(root, file), "fixture\n");
  await execFileAsync("git", ["add", file], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: initial"], { cwd: root });
}

describe("Git workspace detection", () => {
  it("distinguishes a checkout and submodule from a linked Worktree", async () => {
    const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), "rockspec-workspace-")));
    fixtures.push(fixture);
    const source = path.join(fixture, "source");
    const parent = path.join(fixture, "parent");
    await initRepository(source, "SOURCE.md");
    await initRepository(parent, "README.md");

    await execFileAsync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", source, "modules/child"],
      { cwd: parent },
    );
    const submodule = path.join(parent, "modules", "child");
    expect((await inspectGitWorkspace(parent)).mode).toBe("current");
    expect((await inspectGitWorkspace(submodule)).mode).toBe("current");

    const linked = path.join(parent, ".worktrees", "isolated");
    await execFileAsync("git", ["worktree", "add", linked, "-b", "rockspec/isolated", "main"], {
      cwd: parent,
    });
    expect(await inspectGitWorkspace(linked)).toMatchObject({
      mode: "worktree",
      branch: "rockspec/isolated",
    });
  });
});
