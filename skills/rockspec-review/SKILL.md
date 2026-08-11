---
name: rockspec-review
description: 针对固定的 Task Diff、分支、Worktree 或最终集成变更，依据 Requirements、Design、仓库规范和测试执行独立评审。独立 Code Review、逐 Task Review、验收后的 Final CR，或 Engine 推荐 task.review 或 delivery.review 时使用。
---

# RockSpec 评审

只产出一个结果：基于证据、只读的固定对象评审。

## 选择范围

- **Attached Task** 模式评审活动 Task 从固定基线到最终 Commit 的 Diff。
- **Attached Delivery** 模式仅在 TE 通过且修复完成后，评审基线到验收后最终 Commit 的完整 Diff。
- **Standalone（独立）** 模式要求固定点，或确定安全的 Merge Base；尽可能定位原始 Spec，并将报告和 `receipt.yaml` 写入 `.rockspec/workbench/review/<slug>/`。没有 Spec 时必须明确说明。

## 执行

1. Attached 模式先执行 `rockspec review package task <change-id> --task <task-id>` 或 `rockspec review package delivery <change-id>`。只把 Engine 返回的 Review Package 作为 Diff 来源；拒绝自行选择 Merge Base、评审工作区未提交改动，或在评审期间跟随移动的 HEAD。把 Package 的 `base_commit`、`head_commit`、`diff_hash` 原样写入报告 `subject`。
2. 按对应 Action 的 `model_policy` 检查 Profile、评审范围、Diff 风险和 Implementer Tier，选择不低于 `minimum` 的 Tier，再由 Host Adapter 显式指定模型。每个 Reviewer 必须登记真实 execution ID，不能与任何被评审 Implementer 相同，保持只读且不得委派。Strict 使用两个相互独立且 Tier 相同的 Reviewer，彼此不能读取报告，聚合前保留两份原始报告。Delivery Review 始终使用 Deep。
3. 首轮直接检查 Review Package 中的完整 Diff、相关 Specs/Design、Implementer Report 和 Evidence；不要把摘要或既有 Review 结论当作证明。检查 Spec Compliance、Design Compliance、仓库规范、行为、测试、回归、范围和运行风险。Delivery 范围必须包含 TE 新增的测试、Fixture、配置和 UI 证据。
4. 不要例行重复运行全量测试：Engine 的 executed Evidence 是基础证明。只有具体代码疑点、证据缺口或测试可信度问题需要验证时，才运行最小聚焦检查，并在报告中说明原因和观察。
5. 每个 Finding 必须进入 YAML Frontmatter，包含稳定 ID、`critical|important|minor`、小写连字符 Category、具体证据、描述、责任域、合法 Action 路由和状态。`PASS` 不得包含 Open Critical/Important；非 `PASS` 必须至少包含一个 Open Finding。
6. Task Finding 按根因路由：实现或测试缺陷到 `task.execute`，已批准 Design 不足到 `design.technical`，Task 范围/依赖/白名单问题到 `plan.create`。Delivery 的实现缺陷到 `task.execute` 并走新 Remediation Task，验收资产缺陷到 `acceptance.validate`。
7. 修复轮次使用新 Review Package 固定新 Subject，同时以旧报告的 `subject.head_commit..新 subject.head_commit` 查看 Fix Diff。只复核 Open Finding、Fix Diff 和被修复行为的聚焦证据；修复引入独立新问题时才新增 Finding。新报告携带上一轮全部 Findings，保持 ID 和原始描述，按结果更新状态，再追加新 Finding；`round` 依次为 `0`、`1`、`2`，不得复用旧 Subject 或伪装轮次。
8. Attached 模式把报告写入约定路径，再执行 `rockspec action complete task.review <change-id> --verdict <verdict>` 或 `rockspec action complete delivery.review <change-id> --verdict <verdict>`。文字上的成功声明不能通过 Gate，Engine 会校验 Subject、身份隔离、Strict 来源、Finding 和报告 Hash。

可从 [review.md](assets/review.md) 起草报告。Task 范围读取 [action-task.review.yaml](references/action-task.review.yaml) 和 [role-task-change-reviewer.md](references/role-task-change-reviewer.md)；Delivery 范围读取 [action-delivery.review.yaml](references/action-delivery.review.yaml) 和 [role-delivery-reviewer.md](references/role-delivery-reviewer.md)。

报告固定 Review Subject、Reviewer execution ID、轮次、结论、结构化 Findings、受影响产物，以及下一负责 Skill。
