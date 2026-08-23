# 编排与证据参考

## Runtime 解析

Host 在第一次调用 RockSpec CLI 时必须从绑定 Worktree 的 Git 根目录解析 Runtime，且该结果在本次会话内保持固定：

1. 使用结构化 YAML 解析 `.rockspec/install.lock.yaml`，读取 `rockspec.runtime_path` 和 `rockspec.integrity`。
2. 将相对路径限制在 Git 根目录内，确认文件存在，并校验其 SHA-256；不得执行锁外入口。
3. 以绑定 Worktree 为 `cwd`，将逻辑命令 `rockspec <args>` 执行为 `node <runtime_path> <args>`。
4. 安装锁存在时，不得再尝试全局 `rockspec`、`command -v rockspec`、用户目录全盘搜索或 package manifest 推断。锁无法解析、入口缺失或完整性不匹配表示项目安装损坏；停止当前 Action，交给 `$rockspec-debug`，再通过项目安装器 repair/upgrade，不得绕过 Engine。

## 所有权

Engine 是唯一的工作流状态写入者。编排器可以编辑已声明的内容产物并调用 Engine 命令。Worker 只能编辑自己的 Task 范围。Reviewer 不得编辑被评审内容。任何 Worker 或 Reviewer 都不得创建下级 Subagent。

创建 Agent 前登记 execution ID。向 Agent 提供 Action 契约、Role Prompt、不可变产物路径/Hash、绑定 Worktree 根目录、分支、基线 Commit、预期输出和完成报告格式。Host Adapter 必须把实际 `cwd` 固定到绑定 Worktree；无法保证时阻塞执行。不要把凭据或无关的前序 Agent 结论放入 Brief。

正常编排只读取 `status --view summary --json`。Task 调度、Recovery 和 Hash 新鲜度核对使用对应定向视图；mutation 命令需要机器可读返回时附加全局 `--summary --json`。完整 Change、历史 Revision、Review 和 Evidence 留在磁盘，除非正在诊断 Runtime 状态，不得反复打印到模型上下文。Artifact Hash 未变化时复用已读取的结论，只对变化路径读取定向 Diff。

## Agent 矩阵

| Action | Agent | 写入范围 | 隔离要求 |
|---|---|---|---|
| `requirements.review` | Requirements Reviewer | 仅自己的报告 | 新上下文；不含作者结论 |
| `readiness.review` | Readiness Reviewer | 仅自己的报告 | 新上下文；不含设计作者结论 |
| `task.execute` | Task Implementer | 当前 Task 文件和测试 | 每个 Task 使用新上下文；修复时恢复 |
| `task.review` | Task Change Reviewer | 仅自己的报告 | 必须不同于 Implementer |
| `acceptance.validate` | Acceptance Test Engineer | 集成/E2E 资产和证据 | 独立于 Task/Delivery Review |
| `delivery.review` | Delivery Reviewer | 仅自己的报告 | 验收后执行；固定最终 Diff |
| `knowledge.evolve`（存在实质 Delta） | Knowledge Reviewer | 仅 `reviews/knowledge-review.md` | 不同于 Delta Author；固定 Source/Delta/基线/候选 Hash |

Strict Review Action 启动两个相互独立的 Reviewer，全部完成后再聚合。
Knowledge Review 为收尾阶段的轻量语义对账，各 Profile 使用一个独立 Reviewer；`normative` 更新另需用户明确确认。

## 在线作者与控制权

Research、Requirements 和 Design 作者保持在主会话 Inline 执行，同时使用 Interactive 协作。它们不是 Subagent：作者读取上下文后一次只推进一个需要用户确认的问题、方案或章节，并在每个确认点结束当前回复。编排器不得跨过等待点，也不得在同一回复中把 Requirements、Design 和 Plan 自动串联。

只有最终作者产物写入且适用 Action 完成后，才允许启动独立 Reviewer 或进入下一能力。Reviewer 仍按 Agent 矩阵使用隔离上下文；Reviewer 提出实质内容变化时，控制权回到主会话作者，重新确认受影响章节。

## 最低证据要求

记录命令、工作目录、开始/结束时间、退出码、通过/失败/跳过数量、相关 ID、运行 Commit，以及相关日志/截图/报告路径。证据必须对当前 Gate 的产物 Hash 和 Commit 保持新鲜。

没有命令输出和退出状态时，不接受“测试通过”等声明。保留失败尝试，禁止将其改写为成功。清理密钥，但保留足以复现失败的诊断信息。

## Finding 路由

使用 `PASS`、`CHANGES_REQUIRED` 或 `BLOCKED`。每个 Finding 包含稳定 ID、严重度、类别、具体证据、责任域、`route_to` Action ID、状态、`classification` 和 `authority_impact`。Critical 和 Important Finding 在 Engine 验证关闭前持续阻塞。分类与自动/人工边界统一遵循 [reconciliation-loop.md](reconciliation-loop.md)。

Task 修复最多恢复原 Implementer 两轮。Gate 通过前，将修复 amend 到该 Task 的唯一 Commit。Task 通过后，Acceptance 或 Final CR 发现的缺陷必须创建新的 Remediation Task 和 Commit，绝不重写已完成 Task Commit。

Engine 返回 `recovery` 时以它为唯一恢复路由。没有 Open Revision 时，`revision` 必须绑定原 Review Hash 和全部触发 Finding；已有 Open Revision 时使用 `rockspec revise --amend` 把新 Review Hash 和全部 Open Finding 追加为 `AM-xxx`，不得打开第二个 Revision。Engine 必要时把目标扩展到更上游并升级审批策略。实施中活动 Task 冻结为旧 Attempt，重新审批后以原 Base、新 execution、新 Brief 恢复。Completed/Suspended Task 永久保留；后续修改只能进入映射 `finding_ids` 的新 Remediation Task。

自动 Revision 的 Author 与 Reconciliation Reviewer 必须使用不同 execution ID。Reviewer 只读取 Engine 固定的 Package；首次 Gate、Critical Finding、权威边界变化或未知、Reviewer 分歧和两轮未收敛均升级人工。自动对账完成后继续重放全部失效下游 Action/Gate，不能只修复最上游文件便关闭 Revision。

## 失败处理

Subagent 超时、越权、修改状态、无法提供证据或尝试递归委派时，拒绝其报告并将控制权交还编排器。Provider 或环境不可用时报告准确阻塞原因。重试前重新查询 Engine 状态，因为之前的产物变化可能已经使审批失效。
