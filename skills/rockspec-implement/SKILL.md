---
name: rockspec-implement
description: 执行一个或多个已批准的 RockSpec Task，或现有独立实施计划，并提供聚焦测试、范围受控的 Commit 和独立评审交接。用户要求实施或继续计划、从已有 Task 开始、修复评审失败，或 Engine 推荐 apply 或 task.execute 时使用。
---

# RockSpec 实施

每个 Task 只产出一个结果：带有新鲜验证证据、范围聚焦的实施 Commit。

## 选择模式

- 实施审批仍有效，或 Change 符合 Lite 准入时使用 **Attached（挂接）** 模式。
- 用户提供外部 Plan 或 Task 时使用 **Standalone（独立）** 模式。在 `.rockspec/workbench/implement/<slug>/` 记录进度和 `receipt.yaml`；保留 Task 边界，但不得声称通过 RockSpec Gate。

## 执行

1. 读取 Change 的 Workspace Binding，把本次实施及所有 Worker/Reviewer 的实际 `cwd` 固定到该 Worktree；绑定不匹配或宿主无法固定时停止。
2. Attached 模式先执行 `rockspec task start <task-id> <change-id>`，再执行 `rockspec task brief <task-id> <change-id>`；只把 Engine 返回的冻结 Brief、路径、Hash、Task Base Commit 和 Implementer execution ID 交给 Worker。不得用聊天记忆或重新拼装的上下文替代冻结 Brief。
3. Standard/Strict 按 `task.execute` 的 `model_policy` 选择不低于 `minimum` 的 Tier，由 Host Adapter 显式指定模型，再为每个 Task 启动新的 Implementer；禁止 Worker 再委派。Lite 保持 Inline。
4. 只在 Task Frontmatter 的 `allowed_paths` 内实施最小且完整的行为。适合自动化测试时执行真实的 Red/Green/Refactor 循环；范围不足时停止并路由 `plan.create`，不得自行扩大白名单。
5. 使用 Engine 创建的 `.rockspec/changes/<change-id>/runtime/tasks/<task-id>/implementer-report.md` 记录过程，保留 execution ID、Task Base、Brief 路径和 Hash。报告格式可对照 [implementer-report.md](assets/implementer-report.md)。
6. 创建且只保留一个最终产品 Commit，提交信息包含 `[<task-id>]`。然后用 `rockspec check run --change <change-id> --task <task-id> -- <executable> [args...]` 让 Engine 实际执行聚焦检查并记录绑定当前 Commit 的日志与 Hash；把 Final Commit 和 Evidence ID 补入 Implementer Report。`rockspec evidence add` 的人工记录不能替代该 Gate 证据。
7. 执行 `rockspec review package task <change-id> --task <task-id>` 固定唯一 Review Subject，把返回的 Review Package 路径及 `base_commit`、`head_commit`、`diff_hash` 交给 `$rockspec-review`。禁止自审，也不得根据 Implementer 报告直接标记 Task 完成。
8. Reviewer 写入结构化报告后，执行 `rockspec action complete task.review <change-id> --verdict <verdict>`。`PASS` 后执行 `rockspec task complete <task-id> <change-id>`；Engine 会复核冻结 Brief、Review Subject、Reviewer 身份、报告/证据 Hash、单 Commit 和文件范围。
9. `CHANGES_REQUIRED` 时最多恢复同一 Implementer 两轮。每轮只修复已确认 Finding，amend 原 Commit，重新填写报告、执行 `check run`、生成新的 Review Package，并让独立 Reviewer 只复审 Finding 与 Fix Diff；新报告必须携带上一轮全部 Findings，按结果更新为 `open`、`resolved` 或 `accepted`，并把 `round` 递增为 `1`、`2`。Subject 变化后旧报告不得复用。两轮仍不通过，或 Finding 路由 Design/Plan 时停止并交回主流程。
10. Task 完成后重新读取状态，再选择下一个 Ready Task。

调度或实施前读取 [action-task.execute.yaml](references/action-task.execute.yaml) 和 [role-task-implementer.md](references/role-task-implementer.md)。

范围不清、审批过期、验证失败、Commit 契约违规，或 Finding 被路由回 Design/Plan 时停止。
