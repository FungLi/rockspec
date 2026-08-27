---
name: rockspec-requirements
description: 用于将想法、Brief、PRD、Issue 或现有需求转为可测试 Spec；创建、细化、导入并评审 Requirement 与 GIVEN/WHEN/THEN Scenario。
---

# RockSpec 需求

## 产物语言

读取 `.rockspec/config.yaml` 的 `artifact_language`；缺省按 `zh-CN`。Proposal、Spec 的人类可读内容、Review 和终端摘要使用配置语言；Schema Key、R/S ID、CLI/Action、Verdict 以及 `Requirement`、`Scenario`、`MUST`、`GIVEN/WHEN/THEN` 保持英文。

只产出一个结果：经过评审、可供用户确认的行为需求基线。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- 活动 Change 合法允许 `requirements.clarify`、`requirements.review` 或 `approve.spec` 时使用 **Attached（挂接）** 模式。只写入声明的产物，并通过 CLI 提交结果。
- 用户提供外部 PRD、Issue、Brief 或对话，且没有受治理 Change 时使用 **Standalone（独立）** 模式。保留来源归属，将输出和 `receipt.yaml` 写入 `.rockspec/workbench/requirements/<slug>/`，并设置 `governed_change: false`。

Attached 按 Authority 和开放决策选择执行方式，不能用“首次创建”、章节数量或 `gate_policies.spec: human` 推断交互频率：

- **reconciliation**：`interaction_mode: reconcile`，或非反馈 Revision 对 Spec Gate 明确为 `auto` 且 Authority Impact 为 `unchanged`。只恢复批准语义，不重复询问。
- **decision-free authoring**：首次创建、用户主动修订或 `interaction_mode: compact|full` 均可进入；当输入能直接转换为可测试行为且没有开放产品选择时，静默完成全部章节、Review 和审批包准备。
- **decision authoring**：只有存在真正开放的产品选择时进入。`interaction_mode: full` 允许开放式探索，但不要求逐章节确认；决策关闭后立即回到 decision-free authoring。

旧 `feedback_reopen` Revision 缺少 `interaction_mode` 时按 decision-free authoring 处理。`preserve` 表示无需重做本 Gate。人工审批强度不决定交互次数。

<INTERACTIVE-GATE>
只有开放决策可以形成 authoring 等待点。一个问题必须同时满足以下条件才需要用户回答：存在至少两个合理方案；方案产生不同的范围、外部行为、数据损失、兼容性、验收标准或风险接受；答案无法从用户已表达意图、既有产品规则和仓库事实确定；最终选择属于产品 Authority 而非工程实现责任。缺少任一条件都由作者采用有依据的方案、写入产物并交给 Reviewer 核验。没有新的产品选择，就不得产生新的确认停点。

存在开放决策时，把最多三个相互关联的决策合并成一个 Decision Package，逐项展示决策问题、候选方案、推荐及理由、业务与兼容影响、重要风险以及不选择的后果，使用户能在会话区完成核心判断，然后结束当前回复等待。可以按内容调整表达，缺少某个展示项不得形成新的格式 Gate。用户回答后只更新受影响决策；不得再把目标、范围、规则、正常路径、失败行为和 Scenario 拆成章节确认。没有开放决策时可以直接写入最终 Proposal、Spec Delta 或 `receipt.yaml`、完成 `requirements.clarify` 并启动 Reviewer。Reviewer PASS 后，人工 Spec Hash Approval 是正式治理停点；它不得再叠加一次 reviewed Delta 内容确认。reconciliation 不重复请求批准。
</INTERACTIVE-GATE>

## Conversation presentation

- 只有通过四项 Authority 测试的开放决策才提问；优先合并相互关联的决策，避免让用户逐条机械确认。
- 章节是最终产物结构，不是会话停点。展示 Decision Package 或审批摘要时按内容选择最简洁的表达：结论用短文，并列项用列表，比较、规则和映射用表格，简单流程、依赖或状态变化用紧凑 ASCII 图。
- 只有视觉表达明显比文字更容易理解时才使用图；不要为了丰富形式强制添加图表，也不要把结构化内容全部写成连续段落。
- ASCII 图应保持简短；关系复杂或容易产生歧义时，在最终产物中使用 Mermaid，并在审批摘要中说明关键关系。图形表达方式属于作者责任，不单独请求用户确认。UI 布局和视觉交互交给 `$rockspec-prototype`。
- 不在会话中朗读已能从决定推导的目标、角色、正常路径、错误、Scenario 或测试细节；这些内容完整写入产物并由 Reviewer 检查。
- 用户已经明确表达的选择直接形成 Authority 输入，不得换一种措辞再次请求确认；最终 Hash Approval Package 一次性展示 changed behavior、preserved behavior、非目标、假设、开放问题和追踪摘要。

## 执行

严格按以下顺序执行：

