import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseChangeSnapshot, type ChangeSnapshot } from "@rockspec/protocol";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { RockSpecEngine } from "../src/index.js";
import { readChange } from "../src/storage.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rockspec-state-tx-")));
  repositories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "state@rockspec.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "RockSpec State Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "test: initial"], { cwd: root });
  const engine = new RockSpecEngine({ cwd: root, now: () => new Date("2026-08-23T10:00:00.000Z") });
  await engine.init();
  const id = "recover-state-transaction";
  await engine.newChange({ id, profile: "lite", kind: "copy" });
  const changeDir = path.join(root, ".rockspec", "changes", id);
  const beforeContent = await readFile(path.join(changeDir, "change.yaml"), "utf8");
  const before = parseChangeSnapshot(parse(beforeContent));
  const after: ChangeSnapshot = {
    ...before,
    state: "IMPLEMENTING",
    updated_at: "2026-08-23T10:01:00.000Z",
  };
  const afterContent = stringify(parseChangeSnapshot(after), { lineWidth: 0 });
  const event = {
    schema_version: 1 as const,
    sequence: 2,
    event: "action.change.triage.completed",
    change_id: id,
    occurred_at: after.updated_at,
    previous_state: "SCOPING" as const,
    current_state: "IMPLEMENTING" as const,
    data: { recovered: true },
  };
  const journal = stringify({
    schema_version: 1,
    before_hash: digest(beforeContent),
    after_hash: digest(afterContent),
    after_snapshot: after,
    event,
  }, { lineWidth: 0 });
  await mkdir(path.join(changeDir, "runtime"), { recursive: true });
  return { changeDir, beforeContent, afterContent, event, journal };
}

describe("state transaction recovery", () => {
  it("finishes a snapshot-first mutation whose event append was interrupted", async () => {
    const { changeDir, afterContent, journal } = await fixture();
    await writeFile(path.join(changeDir, "change.yaml"), afterContent);
    await writeFile(path.join(changeDir, "runtime", "state-transaction.yaml"), journal);

    await expect(readChange(changeDir)).resolves.toMatchObject({ state: "IMPLEMENTING" });
    expect((await readFile(path.join(changeDir, "events.ndjson"), "utf8")).trim().split("\n")).toHaveLength(2);
    await expect(readFile(path.join(changeDir, "runtime", "state-transaction.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes an event-first mutation whose snapshot write was interrupted", async () => {
    const { changeDir, event, journal } = await fixture();
    await writeFile(path.join(changeDir, "events.ndjson"), `${JSON.stringify(event)}\n`, { flag: "a" });
    await writeFile(path.join(changeDir, "runtime", "state-transaction.yaml"), journal);

    await expect(readChange(changeDir)).resolves.toMatchObject({ state: "IMPLEMENTING" });
    expect((await readFile(path.join(changeDir, "events.ndjson"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("rejects a conflicting event at the pending transaction sequence", async () => {
    const { changeDir, event, journal } = await fixture();
    await writeFile(
      path.join(changeDir, "events.ndjson"),
      `${JSON.stringify({ ...event, event: "conflicting.event" })}\n`,
      { flag: "a" },
    );
    await writeFile(path.join(changeDir, "runtime", "state-transaction.yaml"), journal);

    await expect(readChange(changeDir)).rejects.toMatchObject({ code: "STATE_TRANSACTION_DIVERGED" });
  });
});
