# 编排与证据参考

## 所有权

Engine 是唯一的工作流状态写入者。编排器可以编辑已声明的内容产物并调用 Engine 命令。Worker 只能编辑自己的 Task 范围。Reviewer 不得编辑被评审内容。任何 Worker 或 Reviewer 都不得创建下级 Subagent。

创建 Agent 前登记 execution ID。向 Agent 提供 Action 契约、Role Prompt、不可变产物路径/Hash、绑定 Worktree 根目录、分支、基线 Commit、预期输出和完成报告格式。Host Adapter 必须把实际 `cwd` 固定到绑定 Worktree；无法保证时阻塞执行。不要把凭据或无关的前序 Agent 结论放入 Brief。

## Agent 矩阵

| Action | Agent | 写入范围 | 隔离要求 |
|---|---|---|---|
| `requirements.review` | Requirements Reviewer | 仅自己的报告 | 新上下文；不含作者结论 |
| `readiness.review` | Readiness Reviewer | 仅自己的报告 | 新上下文；不含设计作者结论 |
| `task.execute` | Task Implementer | 当前 Task 文件和测试 | 每个 Task 使用新上下文；修复时恢复 |
| `task.review` | Task Change Reviewer | 仅自己的报告 | 必须不同于 Implementer |
| `acceptance.validate` | Acceptance Test Engineer | 集成/E2E 资产和证据 | 独立于 Task/Delivery Review |
| `delivery.review` | Delivery Reviewer | 仅自己的报告 | 验收后执行；固定最终 Diff |

Strict Review Action 启动两个相互独立的 Reviewer，全部完成后再聚合。

## 最低证据要求

记录命令、工作目录、开始/结束时间、退出码、通过/失败/跳过数量、相关 ID、运行 Commit，以及相关日志/截图/报告路径。证据必须对当前 Gate 的产物 Hash 和 Commit 保持新鲜。

没有命令输出和退出状态时，不接受“测试通过”等声明。保留失败尝试，禁止将其改写为成功。清理密钥，但保留足以复现失败的诊断信息。

## Finding 路由

使用 `PASS`、`CHANGES_REQUIRED` 或 `BLOCKED`。每个 Finding 包含稳定 ID、严重度、类别、具体证据、责任域、`route_to` Action ID 和状态。Critical 和 Important Finding 在 Engine 验证关闭前持续阻塞。

Task 修复最多恢复原 Implementer 两轮。Gate 通过前，将修复 amend 到该 Task 的唯一 Commit。Task 通过后，Acceptance 或 Final CR 发现的缺陷必须创建新的 Remediation Task 和 Commit，绝不重写已完成 Task Commit。

## 失败处理

Subagent 超时、越权、修改状态、无法提供证据或尝试递归委派时，拒绝其报告并将控制权交还编排器。Provider 或环境不可用时报告准确阻塞原因。重试前重新查询 Engine 状态，因为之前的产物变化可能已经使审批失效。
