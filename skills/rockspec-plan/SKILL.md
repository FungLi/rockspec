---
name: rockspec-plan
description: 用于实施计划、任务拆分或从既有 Design 开始；将 Requirements 和 Design 转换为可执行 Task DAG，并评审实施就绪度。
---

# RockSpec 计划

只产出一个结果：经过独立评审、可直接实施的任务计划。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- Change 合法允许计划或 Readiness 工作，且 Design 审批仍有效时使用 **Attached（挂接）** 模式。
- 从外部 Design、Spec、Issue 或已达成一致的对话开始时使用 **Standalone（独立）** 模式。将 `plan.md`、`tasks.md`、Task Brief、评审和 `receipt.yaml` 写入 `.rockspec/workbench/plan/<slug>/`；不得声称获得实施审批。

Attached 中，首次计划、用户主动调整或 Engine 对当前 Gate 返回 `gate_policies.<gate>: human` 时使用 **authoring**；Open Revision 对当前 Gate 返回 `auto` 且 Authority Impact 为 `unchanged` 时使用 **reconciliation**。`preserve` 表示该 Gate 未失效。reconciliation 只补齐已批准 Requirements/Design 的 Task、追踪和验证派生内容；需要重新选择交付边界、接受风险或改变已批准决策时停止并升级人工。

## 执行

1. 从磁盘重新读取已批准的 Requirements、Design、适用的 Prototype、已有计划和 Open Revision，再检查仓库边界、接口、依赖、验证命令和交付约束；不要依赖聊天记忆。
2. 先检查 Design 是否仍包含可独立交付的多个子系统或未解决设计工作；发现时停止拆 Task，并在 Attached 模式路由回 `design.technical`。
3. 在拆 Task 前建立文件职责图：列出需要创建、修改和测试的准确路径及其单一职责。遵循现有仓库模式，只规划服务当前目标的边界调整。
4. 创建覆盖全部 Requirement 和 Scenario 的无环 Task DAG。Task 是拥有完整测试循环、值得独立 Commit 和 Review 的最小交付单元；不要为了满足固定时长而拆成失去独立价值的微步骤。
5. 为每个 Task 写明预计文件范围、非目标、追踪 ID、验收标准、依赖和环境前置条件。在 YAML Frontmatter 中填入 `dependencies`、`supersedes`、`requirement_ids`、`scenario_ids`、`finding_ids`、`acceptance_criteria`、`consumes`、`produces` 和 `allowed_paths`。`dependencies` 只表达执行前置；新增 `supersedes` 只表达 implementation Recovery 中对冻结实现基线的接管；在 feedback reopen 或后续 Recovery 中必须原样保留已经完成的历史 `supersedes` 关系，Engine 仅在 Task 定义、旧状态、`superseded_by` 和历史 Revision 关系完全一致时接受。普通 Task 使用 `supersedes: []` 和 `finding_ids: []`；Replacement/Remediation Task 映射触发 Finding。`allowed_paths` 一次性列出计划阶段能合理预见的项目相对路径，作为实施和评审参考而非硬白名单；`consumes`/`produces` 使用完全一致的接口字符串。
6. 为每个 Task 写出测试先行步骤、准确命令以及预期失败和成功观察。只在固定接口或测试行为确有必要时给出短代码片段，不在 Plan 中预写大段最终实现。UI Task 必须引用已批准的 Prototype 产物。
7. Implementation Recovery 中不得删除或重定义 Completed/Suspended Task。每个 Suspended Task 必须选择一种收敛方式：继续原 Task 时不被任何新 Task supersede；转移责任时新增 Task，以 `supersedes: [T-xxx]` 指向旧 Task，并从普通 `dependencies` 删除旧 Task。Replacement 使用新 Task ID、独立 Commit 和触发 Finding；下游依赖改指 Replacement。不得把旧 Task 伪装成 Completed。`feedback_reopen` 同步时，Completed/Superseded/Suspended 历史 Task 的原始 `requirement_ids`/`scenario_ids` 必须保留；仍存在于当前 Spec 的 ID 可继续贡献覆盖，已被 Revision 删除的 ID 只保留追踪、不再阻塞或计入当前覆盖；新增或待执行 Task 仍必须完整通过当前 Spec 校验。
8. 只有不需要产品 Task、将在 Acceptance 中直接验证的 Scenario 才能进入 `plan.md` Frontmatter 的 `verification_only_scenario_ids`。禁止 `TODO`、`TBD`、“适当处理”、“类似上一 Task”等占位。写入后重新读取完整计划，自检 Requirements/Scenarios/Finding 覆盖、依赖目标、DAG、`allowed_paths`、验收标准和跨 Task 接口一致性；结合当前 Completed/Suspended/Pending 状态模拟完整执行顺序，确认至少一个 Task 可启动且不存在永久阻塞路径。
9. 调度规定数量的独立 Readiness Reviewer 前，按 `readiness.review` 的 `model_policy` 从 Profile、Design、Plan 和 Task DAG 选择 Tier，再由当前 Host Adapter 映射并显式指定模型。不得低于 `minimum` 或静默使用更弱 Tier；Strict 的两个 Reviewer 使用同一 Tier。保持 Reviewer 只读、与作者隔离且不得委派。
10. Readiness Reviewer 必须从结构化模板写报告；每个 Finding 包含 `classification` 和 `authority_impact`，非 PASS 必须至少包含一个 Open Finding。Attached 模式依次提交 `plan.create` 和 `readiness.review`。Review PASS 后、请求首次实施审批或执行自动对账前，运行 `rockspec preflight implementation <change-id>`；它必须同时确认安装发行 Hash、审批新鲜度、Readiness、Task DAG、Recovery 状态以及产品/零 Diff 两种 Review 路径。首次 Gate 或 `gate_policies.implementation: human` 才暂停等待用户，`auto` 交给 `$rockspec-review` 执行 `reconcile.implementation`，`preserve` 不重复审批。

可从 [plan.md](assets/plan.md)、[task.md](assets/task.md) 和 [readiness-review.md](assets/readiness-review.md) 起草产物。对应工作前读取 [action-plan.create.yaml](references/action-plan.create.yaml)、[action-readiness.review.yaml](references/action-readiness.review.yaml) 和 [role-readiness-reviewer.md](references/role-readiness-reviewer.md)。

报告计划来源、Task 数量和 DAG、覆盖缺口、评审结论、审批状态，并将 `$rockspec-implement` 作为通常的下一能力。
