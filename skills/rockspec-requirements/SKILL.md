---
name: rockspec-requirements
description: 用于将想法、Brief、PRD、Issue 或现有需求转为可测试 Spec；创建、细化、导入并评审 Requirement 与 GIVEN/WHEN/THEN Scenario。
---

# RockSpec 需求

只产出一个结果：经过评审、可供用户确认的行为需求基线。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 活动 Change 合法允许 `requirements.clarify`、`requirements.review` 或 `approve.spec` 时使用 **Attached（挂接）** 模式。只写入声明的产物，并通过 CLI 提交结果。
- 用户提供外部 PRD、Issue、Brief 或对话，且没有受治理 Change 时使用 **Standalone（独立）** 模式。保留来源归属，将输出和 `receipt.yaml` 写入 `.rockspec/workbench/requirements/<slug>/`，并设置 `governed_change: false`。

Attached 按 Open Revision 的 `interaction_mode` 选择执行方式，不能再用 `gate_policies.spec: human` 推断交互频率：

- **reconciliation**：`interaction_mode: reconcile`，或非反馈 Revision 对 Spec Gate 明确为 `auto` 且 Authority Impact 为 `unchanged`。只恢复批准语义，不重复询问。
- **compact authoring**：`feedback_reopen + interaction_mode: compact`。反馈可直接转换为 Scenario，不需要新增产品选择；生成一个合并 Delta，只确认一次。
- **full authoring**：首次创建、用户主动修订、`interaction_mode: full`，或出现歧义、竞争方案、范围冲突、兼容性选择或风险接受。执行完整在线澄清和章节确认。

旧 `feedback_reopen` Revision 缺少该字段时按 `compact` 处理。`preserve` 表示无需重做本 Gate。`compact` 和 `full` 都可以要求人工 Hash 审批；人工审批强度不决定交互次数。

<INTERACTIVE-GATE>
full authoring 是在线协作能力。当前问题、业务方案或需求章节尚未确认时，必须结束当前回复并等待；不得写入最终 Proposal、Spec Delta 或 `receipt.yaml`，不得完成 `requirements.clarify`，不得启动 Requirements Reviewer，也不得进入 Design 或其他下一能力。compact authoring 只允许一个确认点：独立 Reviewer PASS 后展示完整合并 Delta；此前不得逐章节询问，确认后进行绑定 Hash 的 Spec Approval。reconciliation 不重复请求批准。任何模式出现必须由用户新增产品选择的歧义时，停止并按 full authoring 处理。
</INTERACTIVE-GATE>

## Conversation presentation

- 调研和澄清时每次只提出一个问题；存在合理选择时提供 1 至 3 个选项、影响和推荐，没有实质差异时不虚构选项。
- full authoring 每次只展示一个章节；展示时按内容选择最简洁的表达：结论用短文，并列项用列表，比较、规则和映射用表格，简单流程、依赖或状态变化用紧凑 ASCII 图。
- 只有视觉表达明显比文字更容易理解时才使用图；不要为了丰富形式强制添加图表，也不要把结构化内容全部写成连续段落。
- ASCII 图应保持简短；关系复杂或容易产生歧义时，先在会话中说明关键关系，经用户同意后再在最终产物中使用 Mermaid。UI 布局和视觉交互交给 `$rockspec-prototype`。
- full authoring 每个章节给出推荐及理由，展示后只确认当前章节。全部章节确认后才整理最终产物，整理时不得引入未经讨论的新决策。
- compact authoring 静默读取 Feedback Batch 和既有基线，合并展示 changed behavior、preserved behavior、Scenario、下游影响和 open questions。只展示 Reviewer PASS 后的完整 Delta 一次，禁止拆成目标、范围、规则、路径、Scenario 等多轮确认。

## 执行

严格按以下顺序执行：

