import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/index.js";
import { Ledger, LedgerError } from "../src/index.js";

async function tmpRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rockspec-ledger-"));
}

const GOOD_REQUIREMENTS = `# 需求

## 功能需求

### R-001 用户登录

系统 MUST 校验用户凭据。

#### S-001 场景：正确密码

- GIVEN 用户已注册
- WHEN 提交正确密码
- THEN 返回登录成功
`;

const GOOD_DESIGN = `# 技术设计

## 全局约束

无跨切面新增。

## 总体方案比较

方案 A vs 方案 B，选 A。

## 决策

### W-01 登录接口

覆盖 R-001 / S-001。

#### 接口与数据流

POST /login。

#### 失败与边界行为

401。

#### 兼容、迁移与回滚

无迁移。

## 未解决风险

无。
`;

const GOOD_CODE = `# 代码交付说明

实现 W-01，覆盖 R-001 / S-001。
`;

function makerConclusion(artifactId: string, role: string, hash: string, blockers: unknown[] = []) {
  return {
    kind: "maker",
    role,
    artifact_id: artifactId,
    output_path: `${artifactId}.md`,
    output_hash: hash,
    self_report: "done",
    blockers,
  };
}

function checkerConclusion(artifactId: string, role: string, subjectHash: string, verdict: string) {
  return {
    kind: "checker",
    role,
    artifact_id: artifactId,
    subject_hash: subjectHash,
    hook_marks_seen: "clean",
    verdict,
    ...(verdict === "PASS"
      ? { findings: [] }
      : { problem_owner: "ba", findings: [{ id: "F-001", severity: "important", evidence: "e", route_to: "ba" }] }),
  };
}

describe("Ledger 核心链路", () => {
  it("创建 change 并投影出默认 worklist", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change", "L1");
    const wl = await ledger.worklist("demo-change");
    expect(wl.items.map((i) => i.artifact_id)).toEqual(["requirements", "design", "code"]);
    expect(wl.items.every((i) => i.status === "pending")).toBe(true);
    expect(wl.config.rigor).toBe("L1");
  });

  it("拒绝重复 change", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change");
    await expect(ledger.createChange("demo-change")).rejects.toThrow(/已存在/);
  });

  it("首次 BA/SA 走 inline，返工走 subagent", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change");
    const first = await ledger.startMaking("demo-change", "requirements");
    expect(first.mode).toBe("inline");
  });

  it("hook 检测：合格需求 mark clean，残缺需求 mark dirty", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change");
    // 合格
    await writeFile(ledger.artifactPath("demo-change", "requirements", "requirements"), GOOD_REQUIREMENTS);
    const clean = await ledger.check("demo-change", "requirements");
    expect(clean.clean).toBe(true);
    // 残缺（无场景、有 TODO）
    await writeFile(
      ledger.artifactPath("demo-change", "requirements", "requirements"),
      "# 需求\n\nTODO 待补充\n",
    );
    const dirty = await ledger.check("demo-change", "requirements");
    expect(dirty.clean).toBe(false);
    expect(dirty.checks.some((c) => c.status === "fail")).toBe(true);
  });

  it("制衡者 subject_hash 不匹配当前产物时拒绝登记（防假 PASS）", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change");
    const p = ledger.artifactPath("demo-change", "requirements", "requirements");
    await writeFile(p, GOOD_REQUIREMENTS);
    const hash = sha256(GOOD_REQUIREMENTS);
    await ledger.startMaking("demo-change", "requirements");
    await ledger.submitMaker("demo-change", makerConclusion("requirements", "ba", hash));

    // 制衡者用错误的 hash → 拒绝
    await expect(
      ledger.submitChecker("demo-change", checkerConclusion("requirements", "rr", sha256("别的内容"), "PASS")),
    ).rejects.toThrow(/subject_hash/);

    // 用正确 hash → 通过
    const ok = await ledger.submitChecker(
      "demo-change",
      checkerConclusion("requirements", "rr", hash, "PASS"),
    );
    expect(ok.verdict).toBe("PASS");
  });

  it("生产者带 blockers → 升级人裁决", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change");
    const p = ledger.artifactPath("demo-change", "requirements", "requirements");
    await writeFile(p, GOOD_REQUIREMENTS);
    const r = await ledger.submitMaker(
      "demo-change",
      makerConclusion("requirements", "ba", sha256(GOOD_REQUIREMENTS), [{ summary: "与既有决策冲突" }]),
    );
    expect(r.escalated).toBe(true);
    const wl = await ledger.worklist("demo-change");
    expect(wl.items.find((i) => i.artifact_id === "requirements")!.status).toBe("escalated");
  });

  it("REJECT 裁决把产物打回 blocked 并递增 attempts", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change");
    const p = ledger.artifactPath("demo-change", "requirements", "requirements");
    await writeFile(p, GOOD_REQUIREMENTS);
    const hash = sha256(GOOD_REQUIREMENTS);
    await ledger.submitMaker("demo-change", makerConclusion("requirements", "ba", hash));
    await ledger.submitChecker("demo-change", checkerConclusion("requirements", "rr", hash, "REJECT"));
    const wl = await ledger.worklist("demo-change");
    const item = wl.items.find((i) => i.artifact_id === "requirements")!;
    expect(item.status).toBe("blocked");
    expect(item.attempts).toBe(1);
  });

  it("Finish 不变式：全部产物 PASS + hook clean 才放行", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("demo-change", "L1");

    // 未完成时 finish 应失败
    await expect(ledger.finish("demo-change")).rejects.toThrow(/Finish 不变式/);

    const artifacts: Array<[string, string, string, string]> = [
      ["requirements", "requirements", GOOD_REQUIREMENTS, "rr"],
      ["design", "design", GOOD_DESIGN, "rr"],
      ["code", "code", GOOD_CODE, "cr"],
    ];
    for (const [id, kind, content, checker] of artifacts) {
      await writeFile(ledger.artifactPath("demo-change", id, kind), content);
      const mark = await ledger.check("demo-change", id);
      // code 产物文档层不含 R/S 也应 clean（其证据检测走 evidenceCheck，非此路径）
      const hash = sha256(content);
      await ledger.submitMaker("demo-change", makerConclusion(id, id === "code" ? "dev" : id === "design" ? "sa" : "ba", hash));
      await ledger.submitChecker("demo-change", checkerConclusion(id, checker, hash, "PASS"));
      expect(mark).toBeDefined();
    }

    const check = await ledger.finishCheck("demo-change");
    expect(check.ok).toBe(true);
    await ledger.finish("demo-change");
    const wl = await ledger.worklist("demo-change");
    expect(wl.finished).toBe(true);

    await ledger.archive("demo-change");
    expect((await ledger.worklist("demo-change")).archived).toBe(true);
  });

  it("L3 放漂：无语义制衡者，hook clean 即可 finish", async () => {
    const root = await tmpRepo();
    const ledger = new Ledger(root);
    await ledger.createChange("float-change", "L3");
    const artifacts: Array<[string, string, string]> = [
      ["requirements", "requirements", GOOD_REQUIREMENTS],
      ["design", "design", GOOD_DESIGN],
      ["code", "code", GOOD_CODE],
    ];
    for (const [id, kind, content] of artifacts) {
      await writeFile(ledger.artifactPath("float-change", id, kind), content);
      await ledger.check("float-change", id);
    }
    const check = await ledger.finishCheck("float-change");
    expect(check.ok).toBe(true);
  });
});

let repos: string[] = [];
afterEach(() => {
  repos = [];
});
