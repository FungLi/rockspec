---
name: rockspec-worktree
description: 用于并行需求、隔离开发、恢复 Change 或清理工作区；建立、定位、恢复和安全收尾 Git Worktree，并验证分支、基线和工作区绑定。
---

# RockSpec Worktree

只产出一个结果：可由唯一 Change 安全使用、基线明确且能够继续执行的工作区，或一个不会破坏现场的阻塞结论。

## CLI 入口

受治理模式把本文的 `rockspec ...` 视为逻辑命令：先从选定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 边界

- 以 Change 为隔离单位；首版不为同一 Change 的不同 Task 创建 Worktree。
- 项目内 Skill、Plugin Manifest、`.rockspec/config.yaml` 和基线 Specs 由 Git 自动继承，不在新 Worktree 中重新安装或执行 `rockspec init`。
- 用户不需要手动执行 `rockspec new`。全新 Change 由调用方在目标 Worktree 中通过 Engine 底层接口创建；已有 Change 只恢复并执行 `status/continue`。
- 不自动 Stash、Commit、复制、Rebase、删除分支或解决语义冲突。
- 产品验收反馈默认继续当前 Change 和当前 Worktree。只有确认是独立目标、独立发布或独立回滚单元时才建议新 Change；创建新 Change 或 Worktree 前必须向用户说明边界并取得确认。
- 复用已有 Worktree 时，父 Change 必须先拥有冻结的 `delivery_head`，随后以 `rockspec new --based-on-change <parent> --reuse-workspace` 顺序交接；不能让两个 Change 同时写入同一个产品 HEAD。

## 准备或恢复

1. 读取 [worktree-protocol.md](references/worktree-protocol.md)，检查 Git 根目录、Submodule、当前分支、`git status --short`、已注册 Worktree 和可识别的 Active Change。
2. 如果用户点名的 Change 已唯一存在于某个 Worktree，进入或把后续命令的 `cwd` 固定到该目录；验证 `change.yaml.workspace` 后继续，禁止重复创建。
3. 如果当前目录已经是目标 Change 绑定的 Worktree，直接复用。当前工作区干净且没有其他 Active Change 时，Lite 可以使用当前目录；存在其他 Active Change、未归属修改、明确并行请求或隔离要求时使用 Worktree。
4. 创建前固定英文 kebab-case Change ID、目标分支、目标基线和路径。默认分支为 `rockspec/<change-id>`，默认路径为 `<repo-root>/.worktrees/<change-id>`。路径或分支被其他对象占用时停止，不添加随机后缀。
5. 优先使用宿主原生 Worktree 工具；没有时才使用 `git worktree add`。使用项目内目录前证明其被忽略；未忽略时只更新本地 Git exclude，不修改项目 `.gitignore`。
6. 从包含 RockSpec 项目资产的已提交基线创建 Worktree。与目标 Change 有关的修改尚未提交且不能从基线获得时，停止并让用户决定；不得静默遗漏或复制。
7. 在目标 Worktree 中按仓库规则执行 Setup 和基线验证，不盲目选择 `npm install`。基线失败时保留 Worktree，报告准确命令和失败，禁止开始实施。
8. 全新 Change 由 `$rockspec-triage` 或 `$rockspec-change` 在目标 Worktree 内调用底层 `rockspec new`，传入 `--base <target-ref>`；由本 Skill 创建时同时传入 `--managed-worktree`。后续 Requirements、Design、Plan 保持 Inline，Subagent 和 Reviewer 的 `cwd` 必须固定到绑定 Worktree。

## 收尾

在 `$rockspec-finish` 已完成用户选择后处理 Worktree：`keep` 原样保留；`push` 不删除分支；本地合并必须串行更新目标分支并运行合并后验证。只有 Worktree 干净、归属唯一且处置成功时才可以按用户明确选择移除。任一冲突或验证失败都保留分支和 Worktree。

从 [workspace-receipt.yaml](assets/workspace-receipt.yaml) 记录非绝对路径的工作区证据。报告 Change ID、模式、Provider、分支、目标基线、Worktree 路径、Setup/基线结果和下一 Skill。
