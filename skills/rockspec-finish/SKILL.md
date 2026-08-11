---
name: rockspec-finish
description: 执行最终仓库验证，提供平台无关的收尾选项，合并已验证的 Spec Delta 并归档完成的 RockSpec Change。Final CR 通过后、Engine 推荐 change.verify、finish 或 change.archive，或需要对现有分支做独立完成检查时使用。
---

# RockSpec 收尾

只产出一个结果：经过验证的完成决策；仅受治理 Change 可以归档。

## 选择模式

- 仅在 TE 后的 Delivery Review 已针对当前最终 Commit 通过时使用 **Attached（挂接）** 模式。
- 验证现有分支或 Worktree 并给出收尾选项时使用 **Standalone（独立）** 模式。将验证证据和 `receipt.yaml` 写入 `.rockspec/workbench/finish/<slug>/`；不得创建 RockSpec 审批、合并 Spec Delta 或归档 Change。

## 执行

1. 固定准确的最终 Commit，检查完整 Diff 的范围和无关改动。
2. 按风险运行新鲜的测试、构建、Lint、类型检查及项目专用检查。诚实记录所有命令、工作目录、退出码、跳过项和 Commit Hash。
3. Attached 模式提交 `change.verify`。Engine 未进入 `READY_TO_FINISH` 时停止。
4. 提供平台无关的分支处置选项，不假设 GitHub PR 集成。仅根据用户选择，通过 `rockspec finish` 执行 `local_merge`、`push` 或 `keep`。
5. 只有在已记录 Finish 且 Spec Delta 可无冲突合并后才归档。保留 Hash、审批、事件、评审和证据。
6. Change 使用 Worktree 时调用 `$rockspec-worktree` 执行处置后的保留或清理。`keep` 原样保留；冲突、验证失败、脏目录或归属不明时保留现场。只有用户的 Finish 选择明确授权且安全检查通过时才能移除 Worktree。

验证证据可参考 [verification.yaml](assets/verification.yaml)。最终验证前读取 [action-change.verify.yaml](references/action-change.verify.yaml)，归档前读取 [action-change.archive.yaml](references/action-change.archive.yaml)。

报告最终 Commit、验证证据、所选处置方式、适用时的归档路径，以及明确留给用户处理的事项。
