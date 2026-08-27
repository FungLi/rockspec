---
name: rockspec-plan
description: 用于实施计划、任务拆分或从既有 Design 开始；将 Requirements 和 Design 转换为可执行 Task DAG，并评审实施就绪度。
---

# RockSpec 计划

## 产物语言

读取 `.rockspec/config.yaml` 的 `artifact_language`；缺省按 `zh-CN`。Plan、Task、Review 和终端摘要使用配置语言，Schema Key、R/S/D/T/F ID、CLI/Action、Verdict 和接口标识保持英文。

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
5. 为每个 Task 写明预计文件范围、非目标、追踪 ID、验收标准、依赖和环境前置条件。在 YAML Frontmatter 中填入 `dependencies`、`supersedes`、`requirement_ids`、`scenario_ids`、`decision_ids`、`finding_ids`、`acceptance_criteria`、`validation_commands`、`consumes`、`produces` 和 `allowed_paths`。`validation_commands` 声明完成前必须实际成功执行的准确命令，应覆盖受影响的构建、类型检查、测试发现与行为回归，但不为某种语言硬编码规则。每个当前 Design Decision 必须至少映射到一个 Task。`dependencies` 只表达执行前置；新增 `supersedes` 只表达 implementation Recovery 中对冻结实现基线的接管；在 feedback reopen 或后续 Recovery 中必须原样保留已经完成的历史 `supersedes` 关系。普通 Task 使用 `supersedes: []` 和 `finding_ids: []`；Replacement/Remediation Task 映射触发 Finding。`allowed_paths` 是计划阶段能合理预见的项目相对路径，作为实施和评审参考而非硬白名单；`consumes`/`produces` 使用完全一致的接口字符串。
   当 Delivery 归属检查发现 Change base 之后已有、行为已获批准但没有 Task 归属的历史产品 Commit 时，只能在 Open `implementation_recovery` 中新增 Finding-bound Task，并声明 `adopted_commit: <sha>`。该 Task 不创建或改写产品 Commit；目标提交必须仍位于 `change.base_commit..HEAD`、是当前 HEAD 祖先且未被其他 Task 归属。普通 Task、预实施计划和非 Finding 修订不得声明该字段。
6. 为每个 Task 写出测试先行步骤、准确命令以及预期失败和成功观察。只在固定接口或测试行为确有必要时给出短代码片段，不在 Plan 中预写大段最终实现。UI Task 必须引用已批准的 Prototype 产物。
7. Implementation Recovery 中不得删除或重定义 Completed/Suspended Task。每个 Suspended Task 必须选择一种收敛方式：继续原 Task 时不被任何新 Task supersede；转移责任时新增 Task，以 `supersedes: [T-xxx]` 指向旧 Task，并从普通 `dependencies` 删除旧 Task。Replacement 使用新 Task ID、独立 Commit 和触发 Finding；下游依赖改指 Replacement。不得把旧 Task 伪装成 Completed。`feedback_reopen` 同步时，Completed/Superseded/Suspended 历史 Task 的原始 `requirement_ids`/`scenario_ids` 必须保留；仍存在于当前 Spec 的 ID 可继续贡献覆盖，已被 Revision 删除的 ID 只保留追踪、不再阻塞或计入当前覆盖；新增或待执行 Task 仍必须完整通过当前 Spec 校验。
8. 只有不需要产品 Task、将在 Acceptance 中直接验证的 Scenario 才能进入 `plan.md` Frontmatter 的 `verification_only_scenario_ids`。禁止 `TODO`、`TBD`、“适当处理”、“类似上一 Task”等占位。写入后重新读取完整计划，自检 Requirements/Scenarios/Finding 覆盖、依赖目标、DAG、`allowed_paths`、验收标准和跨 Task 接口一致性；结合当前 Completed/Suspended/Pending 状态模拟完整执行顺序，确认至少一个 Task 可启动且不存在永久阻塞路径。逐个运行 `rockspec validate <change-id> --artifact plan.md` 和 `--artifact tasks/T-xxx.md`，按字段、期望类型和合法值修正后再提交 Action；dry-run 复用现有 Schema，不新增人工 Gate。
9. 调度规定数量的独立 Readiness Reviewer 前，按 `readiness.review` 的 `model_policy` 选择 Tier；每个 Reviewer 先执行 `rockspec execution start readiness.review --role readiness_reviewer --model-tier <tier> --host-model <model> --context-package <path> --context-hash <sha256>`，并把返回 ID 写入报告。Context Package 只包含当前 Plan/Task DAG、R/S/D 映射、环境前置和验证命令，不继承完整父会话。Reviewer 返回并写完报告后立即执行 `rockspec execution complete <id> <change-id> --outcome <outcome>`，有 Host Adapter 回执时附带 Token 用量。不得低于 `minimum`；Strict 的两个 Reviewer 使用同一 Tier，保持只读、隔离且不得委派。
10. Readiness Reviewer 必须从结构化模板写报告；非 PASS 必须至少包含一个 Open Finding。Attached 模式依次提交 `plan.create` 和 `readiness.review`。Review PASS 后运行 `rockspec preflight environment <change-id>`（若 `.rockspec/config.yaml` 声明数据库、浏览器或凭据探针）再运行 `rockspec preflight implementation <change-id>`；安装一致性、环境探针、审批新鲜度、Task DAG、Recovery 和三种 Task Review 路径全部通过后才请求或续期实施审批。首次 Gate 或 `gate_policies.implementation: human` 再运行 `rockspec approval package implementation <change-id>`，以 CLI 按 `artifact_language` 返回的摘要（默认中文）为事实来源，在会话区展示实施范围、Task DAG、任务目标与关键文件、依赖契约、验证验收、风险和待决定事项；不得只报告计划已完成。允许合并重复项或按阶段归组，摘要不完整不得阻断流程。正式材料只展示一次 `artifact_root`，Plan、Task 和 Readiness Review 分别按编号列出名称、相对路径和用途，不得把路径重新拼成一行。用户需要细查时直接阅读正式产物，不创建二次 Preview 文档。用户回复“批准实施”或等价明确表达后，Agent 在内部使用返回 Hash 执行 `rockspec approve implementation <change-id> --package <sha256>`，不得要求用户理解、复制或复述 Hash；`auto` 交给 `$rockspec-review`，`preserve` 不重复审批。

投影契约：下游 Implementer 只会收到当前 Task 与按 ID 投影的 R/S/D、全局约束和依赖交付事实；因此 Task 必须在不读取完整 Design/Plan 的情况下自包含到可独立实施，不得使用“参考 Design 自行判断”一类隐式指令。

Recovery 中的历史归属 Task 使用新 Task ID、触发 Finding 和 `adopted_commit`，但不产生新 Commit，也不替代或改写已有 Task。实施预检公开三种 Task Review 路径：普通产品 Commit、零产品 Diff 的 `scope_blocked`，以及固定单个既有 Commit 的 `historical_attribution`。

可从 [plan.md](assets/plan.md)、[task.md](assets/task.md) 和 [readiness-review.md](assets/readiness-review.md) 起草产物。对应工作前读取 [action-plan.create.yaml](references/action-plan.create.yaml)、[action-readiness.review.yaml](references/action-readiness.review.yaml) 和 [role-readiness-reviewer.md](references/role-readiness-reviewer.md)。

报告计划来源、Task 数量和 DAG、覆盖缺口、评审结论、审批状态，并将 `$rockspec-implement` 作为通常的下一能力。
