---
name: rockspec-design
description: 用于技术架构、实施设计或从既有 PRD/Spec 开始；基于已批准 Requirements 和仓库事实产出或修订技术设计。
---

# RockSpec 设计

只产出一个结果：与明确需求输入绑定、可检查的技术设计。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 仅当 Change 合法允许 `design.technical` 或 `approve.design`，且 Spec 审批仍有效时使用 **Attached（挂接）** 模式。
- 从外部 PRD、Spec、Issue 或对话直接开始时使用 **Standalone（独立）** 模式。保存输入来源快照，将 `design.md` 和 `receipt.yaml` 写入 `.rockspec/workbench/design/<slug>/`；不得声称获得 RockSpec 审批。

Attached 分为 **reconciliation**、**compact authoring** 和 **full authoring**。`feedback_reopen + interaction_mode: compact` 使用 compact：把变化决策、保留决策、R/S/D 映射、风险和测试影响合并成一个技术检查点，不逐章节确认；只有确实需要新的技术选择时才提问。`interaction_mode: full`、首次设计或存在竞争方案/风险接受时使用 full。`interaction_mode: reconcile` 或合法 auto Gate 只同步批准决策。旧 feedback Revision 缺字段时按 compact；`gate_policies.design: human` 只决定审批，不决定交互次数。

<INTERACTIVE-GATE>
full authoring 中当前问题、技术方案或设计章节尚未确认时必须结束当前回复并等待；不得写入最终 `design.md` 或 `receipt.yaml`，不得完成 `design.technical`，不得启动 Reviewer 或 Prototype，也不得进入 Plan 或其他下一能力。compact authoring 不运行章节循环；没有新技术选择时静默完成对账，只展示一次合并技术 Delta 或直接进入绑定 Hash 的 Design Approval。章节/Delta 确认都不替代 Hash Approval。reconciliation 跳过重复确认；一旦需要新决策或越过冻结影响集立即升级。
</INTERACTIVE-GATE>

## Conversation presentation

- 调研和澄清时每次只提出一个问题；存在合理选择时提供 1 至 3 个选项、影响和推荐，没有实质差异时不虚构选项。
- full authoring 每次只展示一个章节；展示时按内容选择最简洁的表达：结论用短文，并列项用列表，比较、规则和映射用表格，简单流程、依赖或状态变化用紧凑 ASCII 图。
- 只有视觉表达明显比文字更容易理解时才使用图；不要为了丰富形式强制添加图表，也不要把结构化内容全部写成连续段落。
- ASCII 图应保持简短；关系复杂或容易产生歧义时，先在会话中说明关键关系，经用户同意后再在最终产物中使用 Mermaid。UI 布局和视觉交互交给 `$rockspec-prototype`。
- full authoring 每个章节给出推荐及理由，展示后只确认当前章节。compact 将受影响内容合并成一次检查点，不得按组件、接口、错误、安全、测试等章节重复询问。

## 执行

严格按以下顺序执行：

1. 静默从磁盘重新读取已批准的 Requirements、已有 Design 和适用的 Prototype，再检查仓库规则、受影响模块、相邻实现、公共接口、测试、数据流和交付约束；不要依赖聊天记忆。
2. full authoring 先与用户确认范围。若需求包含可独立交付、测试或回滚的多个子系统，提出拆成多个 Change 的边界和顺序。compact 采用 Feedback Batch 已确认范围，不因涉及模块或文件增多重新询问；只有出现真正独立目标时升级。reconciliation 只核对既有范围。
3. authoring 澄清目的、约束和成功标准中仍会改变技术边界的事项。需要用户输入时，每条消息只问一个最重要的问题，提问后结束回复并等待；不影响决策的细节采用最保守方案并记录。reconciliation 遇到仍需选择的技术边界时升级人工。
4. 若仓库事实表明已批准需求成本过高、不可实施或应简化，不得在 Design 中静默改变业务行为，也不得继续 reconciliation。先升级为人工策略，展示变更理由、候选方案、受影响的 R/S/D ID、将失效的 Requirements Review/审批及下游产物，等待用户确认；确认后调用 `rockspec revise --source design.technical --target requirements ...`，交还 `$rockspec-requirements` 从受影响章节开始修订。
5. full authoring 对每个重大技术选择提出 2 至 3 个真正不同的方案并等待选择。compact 只在实现确有多个会改变边界、兼容性或风险的方案时提出一个集中问题；反馈已决定的行为和显然的仓库惯例不重新选择。reconciliation 不创造决策。
6. full authoring 依次确认范围架构、模块边界、接口数据流、错误并发、安全迁移和测试原型。compact 将变化决策、保留决策、R/S/D 映射、下游影响和风险合并为一个检查点；当前 Revision 已确认过的内容不得重复确认。reconciliation 以冻结 ID 替代确认。
7. 只有全部章节确认后，才将当前已批准 Spec Aggregate Hash 写入 `design.md` 的 `inputs.spec_hash`，将最终决策映射到 Requirement ID，并把每个 `D-xxx` 到 R/S ID 的映射写入 YAML Frontmatter；所有已批准 Requirement 和 Scenario 必须至少被一个决策覆盖。
8. 对账 UI 影响。交互、布局、导航、响应式、可访问性行为或视觉系统变化时，在已确认的技术设计写入后、Design 最终审批前调用 `$rockspec-prototype`。Prototype 完成后重新进入本 Skill，把原型的技术影响写回 Design，再次提交 `design.technical`；原型导致实质技术或业务变化时重新打开受影响章节确认或启动 Revision。
9. 重新读取写入磁盘的 Design，检查 `TODO/TBD`、空泛占位、内部矛盾、范围膨胀、多义解释、需求遗漏、Frontmatter/正文不一致和过期仓库证据；发现问题直接修订，实质改变已确认决策时重新请求该章节确认。
10. Attached 模式提交 `design.technical`；Engine 会校验 `inputs.spec_hash`、结构化决策映射和已批准 Spec 的覆盖。完成必要原型对账并使 Prototype 状态达到 `reconciled` 后，authoring 或人工策略为绑定 Hash 的 Design 审批暂停；自动策略交给 `$rockspec-review` 执行 `reconcile.design`，不得再次要求用户批准。

可从 [design.md](assets/design.md) 起草设计。编写或完成受治理 Design 前读取 [action-design.technical.yaml](references/action-design.technical.yaml)。

报告输入来源、仓库证据、决策、未解决风险、原型状态、审批状态，并将 `$rockspec-plan` 作为通常的下一能力。
