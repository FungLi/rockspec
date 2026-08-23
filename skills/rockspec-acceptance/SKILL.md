---
name: rockspec-acceptance
description: 用于 TE、验收或 E2E 验证；依据已批准 Scenario 或外部标准验证已集成实现，并在 Final CR 前产出测试资产和新鲜证据。
---

# RockSpec 验收

只产出一个结果：带有可复现证据的独立验收结论。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 仅在所有执行中的 Task 和 Remediation Task Gate 均通过，且每个 `superseded` Task 的 Replacement 已完成并通过评审后使用 **Attached（挂接）** 模式。
- 针对用户提供的验收标准、PRD/Spec 或已实现分支使用 **Standalone（独立）** 模式。将计划、报告、证据和 `receipt.yaml` 写入 `.rockspec/workbench/acceptance/<slug>/`；不得声称已具备 RockSpec Final CR 条件。

## 执行

1. 按 `acceptance.validate` 的 `model_policy` 检查 Profile、Scenario 风险、公共接缝和验收范围，选择不低于 `minimum` 的 Tier，再由当前 Host Adapter 映射并显式指定模型后启动现有 Acceptance Subagent。
2. 只依据可观察的 Requirement 和 Scenario 设计测试计划，不读取 Task Review 或 Delivery Review 的结论。
3. 将每个适用 Scenario 映射到可执行检查，或给出明确理由的人工检查。
4. 按需新增集成/E2E 测试、Fixture 和测试配置，但不得修改业务实现。
5. 在 Attached 完成前提交 TE 所有的测试资产。准确记录环境、命令、工作目录、退出码、失败、跳过项、Commit 和报告路径。
6. UI 变更调用已配置的 `ui.prototype` Provider，采集响应式、可访问性、关键状态和交互证据。
7. 报告必须使用结构化 Frontmatter，绑定当前 Commit、真实 Acceptance execution ID 和全部 Finding。每个 Finding 都声明 `classification` 和 `authority_impact`：只恢复既定实现使用 `implementation_fix + unchanged`，缺少已批准行为的下游派生使用 `derived_gap + unchanged`；改变意图/决策、接受风险或无法判断时使用对应人工分类及 `changed|unknown`。实现失败使用 `owner_domain: implementation`、`route_to: task.execute`；测试资产失败使用 `owner_domain: testing`、`route_to: acceptance.validate`；发现上游缺口时路由对应 Requirements/Design/Plan Action。
   人工体验反馈不要求伪造 non-PASS Review。将同一轮相关意见合并为一个 `rockspec feedback submit` Feedback Batch；Engine 会把同 Change 路由为 `feedback_reopen` Revision，保留已完成 Task，并使受影响的验收、Delivery Review、验证和知识演进重新进入新鲜证据周期。
8. Attached 模式提交 `acceptance.validate` 并重新读取 `status.recovery`。实现失败进入 Finding 绑定的 Remediation Planning，保留已完成 Task/Commit；测试资产失败留在本 Skill 修复；上游缺口按 Engine 推导目标开启 Recovery Revision。

测试计划和报告可从 [test-plan.md](assets/test-plan.md) 与 [test-report.md](assets/test-report.md) 起草。测试前读取 [action-acceptance.validate.yaml](references/action-acceptance.validate.yaml) 和 [role-acceptance-test-engineer.md](references/role-acceptance-test-engineer.md)。

Final CR 不属于本 Skill。验收 `PASS` 后将下一步交给 `$rockspec-review`，并使用 Delivery 范围。