1. 静默从磁盘重新读取 Brief 或外部来源、基线 Spec 和已有需求产物；不要依赖聊天记忆。检查可观察的当前行为和领域术语。
2. 若存在 Open Revision，先读取 `revisions/RV-*.yaml`、关联 Feedback Batch 和保留的旧 Requirements、Design、Prototype、Plan，只处理受影响章节。full authoring 展示拟保留、修改、删除或替代的 R/S ID 及下游影响并逐节确认；compact authoring 静默形成一个 Delta 影响集；reconciliation 按冻结 Finding 和 Authority Baseline 自动恢复一致性。不得为了让 Design 更简单而自行改变产品范围。
3. 识别会实质改变范围、外部行为、兼容性或验收标准的歧义。只有这类歧义才阻塞。full authoring 每条消息只问当前最重要的一个问题，提问后结束当前回复并等待。compact 只有在反馈无法直接转换为 Scenario、必须新增产品选择时才升级 full；不要把实现细节或文件范围当成产品歧义。reconciliation 遇到 Authority 变化则停止自动修复。
4. full authoring 中业务行为存在不同合理选择时，提出 1 至 3 个方案并等待选择。compact 不重新提供反馈已经决定的方案；reconciliation 不提出新业务方案。
5. full authoring 依次展示并确认：目标、范围与非目标；角色、术语与业务规则；正常路径；失败、边界与兼容行为；Scenario 与开放问题。compact 将这些内容合并进单个 Delta，不运行五章节循环；如果当前 Revision 已完成相关章节确认，不得再追加一次 compact 确认。reconciliation 以冻结影响集替代确认。
6. 分离业务行为与实施选择，不得用假设掩盖实质歧义；将开放问题标记为阻塞或非阻塞。full authoring 在章节确认后编写 Proposal 和 Spec Delta；compact 直接起草合并 Delta 供独立 Reviewer 检查。强制使用英文关键字 `ADDED/MODIFIED/REMOVED/RENAMED`、`Requirement`、`Scenario`、`MUST/MUST NOT`、`GIVEN/WHEN/THEN`。
7. 为每个 Requirement 提供至少一个可测试 Scenario，并使用稳定的 `R-`/`S-` ID。语义不变的收窄可以保留 ID；实质改变的旧 ID 使用 `REMOVED`，新行为分配新 ID，已删除 ID 不得复用。重新读取产物并检查其与已确认影响集一致后，Attached 模式提交 `requirements.clarify`。
8. 调度规定数量的独立 Reviewer 前，按 `requirements.review` 的 `model_policy` 从 Brief、Spec 和 Profile 选择 Tier，再由当前 Host Adapter 映射并显式指定模型。不得低于 `minimum` 或静默使用更弱 Tier；Strict 的两个 Reviewer 使用同一 Tier。保持 Reviewer 只读、与作者隔离且不得委派。
9. Reviewer 必须从结构化模板写报告；每个 Finding 包含 `classification` 和 `authority_impact`，非 PASS 必须至少包含一个 Open Finding。格式、ID 或措辞修正可直接修订；实质行为变化回到对应模式。compact 必须在 Reviewer PASS 后一次性展示 reviewed Delta，包含 changed behavior、preserved behavior、Scenario、下游影响和 open questions；用户确认后提交绑定 Hash 的 Spec Approval。已经完成本 Revision 内容确认时跳过这次内容复核，只请求尚未完成的 Hash Approval。reconciliation 由 `$rockspec-review` 执行 `reconcile.spec`，不得再次要求用户批准。Open Revision 只有在全部失效的下游产物、Review 和 Approval 重新完成后才由 Engine 关闭。

可从 [proposal.md](assets/proposal.md)、[spec.md](assets/spec.md) 和 [requirements-review.md](assets/requirements-review.md) 起草产物。对应工作前读取 [action-requirements.clarify.yaml](references/action-requirements.clarify.yaml)、[action-requirements.review.yaml](references/action-requirements.review.yaml) 和 [role-requirements-reviewer.md](references/role-requirements-reviewer.md)。

报告来源、产物、评审结论、审批状态、开放问题，并将 `$rockspec-design` 作为通常的下一能力。
