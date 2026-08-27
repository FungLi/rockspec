// Ledger 高层 API：串起 storage/projection/hooks/conclusions。
// 这是 CLI 与测试的唯一入口。所有写操作都落成仅追加事件。
import path from "node:path";
import { ChangeIdSchema } from "./util.js";
import {
  appendEvent,
  changeDir,
  changeExists,
  listChanges,
  readEvents,
  readMeta,
  writeMeta,
} from "./storage.js";
import {
  latestCheckerConclusion,
  latestHookMark,
  latestMakerConclusion,
  projectWorklist,
} from "./projection.js";
import { runHooks } from "./hooks.js";
import {
  checkFinishInvariant,
  parseCheckerConclusion,
  parseMakerConclusion,
  verifyCheckerBinding,
  type FinishCheckResult,
} from "./conclusions.js";
import { projectBoard } from "./board.js";
import { renderBoardMarkdown } from "./board-render.js";
import { writeFile } from "node:fs/promises";
import type { Board } from "./types.js";
import type {
  ArtifactKind,
  ChangeConfig,
  ChangeMeta,
  CheckerRole,
  HookMark,
  MakerRole,
  Phase,
  RigorLevel,
  WorklistItem,
  WorklistProjection,
} from "./types.js";

export class LedgerError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** 默认工作清单：一条需求、一条设计、一条代码。真实用法可由 SA 拆出多条 code。 */
const DEFAULT_ITEMS: Array<Omit<WorklistItem, "status" | "attempts">> = [
  { artifact_id: "requirements", kind: "requirements", phase: "propose", maker_role: "ba", checker_role: "rr", depends_on: [] },
  { artifact_id: "design", kind: "design", phase: "propose", maker_role: "sa", checker_role: "rr", depends_on: ["requirements"] },
  { artifact_id: "code", kind: "code", phase: "apply", maker_role: "dev", checker_role: "cr", depends_on: ["design"] },
];

export class Ledger {
  constructor(private repoRoot: string) {}

  async createChange(changeId: string, rigor: RigorLevel = "L1"): Promise<ChangeMeta> {
    ChangeIdSchema.parse(changeId);
    if (changeExists(this.repoRoot, changeId)) {
      throw new LedgerError("CHANGE_EXISTS", `Change 已存在：${changeId}`);
    }
    const config: ChangeConfig = { rigor };
    const meta: ChangeMeta = { id: changeId, created_at: new Date().toISOString(), config };
    await writeMeta(this.repoRoot, meta);
    await appendEvent(this.repoRoot, changeId, { type: "change.created", data: { config } });
    for (const item of DEFAULT_ITEMS) {
      await appendEvent(this.repoRoot, changeId, {
        type: "item.registered",
        artifact_id: item.artifact_id,
        data: item as unknown as Record<string, unknown>,
      });
    }
    await this.syncBoard(changeId);
    return meta;
  }

  async worklist(changeId: string): Promise<WorklistProjection> {
    const meta = await readMeta(this.repoRoot, changeId);
    const events = await readEvents(this.repoRoot, changeId);
    return projectWorklist({ meta, events });
  }

  /** 看板投影（Worklist 的列式视图，只读）。 */
  async board(changeId: string): Promise<Board> {
    return projectBoard(await this.worklist(changeId));
  }

  /**
   * 重新生成 board.md（单向派生的只读镜像）。
   * 从事件流重新投影覆盖写，永远与真相一致；任何手动编辑都会被覆盖。
   * 所有写操作末尾调用它。
   */
  private async syncBoard(changeId: string): Promise<void> {
    const board = await this.board(changeId);
    const file = path.join(changeDir(this.repoRoot, changeId), "board.md");
    await writeFile(file, renderBoardMarkdown(board), "utf8");
  }

  private async requireItem(changeId: string, artifactId: string): Promise<WorklistItem> {
    const wl = await this.worklist(changeId);
    const item = wl.items.find((i) => i.artifact_id === artifactId);
    if (!item) throw new LedgerError("ITEM_NOT_FOUND", `产物不存在：${artifactId}`);
    return item;
  }

  /** 标记进入生产，并记录调度模式（首次 inline / 返工 subagent）。 */
  async startMaking(changeId: string, artifactId: string): Promise<{ mode: "inline" | "subagent" }> {
    const item = await this.requireItem(changeId, artifactId);
    // 首次（attempts=0）且为 BA/SA 共创型 → inline；否则隔离子 agent
    const cocreate = item.attempts === 0 && (item.maker_role === "ba" || item.maker_role === "sa");
    const mode = cocreate ? "inline" : "subagent";
    await appendEvent(this.repoRoot, changeId, {
      type: "item.making",
      artifact_id: artifactId,
      data: { mode, attempts: item.attempts },
    });
    await this.syncBoard(changeId);
    return { mode };
  }

