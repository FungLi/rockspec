# 编排与证据参考

## Runtime 解析

Host 在第一次调用 RockSpec CLI 时必须从绑定 Worktree 的 Git 根目录解析 Runtime，且该结果在本次会话内保持固定：

1. 使用结构化 YAML 解析 `.rockspec/install.lock.yaml`，读取 `rockspec.runtime_path` 和 `rockspec.integrity`。
2. 将相对路径限制在 Git 根目录内，确认文件存在，并校验其 SHA-256；不得执行锁外入口。
3. 以绑定 Worktree 为 `cwd`，将逻辑命令 `rockspec <args>` 执行为 `node <runtime_path> <args>`。
4. 安装锁存在时，不得再尝试全局 `rockspec`、`command -v rockspec`、用户目录全盘搜索或 package manifest 推断。锁无法解析、入口缺失或完整性不匹配表示项目安装损坏；停止当前 Action，交给 `$rockspec-debug`，再通过项目安装器 repair/upgrade，不得绕过 Engine。

## 所有权

Engine 是唯一的工作流状态写入者。编排器可以编辑已声明的内容产物并调用 Engine 命令。Worker 只能编辑自己的 Task 范围。Reviewer 不得编辑被评审内容。任何 Worker 或 Reviewer 都不得创建下级 Subagent。

创建 Author/Reviewer Agent 前使用 `rockspec execution start <action> --role <role> --model-tier <tier> --host-model <model> --context-package <path> --context-hash <sha256>` 登记 execution ID；Task Implementer 使用 `rockspec task start <task-id> <change-id> --model-tier <tier> --host-model <model>`，Engine 会把冻结 Task Brief 记录为 Context Package。Agent 返回并完成其产物写入后立即执行 `rockspec execution complete <execution-id> <change-id> --outcome success|error|cancelled --input-tokens <n> --cached-input-tokens <n> --output-tokens <n> --reasoning-tokens <n>`，不得把后续人工等待或其他 Reviewer 时间计入该 execution。Engine 校验 Role 与 Action 的对应关系，报告中的 execution ID 必须引用登记记录，不能自报任意字符串；Skill 和 Host Adapter 负责按 `model_policy` 选择不低于 `minimum` 的 Tier 并显式记录。向 Agent 提供 Action 契约、Role Prompt、不可变产物路径/Hash、绑定 Worktree 根目录、分支、基线 Commit、预期输出和完成报告格式。Context Package 必须是按 Role 裁剪的最小包：当前 Brief、相关 R/S/D、必要符号和验证命令；禁止把完整父会话、无关 Change 或其他 Reviewer 结论注入子 Agent。Host Adapter 必须把实际 `cwd` 固定到绑定 Worktree；无法保证时阻塞执行。不要把凭据或无关的前序 Agent 结论放入 Brief。

`rockspec check run` 默认复用同一 Commit、Action/Task、Scenario/Finding 和 Artifact 绑定下已验证且日志 Hash 未变化的 executed Evidence；只有需要强制重跑时才使用 `--no-cache`。补救 Plan 必须 append-only：已完成或已挂起 Task 不得改写，新增修复必须创建 Finding-bound Task。

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

Research、Requirements 和 Design 作者保持在主会话 Inline 执行，同时使用 Interactive 协作。它们不是 Subagent。Requirements 和 Design 只有通过 Authority 测试的开放决策才形成等待点；章节和普通工程方案直接写入完整产物并由独立 Reviewer 检查。相互关联的开放决策合并为一个 Decision Package，关闭后不得换成章节措辞再次确认。Research 仍按自己的证据探索协议执行。编排器不得跨过真实等待点，也不得替用户批准 Hash Package。

只有最终作者产物写入且适用 Action 完成后，才允许启动独立 Reviewer 或进入下一能力。Reviewer 仍按 Agent 矩阵使用隔离上下文；Reviewer 提出实质内容变化时，控制权回到主会话作者，只有产生新的 Authority 决策才请求用户，不重新确认整个章节。

## 最低证据要求

记录命令、工作目录、开始/结束时间、退出码、通过/失败/跳过数量、相关 Scenario/Finding、运行 Commit，以及相关日志/截图/报告路径。通过 `rockspec check run` 执行的证据必须显式重复传入 `--scenario`、`--finding` 和 `--artifact`；Acceptance 报告的 `scenario_coverage` 必须把每个当前 Scenario 绑定到真实 executed Evidence。证据必须对当前 Gate 的产物 Hash 和 Commit 保持新鲜。

