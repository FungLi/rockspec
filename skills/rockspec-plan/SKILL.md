---
name: rockspec-plan
description: 将已批准的 RockSpec Requirements 和 Design，或现有外部设计，转换为可执行的 Task DAG，并独立评审实施就绪度。用户需要实施计划、希望从现有设计直接开始，或 Engine 推荐 plan.create、readiness.review 或实施审批时使用。
---

# RockSpec 计划

只产出一个结果：经过独立评审、可直接实施的任务计划。

## 选择模式

- Change 合法允许计划或 Readiness 工作，且 Design 审批仍有效时使用 **Attached（挂接）** 模式。
- 从外部 Design、Spec、Issue 或已达成一致的对话开始时使用 **Standalone（独立）** 模式。将 `plan.md`、`tasks.md`、Task Brief、评审和 `receipt.yaml` 写入 `.rockspec/workbench/plan/<slug>/`；不得声称获得实施审批。

## 执行

1. 从磁盘重新读取已批准的 Requirements、Design、适用的 Prototype 和已有计划，再检查仓库边界、接口、依赖、验证命令和交付约束；不要依赖聊天记忆。
2. 先检查 Design 是否仍包含可独立交付的多个子系统或未解决设计工作；发现时停止拆 Task，并在 Attached 模式路由回 `design.technical`。
3. 在拆 Task 前建立文件职责图：列出需要创建、修改和测试的准确路径及其单一职责。遵循现有仓库模式，只规划服务当前目标的边界调整。
4. 创建覆盖全部 Requirement 和 Scenario 的无环 Task DAG。Task 是拥有完整测试循环、值得独立 Commit 和 Review 的最小交付单元；不要为了满足固定时长而拆成失去独立价值的微步骤。
5. 为每个 Task 写明准确文件范围、非目标、追踪 ID、验收标准、依赖和环境前置条件。在 YAML Frontmatter 中填入 `dependencies`、`requirement_ids`、`scenario_ids`、`acceptance_criteria`、`consumes`、`produces` 和 `allowed_paths`。`allowed_paths` 必须逐项列出可能创建、修改或测试的项目相对路径，不得包含绝对路径、`..`、反斜杠或 `.rockspec/**`；`consumes`/`produces` 使用完全一致的接口名称、签名和类型字符串。
6. 为每个 Task 写出测试先行步骤、准确命令以及预期失败和成功观察。只在固定接口或测试行为确有必要时给出短代码片段，不在 Plan 中预写大段最终实现。UI Task 必须引用已批准的 Prototype 产物。
7. 只有不需要产品 Task、将在 Acceptance 中直接验证的 Scenario 才能进入 `plan.md` Frontmatter 的 `verification_only_scenario_ids`。禁止 `TODO`、`TBD`、“适当处理”、“类似上一 Task”等占位。写入后重新读取完整计划，自检 Requirements/Scenarios 覆盖、依赖目标、DAG、`allowed_paths`、验收标准和跨 Task 接口一致性；发现问题直接修订。
8. 调度规定数量的独立 Readiness Reviewer 前，按 `readiness.review` 的 `model_policy` 从 Profile、Design、Plan 和 Task DAG 选择 Tier，再由当前 Host Adapter 映射并显式指定模型。不得低于 `minimum` 或静默使用更弱 Tier；Strict 的两个 Reviewer 使用同一 Tier。保持 Reviewer 只读、与作者隔离且不得委派。
9. Attached 模式依次提交 `plan.create` 和 `readiness.review`，随后为绑定 Hash 的实施审批暂停。

可从 [plan.md](assets/plan.md) 和 [task.md](assets/task.md) 起草产物。对应工作前读取 [action-plan.create.yaml](references/action-plan.create.yaml)、[action-readiness.review.yaml](references/action-readiness.review.yaml) 和 [role-readiness-reviewer.md](references/role-readiness-reviewer.md)。

报告计划来源、Task 数量和 DAG、覆盖缺口、评审结论、审批状态，并将 `$rockspec-implement` 作为通常的下一能力。
