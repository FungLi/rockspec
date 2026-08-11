---
name: rockspec-acceptance
description: 对已集成实现执行独立验收，依据已批准的 RockSpec Scenario 或外部验收标准验证可观察行为，在 Final CR 前产出已提交的测试资产和新鲜证据。用户要求 TE、验收、E2E 验证，或 Engine 推荐 acceptance.validate 时使用。
---

# RockSpec 验收

只产出一个结果：带有可复现证据的独立验收结论。

## 选择模式

- 仅在所有 Task 和 Remediation Task Gate 均通过后使用 **Attached（挂接）** 模式。
- 针对用户提供的验收标准、PRD/Spec 或已实现分支使用 **Standalone（独立）** 模式。将计划、报告、证据和 `receipt.yaml` 写入 `.rockspec/workbench/acceptance/<slug>/`；不得声称已具备 RockSpec Final CR 条件。

## 执行

1. 按 `acceptance.validate` 的 `model_policy` 检查 Profile、Scenario 风险、公共接缝和验收范围，选择不低于 `minimum` 的 Tier，再由当前 Host Adapter 映射并显式指定模型后启动现有 Acceptance Subagent。
2. 只依据可观察的 Requirement 和 Scenario 设计测试计划，不读取 Task Review 或 Delivery Review 的结论。
3. 将每个适用 Scenario 映射到可执行检查，或给出明确理由的人工检查。
4. 按需新增集成/E2E 测试、Fixture 和测试配置，但不得修改业务实现。
5. 在 Attached 完成前提交 TE 所有的测试资产。准确记录环境、命令、工作目录、退出码、失败、跳过项、Commit 和报告路径。
6. UI 变更调用已配置的 `ui.prototype` Provider，采集响应式、可访问性、关键状态和交互证据。
7. Attached 模式提交 `acceptance.validate`。实现失败转为 Remediation Task；测试资产失败留在本 Skill 修复。

测试计划和报告可从 [test-plan.md](assets/test-plan.md) 与 [test-report.md](assets/test-report.md) 起草。测试前读取 [action-acceptance.validate.yaml](references/action-acceptance.validate.yaml) 和 [role-acceptance-test-engineer.md](references/role-acceptance-test-engineer.md)。

Final CR 不属于本 Skill。验收 `PASS` 后将下一步交给 `$rockspec-review`，并使用 Delivery 范围。
