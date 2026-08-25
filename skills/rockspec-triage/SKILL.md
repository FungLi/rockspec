---
name: rockspec-triage
description: 用于启动 Change、判断 Lite 或风险升级；评估变更范围与风险，选择最低安全的 Lite、Standard 或 Strict Profile，并创建 Brief。
---

# RockSpec 分级

只产出一个结果：有证据支撑的流程 Profile 和边界明确的 Change Brief。

## CLI 入口

受治理模式把本文的 `rockspec ...` 视为逻辑命令：先从选定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 执行

1. 检查仓库规则、目标区域、可观察行为、可能依赖、回滚方式和可用验证命令。
2. 评估用户可见范围、数据/安全/兼容性风险、UI 影响、是否需要原型及需求不确定性。只有仍需新的产品选择或外部事实才能前进时才路由 Research/full authoring；能够直接转换为可测试 Scenario 的反馈不因措辞简略而升级。紧急程度不能降低 Profile。
3. 受治理 Change 应提出不可变的英文 kebab-case Change ID，并确定 kind、风险标签、向上升级、UI Impact 和目标基线；然后调用 `$rockspec-worktree` 选择或恢复工作区。
4. 只在选定工作区内由编排器调用底层 `rockspec new`，传入检测结果和目标基线；Worktree 由 RockSpec 创建时传入 `--managed-worktree`。用户不手动执行该命令，新 Worktree 不执行 `rockspec init`。
5. 生成 `.rockspec/changes/<change-id>/brief.md` 后提交 `change.triage`。Lite 准入后来失效时通过 `change.promote` 升级。
6. 只做独立评估且没有受治理 Change 时，将 `brief.md` 和 `receipt.yaml` 写入 `.rockspec/workbench/triage/<slug>/`。设置 `mode: standalone` 和 `governed_change: false`；不得创建审批或声称通过下游 Gate。

可从 [brief.md](assets/brief.md) 起草产物。完成分级前读取 [action-change.triage.yaml](references/action-change.triage.yaml)，升级前读取 [action-change.promote.yaml](references/action-change.promote.yaml)。

## 完成

说明所选 Profile、被拒绝的较低 Profile、UI/原型决策、风险、回滚、验证方式和下一推荐 Skill。绝不自动降级。
