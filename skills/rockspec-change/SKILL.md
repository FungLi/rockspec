---
name: rockspec-change
description: 路由或编排完整的 RockSpec 受治理变更，覆盖分级、需求、设计、计划、实施、评审、验收和收尾。用户要求完整交付或恢复 Change、希望 RockSpec 选择下一能力，或尚未指定具体阶段时使用。用户明确只要求单项能力时，直接调用对应的原子 RockSpec Skill。
---

# RockSpec Change

只作为薄路由器。不要在本 Skill 内实现 Requirements、Design、Plan、代码、评审、验收或收尾工作。

## 路由请求

1. 用户明确请求单项能力时直接调用：
   - 风险或 Profile 选择：`$rockspec-triage`
   - Requirements 或 Spec：`$rockspec-requirements`
   - 技术设计：`$rockspec-design`
   - UI/UX 原型：`$rockspec-prototype`
   - 实施计划或 Readiness：`$rockspec-plan`
   - Task 实施：`$rockspec-implement`
   - 代码、Task 或 Final CR：`$rockspec-review`
   - 验收或 TE：`$rockspec-acceptance`
   - 最终验证或归档：`$rockspec-finish`
   - 并行、隔离、恢复或清理 Worktree：`$rockspec-worktree`
2. 完整或恢复中的受治理 Change 必须使用 `rockspec` CLI。解析 Git 根目录和已注册 Worktree；用户点名的 Change 位于其他 Worktree 时先调用 `$rockspec-worktree` 定位并固定后续 `cwd`，再运行 `rockspec status --json`。
3. 没有匹配 Change 时调用 `$rockspec-triage`。Triage 提出不可变的英文 kebab-case Change ID 和 Profile 后，由 `$rockspec-worktree` 选择 current 或隔离 Worktree；调用方只在选定工作区内通过底层 `rockspec new` 创建 Change。用户不手动执行该命令，也不得在新 Worktree 中重新安装 Skill 或执行 `rockspec init`。
4. 每次读取 CLI 返回的 `recommended_next.entry_skill`、`recommended_next.action`、`alternatives` 和 `blocked_by`。通过宿主真实 Skill 机制调用返回的 Skill，禁止凭记忆模拟其他 Skill。
5. 原子 Skill 返回后重新加载状态。仅当用户要求端到端执行且 Engine 状态允许时继续。

编排完整 Standard 或 Strict 流程前读取 [change-recipe.yaml](references/change-recipe.yaml)；调度任何 Worker 或 Reviewer 前读取 [orchestration.md](references/orchestration.md)。

## 停止边界

- 每个绑定 Hash 的用户审批都必须暂停。
- 遇到 `BLOCKED`、歧义、Provider 不可用或用户要求独立结果时停止。
- 不得因为已有上游文档就静默跳过能力；调用对应原子 Skill，由它选择 Attached 或 Standalone 模式。
- 工作区绑定不匹配、基线验证失败或宿主无法固定 Subagent `cwd` 时停止，不回退到共享目录。
- 仅在 `$rockspec-finish` 报告归档完成，或用户明确选择不归档的停止点后结束。

报告当前 Change、模式、已完成能力、产物、阻塞项，以及 Engine 给出的下一 Skill 和 Action。
