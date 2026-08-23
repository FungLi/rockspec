---
name: rockspec-implement
description: 用于实施、继续既有计划或修复评审问题；执行已批准 Task，提供聚焦测试、范围受控的 Commit 和独立评审交接。
---

# RockSpec 实施

每个 Task 只产出一个结果：带有新鲜验证证据、范围聚焦的实施 Commit。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 实施审批仍有效，或 Change 符合 Lite 准入时使用 **Attached（挂接）** 模式。
- 用户提供外部 Plan 或 Task 时使用 **Standalone（独立）** 模式。在 `.rockspec/workbench/implement/<slug>/` 记录进度和 `receipt.yaml`；保留 Task 边界，但不得声称通过 RockSpec Gate。

## 执行

1. 读取 Change 的 Workspace Binding，把本次实施及所有 Worker/Reviewer 的实际 `cwd` 固定到该 Worktree；绑定不匹配或宿主无法固定时停止。
2. Attached 模式先执行 `rockspec task start <task-id> <change-id>`，再执行 `rockspec task brief <task-id> <change-id>`；只把 Engine 返回的冻结 Brief、路径、Hash、Task Base Commit 和 Implementer execution ID 交给 Worker。不得用聊天记忆或重新拼装的上下文替代冻结 Brief。
3. Standard/Strict 按 `task.execute` 的 `model_policy` 选择不低于 `minimum` 的 Tier，由 Host Adapter 显式指定模型，再为每个 Task 启动新的 Implementer；禁止 Worker 再委派。Lite 保持 Inline。
4. 围绕 Task 的验收标准和已批准 Design 实施最小且完整的行为。`allowed_paths` 是计划时预计涉及的参考范围，不是硬白名单；实现确有需要时可扩展到其他产品文件，但必须在 Implementer Report 中说明扩展与 Task 行为的关系，且不得夹带无关改动。只有扩展暴露出验收标准、接口契约、依赖或责任划分需要改变时，才停止并路由 `plan.create`。
5. 使用 Engine 创建的 `.rockspec/changes/<change-id>/runtime/tasks/<task-id>/implementer-report.md` 记录过程，保留 execution ID、Task Base、Brief 路径和 Hash。报告格式可对照 [implementer-report.md](assets/implementer-report.md)。
6. 创建且只保留一个最终产品 Commit，提交信息包含 `[<task-id>]`。然后用 `rockspec check run --change <change-id> --task <task-id> -- <executable> [args...]` 让 Engine 实际执行聚焦检查并记录绑定当前 Commit 的日志与 Hash；把 Final Commit 和 Evidence ID 补入 Implementer Report。`rockspec evidence add` 的人工记录不能替代该 Gate 证据。
7. 执行 `rockspec review package task <change-id> --task <task-id>` 固定唯一 Review Subject，把返回的 Review Package 路径及 `base_commit`、`head_commit`、`diff_hash` 交给 `$rockspec-review`。禁止自审，也不得根据 Implementer 报告直接标记 Task 完成。
   若尚未产生产品 Commit，且发现 Task 的验收标准、接口契约、依赖或责任划分本身必须修订，使用 `rockspec review package task <change-id> --task <task-id> --scope-blocked` 生成范围阻塞包；普通的合理文件扩展不使用此入口。
8. Reviewer 写入结构化报告后，执行 `rockspec action complete task.review <change-id> --verdict <verdict>`。`PASS` 后执行 `rockspec task complete <task-id> <change-id>`；Engine 会复核冻结 Brief、Review Subject、Reviewer 身份、报告/证据 Hash 和单 Commit，并在 Review Package 中披露计划路径与实际路径偏差。
9. `CHANGES_REQUIRED` 时最多恢复同一 Implementer 两轮。每轮只修复已确认 Finding，amend 原 Commit，重新填写报告、执行 `check run`、生成新的 Review Package，并让独立 Reviewer 只复审 Finding 与 Fix Diff；新报告必须携带上一轮全部 Findings，按结果更新为 `open`、`resolved` 或 `accepted`，并把 `round` 递增为 `1`、`2`。Subject 变化后旧报告不得复用。上游 Finding 出现时停止，按 `status.recovery` 开启 Revision；按当前 `gate_policies` 执行人工或自动对账。恢复后只继续 Engine 返回的 Ready Task：可恢复的 `suspended` Task沿用原 Base 和新冻结 Brief；`superseded` Task 永不重启，由 Replacement Task 使用独立 Commit 接管。
10. Task 完成后重新读取状态，再选择下一个 Ready Task。

调度或实施前读取 [action-task.execute.yaml](references/action-task.execute.yaml) 和 [role-task-implementer.md](references/role-task-implementer.md)。

范围不清、审批过期、验证失败、Commit 契约违规，或 Finding 被路由回 Design/Plan 时停止。