  /** 生产者交结论。有 blockers → 升级人裁决。 */
  async submitMaker(changeId: string, rawConclusion: unknown): Promise<{ escalated: boolean }> {
    const conclusion = parseMakerConclusion(rawConclusion);
    await this.requireItem(changeId, conclusion.artifact_id);
    await appendEvent(this.repoRoot, changeId, {
      type: "maker.concluded",
      artifact_id: conclusion.artifact_id,
      data: { conclusion: conclusion as unknown as Record<string, unknown> },
    });
    // SA 拆出的 code Task 动态注册进看板（多 Task 支持）
    if (conclusion.registers && conclusion.registers.length > 0) {
      const existing = new Set((await this.worklist(changeId)).items.map((i) => i.artifact_id));
      for (const task of conclusion.registers) {
        if (existing.has(task.artifact_id)) continue;
        const item: Omit<WorklistItem, "status" | "attempts"> = {
          artifact_id: task.artifact_id,
          kind: "code",
          phase: "apply",
          maker_role: "dev",
          checker_role: "cr",
          depends_on: task.depends_on,
        };
        await appendEvent(this.repoRoot, changeId, {
          type: "item.registered",
          artifact_id: task.artifact_id,
          data: item as unknown as Record<string, unknown>,
        });
      }
    }
    if (conclusion.blockers.length > 0) {
      await appendEvent(this.repoRoot, changeId, {
        type: "item.escalated",
        artifact_id: conclusion.artifact_id,
        data: { blockers: conclusion.blockers },
      });
      await this.syncBoard(changeId);
      return { escalated: true };
    }
    await this.syncBoard(changeId);
    return { escalated: false };
  }

  /** 运行 hook 检测并记录 mark。 */
  async check(changeId: string, artifactId: string): Promise<HookMark> {
    const item = await this.requireItem(changeId, artifactId);
    const artifactPath = this.artifactPath(changeId, artifactId, item.kind);
    const mark = await runHooks(artifactId, item.kind, artifactPath);
    await appendEvent(this.repoRoot, changeId, {
      type: "hook.marked",
      artifact_id: artifactId,
      data: { mark: mark as unknown as Record<string, unknown> },
    });
    await this.syncBoard(changeId);
    return mark;
  }

  /** 制衡者交结论。校验 subject_hash 绑定，防评审旧版本。 */
  async submitChecker(changeId: string, rawConclusion: unknown): Promise<{ verdict: string }> {
    const conclusion = parseCheckerConclusion(rawConclusion);
    const item = await this.requireItem(changeId, conclusion.artifact_id);

    const binding = verifyCheckerBinding(conclusion, item.output_hash);
    if (!binding.ok) {
      throw new LedgerError("CHECKER_BINDING_FAILED", binding.reason!, {
        artifact_id: conclusion.artifact_id,
      });
    }
    await appendEvent(this.repoRoot, changeId, {
      type: "item.checking",
      artifact_id: conclusion.artifact_id,
    });
    await appendEvent(this.repoRoot, changeId, {
      type: "checker.concluded",
      artifact_id: conclusion.artifact_id,
      data: { conclusion: conclusion as unknown as Record<string, unknown> },
    });
    if (conclusion.verdict === "PASS") {
      await appendEvent(this.repoRoot, changeId, {
        type: "item.passed",
        artifact_id: conclusion.artifact_id,
      });
    } else {
      await appendEvent(this.repoRoot, changeId, {
        type: "item.blocked",
        artifact_id: conclusion.artifact_id,
        data: { problem_owner: conclusion.problem_owner, findings: conclusion.findings },
      });
    }
    await this.syncBoard(changeId);
    return { verdict: conclusion.verdict };
  }

  /** 校验 Finish 不变式（不落事件，供预检）。 */
  async finishCheck(changeId: string): Promise<FinishCheckResult> {
    const wl = await this.worklist(changeId);
    const events = await readEvents(this.repoRoot, changeId);
    return checkFinishInvariant(
      wl,
      (id) => latestHookMark(events, id),
      (id) => latestCheckerConclusion(events, id),
    );
  }

  /** 执行 finish：仅当 Finish 不变式通过。 */
  async finish(changeId: string): Promise<void> {
    const result = await this.finishCheck(changeId);
    if (!result.ok) {
      const failed = result.items.filter((i) => !i.passed);
      throw new LedgerError("FINISH_INVARIANT_FAILED", "Finish 不变式未通过", {
        failed: failed as unknown as Record<string, unknown>,
      });
    }
    const meta = await readMeta(this.repoRoot, changeId);
    meta.finished_at = new Date().toISOString();
    await writeMeta(this.repoRoot, meta);
    await appendEvent(this.repoRoot, changeId, { type: "change.finished" });
    await this.syncBoard(changeId);
  }

  async archive(changeId: string): Promise<void> {
    const wl = await this.worklist(changeId);
    if (!wl.finished) {
      throw new LedgerError("NOT_FINISHED", "Change 尚未 finish，不能归档");
    }
    const meta = await readMeta(this.repoRoot, changeId);
    meta.archived_at = new Date().toISOString();
    await writeMeta(this.repoRoot, meta);
    await appendEvent(this.repoRoot, changeId, { type: "change.archived" });
    await this.syncBoard(changeId);
  }

  async list(): Promise<string[]> {
    return listChanges(this.repoRoot);
  }

  latestMaker = (changeId: string, artifactId: string) =>
    readEvents(this.repoRoot, changeId).then((e) => latestMakerConclusion(e, artifactId));

  /** 产物在磁盘上的绝对路径。 */
  artifactPath(changeId: string, artifactId: string, kind: ArtifactKind): string {
    const base = changeDir(this.repoRoot, changeId);
    const filename =
      kind === "requirements" ? "requirements.md" : kind === "design" ? "design.md" : `${artifactId}.md`;
    return path.join(base, filename);
  }
}

export type { Phase, MakerRole, CheckerRole };
