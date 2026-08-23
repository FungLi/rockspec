---
name: rockspec-review
description: 用于 Code Review、Task Review、Worktree 或分支评审，以及 TE 后 Final CR；依据 Requirements、Design、仓库规范和测试独立评审固定 Diff。
---

# RockSpec 评审

只产出一个结果：基于证据、只读的固定对象评审。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择范围

- **Attached Task** 模式评审活动 Task 从固定基线到最终 Commit 的 Diff。
- **Attached Delivery** 模式仅在 TE 通过且修复完成后，评审基线到验收后最终 Commit 的完整 Diff。
- **Attached Reconciliation** 模式评审 Engine 固定的 Revision/Gate 产物，证明修改只恢复既有 Authority Baseline，没有产生新意图、决策或风险接受。
- **Standalone（独立）** 模式要求固定点，或确定安全的 Merge Base；尽可能定位原始 Spec，并将报告和 `receipt.yaml` 写入 `.rockspec/workbench/review/<slug>/`。没有 Spec 时必须明确说明。

## 执行

1. Attached 模式先执行 `rockspec review package task <change-id> --task <task-id>` 或 `rockspec review package delivery <change-id>`。只把 Engine 返回的 Review Package 作为 Diff 来源；拒绝自行选择 Merge Base、评审工作区未提交改动，或在评审期间跟随移动的 HEAD。把 Package 的 `base_commit`、`head_commit`、`diff_hash` 原样写入报告 `subject`。
2. 按对应 Action 的 `model_policy` 检查 Profile、评审范围、Diff 风险和 Implementer Tier，选择不低于 `minimum` 的 Tier，再由 Host Adapter 显式指定模型。每个 Reviewer 必须登记真实 execution ID，不能与任何被评审 Implementer 相同，保持只读且不得委派。Strict 使用两个相互独立且 Tier 相同的 Reviewer，彼此不能读取报告，聚合前保留两份原始报告。Delivery Review 始终使用 Deep。
3. 首轮直接检查 Review Package 中的完整 Diff、相关 Specs/Design、Implementer Report 和 Evidence；不要把摘要或既有 Review 结论当作证明。检查 Spec Compliance、Design Compliance、仓库规范、行为、测试、回归、范围和运行风险。Task Package 的 `planned_paths` 仅是计划参考；逐项核验 `expanded_paths` 是否确为当前 Task 行为所需。Delivery 范围必须包含 TE 新增的测试、Fixture、配置和 UI 证据。
4. 不要例行重复运行全量测试：Engine 的 executed Evidence 是基础证明。只有具体代码疑点、证据缺口或测试可信度问题需要验证时，才运行最小聚焦检查，并在报告中说明原因和观察。
5. 每个 Finding 必须进入 YAML Frontmatter，包含稳定 ID、`critical|important|minor`、小写连字符 Category、具体证据、描述、责任域、合法 Action 路由、状态、`classification` 和 `authority_impact`。无法证明权威边界未改变时使用 `unknown`；不得把决策、意图或风险接受错误标成 `unchanged`。`PASS` 不得包含 Open Critical/Important；非 `PASS` 必须至少包含一个 Open Finding。
6. Task Finding 按根因路由：实现、测试或无正当理由的文件扩展到 `task.execute`；已批准 Requirements 不足到 `requirements.clarify`；Design 不足到 `design.technical`；只有验收标准、接口契约、依赖或责任划分需要改变时才到 `plan.create`。文件超出 `planned_paths` 本身不是 Finding，也不能单独触发 Plan Revision。Delivery 的实现缺陷到 `task.execute` 并进入 Remediation Planning，验收资产缺陷到 `acceptance.validate`。`owner_domain` 与 `route_to` 必须一致。
7. 修复轮次使用新 Review Package 固定新 Subject，同时以旧报告的 `subject.head_commit..新 subject.head_commit` 查看 Fix Diff。只复核 Open Finding、Fix Diff 和被修复行为的聚焦证据；修复引入独立新问题时才新增 Finding。新报告携带上一轮全部 Findings，保持 ID 和原始描述，按结果更新状态，再追加新 Finding；`round` 依次为 `0`、`1`、`2`，不得复用旧 Subject 或伪装轮次。
8. Attached 模式把报告写入约定路径，再执行 `rockspec action complete task.review <change-id> --verdict <verdict>` 或 `rockspec action complete delivery.review <change-id> --verdict <verdict>`。随后重新读取 `status.recovery`：普通 Task 实现 Finding 交给修复轮；上游 Finding 必须按 Engine 返回的 Review/Finding 绑定开启 Recovery Revision；Delivery 验收资产 Finding 返回 Acceptance。文字上的成功声明不能通过 Gate。

## 对账评审

当 Engine 推荐 `reconcile.spec|reconcile.design|reconcile.implementation` 时：

1. 执行 `rockspec reconcile prepare <spec|design|implementation> <change-id>`，只读取返回的 Package、Revision 前后产物、触发 Finding 和 Authority Baseline。
2. 按 Gate 风险选择不低于对应原 Review 的模型强度，登记真实 Reviewer execution ID。Reviewer 必须不同于 Revision Author，保持只读、不得委派。Strict 原 Action 的双 Reviewer 必须已经聚合为一致 PASS；原 Reviewer 分歧或对账 Reviewer 无法确认边界时升级人工。
3. 检查当前产物是否只处理冻结 Finding、追踪和下游派生是否闭合，以及范围、外部行为、验收标准、已批准技术/计划决策和风险边界是否未变。不要以文字相似代替语义对账。
4. 从 [reconciliation-review.md](assets/reconciliation-review.md) 填写 Engine 创建的报告，原样保留 Package 的 Revision、Gate、轮次、分类、Finding ID 和 Subject Hash。`PASS` 必须是 `authority_delta: unchanged` 且无 Open Finding；不能证明时使用 `changed|unknown` 并升级人工。
5. 执行 `rockspec reconcile complete <gate> <change-id> --verdict <verdict>`。PASS 只续期该 Revision 失效的既有人工 Gate；非 PASS 回到责任 Skill，最多两轮。首次审批、Critical、边界变化/未知、Reviewer 分歧或两轮未收敛必须等待用户。

可从 [review.md](assets/review.md) 起草报告。Task 范围读取 [action-task.review.yaml](references/action-task.review.yaml) 和 [role-task-change-reviewer.md](references/role-task-change-reviewer.md)；Delivery 范围读取 [action-delivery.review.yaml](references/action-delivery.review.yaml) 和 [role-delivery-reviewer.md](references/role-delivery-reviewer.md)。

报告固定 Review Subject、Reviewer execution ID、轮次、结论、结构化 Findings、受影响产物，以及下一负责 Skill。
