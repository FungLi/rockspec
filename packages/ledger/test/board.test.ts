import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger, sha256 } from "../src/index.js";

async function tmpRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rockspec-board-"));
}

const REQ = `# 需求
## 功能需求
### R-001 登录
系统 MUST 校验凭据。
#### S-001 场景
- GIVEN 已注册
- WHEN 提交
- THEN 成功
`;

function maker(id: string, role: string, hash: string, registers?: unknown[]) {
  return {
    kind: "maker",
    role,
    artifact_id: id,
    output_path: `${id}.md`,
    output_hash: hash,
    self_report: "done",
    blockers: [],
    ...(registers ? { registers } : {}),
  };
}

function checker(id: string, role: string, hash: string, verdict: string) {
  return {
    kind: "checker",
    role,
    artifact_id: id,
    subject_hash: hash,
    hook_marks_seen: "clean",
    verdict,
    ...(verdict === "PASS"
      ? { findings: [] }
      : { problem_owner: "ba", findings: [{ id: "F-1", severity: "important", evidence: "e", route_to: "ba" }] }),
  };
}

describe("看板 Board", () => {
  it("投影出五列，卡按 status 分列，owner 由列推导", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    const board = await l.board("board-demo");
    // 全部初始在 backlog
    expect(board.columns.backlog.map((c) => c.artifact_id)).toEqual(["requirements", "design", "code"]);
    // backlog 卡 owner 为 null
    expect(board.columns.backlog.every((c) => c.owner === null)).toBe(true);
  });

  it("nextPullable 只返回依赖已 done 的卡", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    // 初始只有 requirements 可拉取（design/code 有依赖）
    let board = await l.board("board-demo");
    expect(board.next_pullable).toEqual(["requirements"]);

    // 完成 requirements
    await writeFile(l.artifactPath("board-demo", "requirements", "requirements"), REQ);
    const h = sha256(REQ);
    await l.submitMaker("board-demo", maker("requirements", "ba", h));
    await l.check("board-demo", "requirements");
    await l.submitChecker("board-demo", checker("requirements", "rr", h, "PASS"));

    // 现在 design 可拉取，code 仍不可（依赖 design）
    board = await l.board("board-demo");
    expect(board.next_pullable).toEqual(["design"]);
    expect(board.columns.done.map((c) => c.artifact_id)).toEqual(["requirements"]);
  });

  it("making 中的卡 owner 为 maker，进 review 后 owner 为 checker", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    await l.startMaking("board-demo", "requirements");
    let board = await l.board("board-demo");
    let card = board.cards.find((c) => c.artifact_id === "requirements")!;
    expect(card.column).toBe("in_progress");
    expect(card.owner).toBe("ba");

    await writeFile(l.artifactPath("board-demo", "requirements", "requirements"), REQ);
    await l.submitMaker("board-demo", maker("requirements", "ba", sha256(REQ)));
    board = await l.board("board-demo");
    card = board.cards.find((c) => c.artifact_id === "requirements")!;
    expect(card.column).toBe("review");
    expect(card.owner).toBe("rr");
  });

  it("blocked 列分 rework / escalated 两子区，owner 分别为 maker / human", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    const h = sha256(REQ);
    await writeFile(l.artifactPath("board-demo", "requirements", "requirements"), REQ);

    // escalated：带 blockers
    await l.submitMaker("board-demo", { ...maker("requirements", "ba", h), blockers: [{ summary: "冲突" }] });
    let board = await l.board("board-demo");
    let card = board.cards.find((c) => c.artifact_id === "requirements")!;
    expect(card.column).toBe("blocked");
    expect(card.blocked_lane).toBe("escalated");
    expect(card.owner).toBe("human");
  });

  it("REJECT 打回 → rework 子区，owner 回 maker", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    const h = sha256(REQ);
    await writeFile(l.artifactPath("board-demo", "requirements", "requirements"), REQ);
    await l.submitMaker("board-demo", maker("requirements", "ba", h));
    await l.submitChecker("board-demo", checker("requirements", "rr", h, "REJECT"));
    const board = await l.board("board-demo");
    const card = board.cards.find((c) => c.artifact_id === "requirements")!;
    expect(card.column).toBe("blocked");
    expect(card.blocked_lane).toBe("rework");
    expect(card.owner).toBe("ba");
  });

  it("SA registers 动态注册多个 code Task 进看板", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    await writeFile(l.artifactPath("board-demo", "design", "design"), "# d");
    const h = sha256("# d");
    await l.submitMaker("board-demo", maker("design", "sa", h, [
      { artifact_id: "W-01", depends_on: ["design"] },
      { artifact_id: "W-02", depends_on: ["design"] },
    ]));
    const board = await l.board("board-demo");
    expect(board.cards.map((c) => c.artifact_id)).toContain("W-01");
    expect(board.cards.map((c) => c.artifact_id)).toContain("W-02");
    const w1 = board.cards.find((c) => c.artifact_id === "W-01")!;
    expect(w1.maker_role).toBe("dev");
    expect(w1.checker_role).toBe("cr");
  });

  it("board.md 在写命令后自动生成", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    const mdPath = path.join(root, ".rockspec", "changes", "board-demo", "board.md");
    expect(existsSync(mdPath)).toBe(true);
    const md = await readFile(mdPath, "utf8");
    expect(md).toContain("请勿手动编辑");
    expect(md).toContain("# 看板：board-demo");
    expect(md).toContain("Backlog");
  });

  it("关键链路计算最长依赖链", async () => {
    const root = await tmpRepo();
    const l = new Ledger(root);
    await l.createChange("board-demo");
    const board = await l.board("board-demo");
    // requirements → design → code
    expect(board.critical_path).toEqual(["requirements", "design", "code"]);
  });
});
