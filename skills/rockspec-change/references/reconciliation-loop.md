# 意图边界与自动对账闭环

本参考定义跨阶段发现遗漏或不一致时，哪些修改可以由 AI 自闭环，哪些必须返回用户。Engine 是分类聚合、审批失效和恢复路由的唯一权威；Skill 不得自行放宽策略。

## 两种 Hash

- **Content Hash**：当前产物逐字节内容的 Hash。任何内容变化都会产生新值，用于防止 Reviewer 或 Approval 复用旧对象。
- **Authority Baseline**：某 Gate 最近一次人工审批时的 Aggregate Hash。它代表用户已经确认的意图或决策边界，不要求修订后的文字与原文相同。

自动对账可以生成新的 Content Hash，但必须证明 Authority Baseline 所代表的范围、外部行为、验收标准和已批准决策均未改变。自动审批只续期被当前 Revision 失效的既有人工 Gate；从未人工批准过的 Gate 不存在可续期的权威基线。

## Finding 分类

| `classification` | 含义 | 默认审批策略 |
|---|---|---|
| `consistency_fix` | 同一事实在上下游产物间遗漏、矛盾或未同步，修复不改变批准含义 | 可自动 |
| `derived_gap` | 已批准内容缺少下游派生细节、追踪映射、Task 或测试覆盖 | 可自动 |
| `implementation_fix` | 实现或测试未满足已批准要求，修复只恢复既定行为 | 可自动 |
| `decision_change` | 需要替换或修改用户已选择的技术、计划或交付决策 | 人工 |
| `intent_change` | 改变范围、非目标、外部可观察行为、兼容性或验收标准 | 人工 |
| `risk_acceptance` | 需要用户接受剩余风险、债务、降级或例外 | 人工 |

每个 Finding 还必须声明 `authority_impact: unchanged|changed|unknown`。`decision_change`、`intent_change` 和 `risk_acceptance` 不得声明 `unchanged`。无法证明边界未变化时使用 `unknown`，不得猜测为 `unchanged`。

## 策略判定

Engine 按失效 Gate 设置 `gate_policies.<gate>: preserve|auto|human`。`preserve` 表示该 Gate 没有失效；只有同时满足下列条件，失效 Gate 才设置为 `auto`：

- 全部 Open Finding 都属于 `consistency_fix`、`derived_gap` 或 `implementation_fix`。
- 全部 Finding 的 `authority_impact` 都是 `unchanged`。
- Revision 绑定真实 Author execution ID。
- 目标 Gate 在本次 Revision 前已有人工 Approval，并被本次 Revision 失效。

以下任一条件立即使用或升级当前责任 Gate 为 `human`：首次 Spec、Design 或 Implementation Approval；`decision_change`、`intent_change`、`risk_acceptance`；`authority_impact` 为 `changed` 或 `unknown`；Reviewer 分歧；独立 Reviewer 判定边界变化；两轮内未收敛。Critical 表示问题在修复前持续阻塞，不等于产品 Authority 已变化；Critical 的内部技术 `consistency_fix|derived_gap|implementation_fix + unchanged` 可在已有人工 Authority Baseline 上自动对账，但 Author 后的独立 Reviewer 必须使用 Deep，并直接证明高风险后置条件和聚焦测试。用户在 Requirements/Design Gate 已确认新的权威边界后，只有派生 Plan 需要续期时，Implementation Gate 使用独立 Reviewer 自动对账，不重复要求用户批准同一决策。

旧报告缺少分类字段时，Protocol 按 `decision_change + unknown` 读取，因此不会被静默自动化。

## 执行闭环

```text
Finding
  -> Engine 聚合分类与 Authority Impact
  -> Revision Author 修复最早责任产物
  -> 重放被失效的下游 Action
  -> 独立 Reviewer 对账当前 Gate
  -> PASS + unchanged: 续期原人工 Gate
  -> 否则: 修复下一轮或升级人工
```

1. 发现问题的 Reviewer 或 Acceptance Agent 在 Frontmatter 写入分类、Authority Impact、责任域和路由。
2. Engine 聚合全部 Open Finding；最保守的 Finding 决定策略，并返回唯一 `recovery` 和下一 Action。
3. 运行 `rockspec recover apply <change-id> --affected <R-/S-/D-id>`；自动对账附带已登记的 `--author-execution`。Engine 在当前状态下绑定 Review Hash、全部 Open Finding、分类、Authority Impact 和最早 target：没有 Open Revision 时创建 `RV-xxx`，已有 Open Revision 时追加 `AM-xxx`。必要时 Revision 总 target 向更上游扩展，但 Amendment 只失效自身 target 对应的 Artifact、Action 和 Gate。不得手工拼 Review/Finding 参数、创建第二个 Revision，或用总 target 重复失效已确认 Gate。
4. 自动 Revision 由其责任 Skill 以 **reconciliation** 模式执行：从磁盘读取 Revision、Finding、旧权威基线和失效范围，只修复已声明影响，不重复逐章节征求用户确认。
5. 若修复过程中发现需要新产品选择、决策替换或风险接受，停止修改，将 Authority Impact 标记为 `changed` 或 `unknown`，升级到人工流程。
6. 每个失效 Gate 的产物和前置 Action 恢复后，调用 `rockspec reconcile prepare <gate> <change-id>` 固定 Revision、Gate、轮次、分类、Finding、当前产物 Hash 与旧 Authority Baseline。
7. 启动不同于 Revision Author 的只读 Reviewer。Reviewer 写入固定报告后，调用 `rockspec reconcile complete <gate> <change-id> --verdict <verdict>`。
8. 只有 `PASS + authority_delta: unchanged` 才自动续期该 Gate。非 PASS 返回责任 Skill 修复；最多两轮。分歧、超时或越界转人工。
9. Engine 按 Spec -> Design -> Implementation 顺序重放所有失效 Gate；Implementation Recovery 关闭前还必须为每个 Suspended Task确定 `resume` 或 `supersede`，并证明当前 Task 图可执行。只有下游产物、Review、Approval 和 Task Graph 全部收敛，Revision 才关闭并恢复原工作。

## 用户负担边界

- **authoring**：首次产出或用户主动改意图。Requirements/Design 只为通过四项 Authority 测试的新选择暂停；章节、普通技术方案和派生内容静默完成并由 Reviewer 核验。每个首次 Gate 仍暂停等待一次正式 Hash Approval。
- **reconciliation**：只恢复已批准意图和决策的一致性。AI 自行修复、复核和续批，不用用户重复确认相同内容；完成后报告变更摘要、证据和续期的 Gate。

自动化不是“AI 代替用户批准”，而是由原人工 Authority Baseline、受限修订范围和独立 Reviewer 共同证明批准内容没有改变。
