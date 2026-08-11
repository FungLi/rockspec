---
name: rockspec-design
description: 根据已批准的 RockSpec Requirements 或现有外部 PRD/Spec 产出或修订技术设计，并以当前仓库事实为依据。用户需要技术架构、实施设计、希望从现有需求直接开始，或 Engine 推荐 design.technical 或 Design 审批时使用。
---

# RockSpec 设计

只产出一个结果：与明确需求输入绑定、可检查的技术设计。

## 选择模式

- 仅当 Change 合法允许 `design.technical` 或 `approve.design`，且 Spec 审批仍有效时使用 **Attached（挂接）** 模式。
- 从外部 PRD、Spec、Issue 或对话直接开始时使用 **Standalone（独立）** 模式。保存输入来源快照，将 `design.md` 和 `receipt.yaml` 写入 `.rockspec/workbench/design/<slug>/`；不得声称获得 RockSpec 审批。

## 执行

1. 从磁盘重新读取已批准的 Requirements、已有 Design 和适用的 Prototype，再检查仓库规则、受影响模块、相邻实现、公共接口、测试、数据流和交付约束；不要依赖聊天记忆。
2. 先检查范围。若需求包含可独立交付、测试或回滚的多个子系统，先提出拆成多个 Change 的边界和顺序，不要继续深化一个混合 Design。
3. 澄清目的、约束和成功标准中仍会改变技术边界的事项。需要用户输入时，每条消息只问一个最重要的问题；不影响决策的细节采用最保守方案并记录。
4. 对每个重大技术选择提出 2 至 3 个真正不同的方案，先给出推荐方案，再说明取舍和仓库证据。若客观上只有一个可行方案，明确写出排除其他方案的约束，不虚构选项。
5. 按复杂度分段展示架构、组件边界、接口与数据流、失败处理和验证策略，并在继续前获得用户确认。可合并简单且关联的部分；分段确认只用于协作收敛，不替代正式 Design Approval。
6. 将最终决策映射到 Requirement ID 或明确引用的外部需求，并把每个 `D-xxx` 到 R/S ID 的映射写入 `design.md` YAML Frontmatter；所有已批准 Requirement 和 Scenario 必须至少被一个决策覆盖。按风险覆盖接口、数据流、错误、兼容性、迁移、安全、回滚、可观测性和测试接缝。
7. 对账 UI 影响。交互、布局、导航、响应式、可访问性行为或视觉系统变化时，在技术草稿后、Design 最终审批前调用 `$rockspec-prototype`，再把原型结论写回 Design。
8. 重新读取写入磁盘的 Design，检查 `TODO/TBD`、空泛占位、内部矛盾、范围膨胀、多义解释、需求遗漏、Frontmatter/正文不一致和过期仓库证据；发现问题直接修订。
9. Attached 模式提交 `design.technical`；Engine 会把结构化决策映射与已批准 Spec 做覆盖比对。完成必要原型对账后，为绑定 Hash 的 Design 审批暂停。

可从 [design.md](assets/design.md) 起草设计。编写或完成受治理 Design 前读取 [action-design.technical.yaml](references/action-design.technical.yaml)。

报告输入来源、仓库证据、决策、未解决风险、原型状态、审批状态，并将 `$rockspec-plan` 作为通常的下一能力。
