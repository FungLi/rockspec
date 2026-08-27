---
name: rockspec-acceptance
description: 用于 TE、验收或 E2E 验证；依据已批准 Scenario 或外部标准验证已集成实现，并在 Final CR 前产出测试资产和新鲜证据。
---

# RockSpec 验收

## 产物语言

读取 `.rockspec/config.yaml` 的 `artifact_language`；缺省按 `zh-CN`。测试计划、验收报告和终端摘要使用配置语言，Schema Key、R/S/T/F ID、CLI/Action、Verdict 和测试命令保持英文。

只产出一个结果：带有可复现证据的独立验收结论。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 仅在所有执行中的 Task 和 Remediation Task Gate 均通过，且每个 `superseded` Task 的 Replacement 已完成并通过评审后使用 **Attached（挂接）** 模式。
- 针对用户提供的验收标准、PRD/Spec 或已实现分支使用 **Standalone（独立）** 模式。将计划、报告、证据和 `receipt.yaml` 写入 `.rockspec/workbench/acceptance/<slug>/`；不得声称已具备 RockSpec Final CR 条件。

## 执行

1. 按 `acceptance.validate` 的 `model_policy` 检查 Profile、Scenario 风险、公共接缝和验收范围，选择不低于 `minimum` 的 Tier；先执行 `rockspec execution start acceptance.validate --role acceptance_engineer --model-tier <tier> --host-model <model> --context-package <path> --context-hash <sha256>`，把返回的 execution ID 交给现有 Acceptance Subagent。Context Package 只包含 Scenario 矩阵、批准的 Specs/Design 引用、当前 Commit 和验证命令，不继承完整父会话。Agent 返回并写完报告后立即执行 `rockspec execution complete <id> <change-id> --outcome <outcome>`，有 Host Adapter 回执时附带 Token 用量。
2. 只依据可观察的 Requirement 和 Scenario 设计测试计划，不读取 Task Review 或 Delivery Review 的结论。写完报告后先执行 `rockspec validate <change-id> --artifact testing/test-report.md` dry-run，再在提交 `acceptance.validate` 前执行 `rockspec preflight acceptance <change-id>`；后者一次性检查报告、Scenario 覆盖、Evidence、Artifact、Commit 和 execution 身份，失败时按返回的唯一恢复命令修复。
3. 将每个批准 Scenario 映射到可执行检查。通过 `rockspec check run ... --action acceptance.validate --scenario S-xxx` 记录 executed evidence；同一绑定条件下已有新鲜 Evidence 时 Engine 会复用日志，诊断需要强制重跑时使用 `--no-cache`；同一命令覆盖多个 Scenario 时逐个重复 `--scenario`，不得用无业务绑定的成功命令代替覆盖。
4. 按需新增集成/E2E 测试、Fixture 和测试配置，但不得修改业务实现。
5. 在 Attached 完成前提交 TE 所有的测试资产。准确记录环境、命令、工作目录、退出码、失败、跳过项、Commit 和报告路径。
6. UI 变更调用已配置的 `ui.prototype` Provider，采集响应式、可访问性和交互证据。每条 `ui.prototype` executed evidence 至少通过一个 `--artifact <path>` 绑定可检查制品，并在报告 `ui_evidence` 中覆盖三种 dimension。
7. 报告必须使用结构化 Frontmatter，绑定当前 Commit、真实 Acceptance execution ID 和全部 Finding。每个 Finding 都声明 `classification` 和 `authority_impact`：只恢复既定实现使用 `implementation_fix + unchanged`，缺少已批准行为的下游派生使用 `derived_gap + unchanged`；改变意图/决策、接受风险或无法判断时使用对应人工分类及 `changed|unknown`。实现失败使用 `owner_domain: implementation`、`route_to: task.execute`；测试资产失败使用 `owner_domain: testing`、`route_to: acceptance.validate`；发现上游缺口时路由对应 Requirements/Design/Plan Action。
   人工体验反馈不要求伪造 non-PASS Review。将同一轮相关意见合并为一个 `rockspec feedback submit` Feedback Batch；Engine 会把同 Change 路由为 `feedback_reopen` Revision，保留已完成 Task，并使受影响的验收、Delivery Review、验证和知识演进重新进入新鲜证据周期。
8. Attached 模式提交 `acceptance.validate` 并重新读取 `status.recovery`。实现失败进入 Finding 绑定的 Remediation Planning，保留已完成 Task/Commit；测试资产失败留在本 Skill 修复；上游缺口按 Engine 推导目标开启 Recovery Revision。
9. PASS 后读取 `change.uat.policy`。只有 `required` 才向用户展示一次结构化 UAT 审阅投影：本次确认对象、核心 Scenario、预期与实际结果、证据、未通过/跳过项、残留风险和确认后的影响；用户可直接在会话区完成核心验收，也可按列出的正式报告路径下钻。展示规则是柔性的，摘要不完整或格式变化不得替代正式报告，也不得额外阻断确认。使用 [uat-report.md](assets/uat-report.md) 记录确认后执行 `rockspec uat confirm`；`optional|not_applicable` 不增加停止点，直接交给 Delivery Review。

测试计划和报告可从 [test-plan.md](assets/test-plan.md) 与 [test-report.md](assets/test-report.md) 起草。测试前读取 [action-acceptance.validate.yaml](references/action-acceptance.validate.yaml) 和 [role-acceptance-test-engineer.md](references/role-acceptance-test-engineer.md)；需要人工 UAT 时再读取 [action-acceptance.uat.yaml](references/action-acceptance.uat.yaml)。

Final CR 不属于本 Skill。验收 `PASS` 且 required UAT 确认后，将下一步交给 `$rockspec-review`，并使用 Delivery 范围。
