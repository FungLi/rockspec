---
name: rockspec-finish
description: 用于 Final CR 通过后的验证、收尾和归档；执行最终仓库检查，调度知识演进，提供平台无关的处置选项，并合并已验证的 Spec Delta。
---

# RockSpec 收尾

只产出一个结果：经过验证的完成决策；仅受治理 Change 可以归档。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 仅在 TE 后的 Delivery Review 已针对当前最终 Commit 通过时使用 **Attached（挂接）** 模式。
- 验证现有分支或 Worktree 并给出收尾选项时使用 **Standalone（独立）** 模式。将验证证据和 `receipt.yaml` 写入 `.rockspec/workbench/finish/<slug>/`；不得创建 RockSpec 审批、合并 Spec Delta 或归档 Change。

## 执行

1. 固定准确的最终 Commit，检查完整 Diff 的范围和无关改动。
   `change.verify` 会记录不可漂移的 `delivery_head`。同一 Worktree 后续承载其他 Change 时，当前 `HEAD` 可以是它的后代；Finish/Archive 必须确认冻结提交仍在当前历史中，且不把后续提交算入本 Change。历史重写丢失该提交时停止。
2. 按风险运行新鲜的测试、构建、Lint、类型检查及项目专用检查。诚实记录所有命令、工作目录、退出码、跳过项和 Commit Hash。
3. Attached 模式提交 `change.verify`。Engine 未进入 `READY_TO_FINISH` 时停止。
4. Engine 推荐 `knowledge.evolve` 时调用 `$rockspec-evolve`。收尾 Skill 只负责调度，不自行提炼或直接改写知识基线。
5. 提供平台无关的分支处置选项，不假设 GitHub PR 集成。仅根据用户选择，通过 `rockspec finish` 执行 `local_merge`、`push` 或 `keep`。
6. 只有在知识演进已记录为 `no_change`/`approved`、Finish 已记录且 Spec Delta 可无冲突合并后才归档。归档事务安装已评审知识候选并保留双向凭证、Hash、审批、事件、评审和证据。
7. Change 使用 Worktree 时调用 `$rockspec-worktree` 执行处置后的保留或清理。`keep` 原样保留；冲突、验证失败、脏目录或归属不明时保留现场。只有用户的 Finish 选择明确授权且安全检查通过时才能移除 Worktree。

多个存在依赖关系且均已待收尾的 Change 可以在一次人工操作中处理，但 Engine 必须按依赖顺序逐个完成 A、B 的 Finish 和 Archive，并分别生成证据、审计事件和知识演进凭证。上游成功而下游失败时不得回滚上游；不得用批量 HEAD 或合并快照替代独立 Change 边界。

验证证据可参考 [verification.yaml](assets/verification.yaml)。最终验证前读取 [action-change.verify.yaml](references/action-change.verify.yaml)，归档前读取 [action-change.archive.yaml](references/action-change.archive.yaml)。

报告最终 Commit、验证证据、知识演进凭证、所选处置方式、适用时的归档路径，以及明确留给用户处理的事项。