没有命令输出和退出状态时，不接受“测试通过”等声明。保留失败尝试，禁止将其改写为成功。清理密钥，但保留足以复现失败的诊断信息。

`prototype.required=true` 时，Acceptance 还必须提交由 `acceptance.validate` 实际执行、绑定当前 Commit 和报告 Hash 的响应式、可访问性及关键交互证据，并列出实际产物路径。只有 `kind: ui.prototype` 标签不足以通过 Gate。

## 审批与用户验收

人工批准不能直接调用裸 `approve`。先运行 `rockspec approval package <spec|design|implementation> <change-id>`，向用户一次性展示 Package 中冻结的决策、非目标、假设、开放问题和追踪摘要；用户确认的必须是该 Package，随后用返回 Hash 调用 `rockspec approve <gate> <change-id> --package <sha256>`。产物变化后旧 Package 自动失效。

`uat.policy=required` 时，Acceptance PASS 后进入 `UAT_PENDING`。用户按选定的核心批准 Scenario 体验冻结 Commit，确认后填写 `testing/uat-report.md` 并运行 `rockspec uat confirm <change-id>`；报告必须至少绑定一个当前批准 Scenario，不能引用未知 Scenario，且 Commit 与 Acceptance 一致。`optional` 或 `not_applicable` 不增加流程停点。任何反馈修订或 Acceptance 重跑都会使既有 UAT 失效。

## 状态一致性与交付边界

Engine 的每次快照/事件变更先写入 `runtime/state-transaction.yaml`，再写 `change.yaml` 和 `events.ndjson`；读取 Change 时会补齐单边成功的写入，并拒绝冲突序号或分叉状态。该日志解决进程中断和部分写入的一致性，不是针对拥有仓库写权限者的签名或恶意防篡改根。

`change.verify` 冻结 `delivery_head`。同一 Worktree 顺序开发后续 Change 时，当前 HEAD 可以继续前进，但 Finish/Archive 必须证明该冻结 Commit 仍是当前 HEAD 的祖先；历史重写或切换分支导致冻结 Commit 丢失时停止。前一个 Change 的 Review、Evidence、Knowledge 和 Archive 边界始终截止于自己的 `delivery_head`，不得吸收后续 Change 的提交。

## Finding 路由

使用 `PASS`、`CHANGES_REQUIRED` 或 `BLOCKED`。每个 Finding 包含稳定 ID、严重度、类别、具体证据、责任域、`route_to` Action ID、状态、`classification` 和 `authority_impact`。Critical 和 Important Finding 在 Engine 验证关闭前持续阻塞。分类与自动/人工边界统一遵循 [reconciliation-loop.md](reconciliation-loop.md)。

Task 修复最多恢复原 Implementer 两轮。Gate 通过前，将修复 amend 到该 Task 的唯一 Commit。Task 通过后，Acceptance 或 Final CR 发现的缺陷必须创建新的 Remediation Task 和 Commit，绝不重写已完成 Task Commit。

Engine 返回 `recovery` 时以它为唯一恢复路由。没有 Open Revision 时，`revision` 必须绑定原 Review Hash 和全部触发 Finding；已有 Open Revision 时使用 `rockspec revise --amend` 把新 Review Hash 和全部 Open Finding 追加为 `AM-xxx`，不得打开第二个 Revision。Engine 必要时把目标扩展到更上游并升级审批策略。实施中活动 Task 冻结为旧 Attempt，重新审批后以原 Base、新 execution、新 Brief 恢复。Completed/Suspended Task 永久保留；后续修改只能进入映射 `finding_ids` 的新 Remediation Task。

自动 Revision 的 Author 与 Reconciliation Reviewer 必须使用不同 execution ID。Reviewer 只读取 Engine 固定的 Package；首次 Gate、权威边界变化或未知、Reviewer 分歧和两轮未收敛升级人工。Critical Finding 始终阻塞到修复和复审通过，并使用 Deep 核验；当它属于内部技术 `derived_gap|consistency_fix|implementation_fix + unchanged` 时，不因严重度单独要求产品用户选择实现。自动对账完成后继续重放全部失效下游 Action/Gate，不能只修复最上游文件便关闭 Revision。

## 失败处理

Subagent 超时、越权、修改状态、无法提供证据或尝试递归委派时，拒绝其报告并将控制权交还编排器。Provider 或环境不可用时报告准确阻塞原因。重试前重新查询 Engine 状态，因为之前的产物变化可能已经使审批失效。