1. 静默从磁盘重新读取 Brief 或外部来源、基线 Spec 和已有需求产物；不要依赖聊天记忆。检查可观察的当前行为和领域术语。
2. 若存在 Open Revision，先读取 `revisions/RV-*.yaml`、关联 Feedback Batch 和保留的旧 Requirements、Design、Prototype、Plan，只处理受影响内容。decision authoring 只展示真正开放的选择；decision-free authoring 静默形成 Delta 影响集；reconciliation 按冻结 Finding 和 Authority Baseline 自动恢复一致性。不得为了让 Design 更简单而自行改变产品范围。
3. 识别会实质改变范围、外部行为、数据损失、兼容性、验收标准或风险接受的歧义，并逐项执行四项 Authority 测试。只有全部通过才阻塞；合并为一个 Decision Package 后结束当前回复等待。不要把文件范围、API 形态、锁、事务隔离、SQL 顺序、类/函数拆分、测试方式或其他实施细节当成产品歧义。reconciliation 遇到真正 Authority 变化才停止自动修复。
4. 没有开放决策时，直接编写完整的目标、范围与非目标、角色与业务规则、正常路径、失败/边界/兼容行为、Scenario 和开放问题，不运行章节确认循环。当前 Revision 已确认过的产品选择不得重复询问。
5. 分离业务后置条件与实施机制。用户的“简单处理”“一起删除”等目的性表达应转换为可观察结果，不得被扩写为“禁止增加锁层级”“必须使用某个 API/表/算法”等未授权实施禁令。破坏性聚合删除场景必须读取 [aggregate-root-deletion.md](references/aggregate-root-deletion.md)，只让用户决定归属、保留、不可逆性和可观察结果。
6. 将开放问题标记为阻塞或非阻塞；次要细节使用有依据的保守假设。强制使用英文关键字 `ADDED/MODIFIED/REMOVED/RENAMED`、`Requirement`、`Scenario`、`MUST/MUST NOT`、`GIVEN/WHEN/THEN`。
7. 为每个 Requirement 提供至少一个可测试 Scenario，并使用稳定的 `R-`/`S-` ID。下游按 R/S ID 投影：Requirement 级规则必须写在首个 Scenario 之前；每个 Scenario 必须自包含自己的前置条件、动作、结果和局部补充，不得依赖相邻 Scenario 或完整 Spec 的隐式语境。语义不变的收窄可以保留 ID；实质改变的旧 ID 使用 `REMOVED`，新行为分配新 ID，已删除 ID 不得复用。重新读取产物并检查其与已确认影响集一致后，先对 `proposal.md` 和每个 `specs/*.md` 运行 `rockspec validate <change-id> --artifact <path>` dry-run，修正结构错误后再提交 `requirements.clarify`。
8. 调度规定数量的独立 Reviewer 前，按 `requirements.review` 的 `model_policy` 从 Brief、Spec 和 Profile 选择 Tier；每个 Reviewer 先执行 `rockspec execution start requirements.review --role requirements_reviewer --model-tier <tier> --host-model <model> --context-package <path> --context-hash <sha256>`，并把返回 ID 写入自己的报告。Context Package 只包含本次 Requirements 输入、相关仓库证据和待审 Delta，不继承完整父会话或其他 Reviewer 结论。Reviewer 返回并写完报告后立即执行 `rockspec execution complete <id> <change-id> --outcome <outcome>`，有 Host Adapter 回执时附带 Token 用量。不得低于 `minimum` 或静默使用更弱 Tier；Strict 的两个 Reviewer 使用同一 Tier。保持 Reviewer 只读、与作者隔离且不得委派。
9. Reviewer 必须从结构化模板写报告；每个 Finding 包含 `classification` 和 `authority_impact`，非 PASS 必须至少包含一个 Open Finding。格式、ID、措辞、追踪或不改变业务后置条件的派生修正可直接修订。人工审批先运行 `rockspec approval package spec <change-id>`，以 CLI 按 `artifact_language` 返回的需求摘要（默认中文）为事实来源，在会话区展示审阅问题、目标与变更范围、关键 Requirement/Scenario、假设风险和待确认事项；不得只报告文档已生成。允许合并重复项或调整表达，摘要不完整不得阻断流程。正式材料只展示一次 `artifact_root`，Proposal、Spec、Requirements Review 分别按编号列出名称、相对路径和用途，不得把路径重新拼成一行。用户需要细查时直接阅读这些正式产物，不创建或展示二次 Preview 文档。用户回复“批准需求”或等价明确表达后，Agent 在内部使用返回 Hash 执行 `rockspec approve spec <change-id> --package <sha256>`，不得要求用户理解、复制或复述 Hash。不得在 Hash Approval 前再增加 reviewed Delta 确认。reconciliation 由 `$rockspec-review` 执行 `reconcile.spec`，不得再次要求用户批准。Open Revision 只有在全部失效的下游产物、Review 和 Approval 重新完成后才由 Engine 关闭。

可从 [proposal.md](assets/proposal.md)、[spec.md](assets/spec.md) 和 [requirements-review.md](assets/requirements-review.md) 起草产物。对应工作前读取 [action-requirements.clarify.yaml](references/action-requirements.clarify.yaml)、[action-requirements.review.yaml](references/action-requirements.review.yaml) 和 [role-requirements-reviewer.md](references/role-requirements-reviewer.md)。

报告来源、产物、评审结论、审批状态、开放问题，并将 `$rockspec-design` 作为通常的下一能力。
