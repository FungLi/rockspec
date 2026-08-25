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

Attached 分为 **reconciliation**、**decision-free authoring** 和 **decision authoring**。`interaction_mode: reconcile` 或合法 auto Gate 只同步批准决策；首次设计、`interaction_mode: compact|full` 或人工 Design Gate 都不自动产生会话停点。仓库事实和已批准 Requirements 能确定的技术方案由设计者选择并交给 Reviewer；只有真正需要用户 Authority 的开放决策才进入 decision authoring。`interaction_mode: full` 允许开放式探索，但不要求逐章节确认。旧 feedback Revision 缺字段时按 decision-free authoring。

<INTERACTIVE-GATE>
只有开放决策可以形成 authoring 等待点。一个技术问题必须同时满足以下条件才交给用户：存在至少两个合理方案；方案产生不同的外部行为、兼容承诺、重大不可逆架构/迁移承诺、运行成本边界或风险接受；答案无法从已批准 Requirements、仓库规范和相邻实现确定；最终选择需要产品或架构 Authority，而不是普通工程判断。锁、事务隔离、SQL 顺序、Repository 拆分、缓存键、错误映射、测试机制和同等行为下的 API 实现默认由设计者负责。

存在开放决策时，把最多三个相互关联的选择合并为一个 Decision Package，给出推荐、外部影响和取舍，然后结束当前回复等待。关闭决策后不得把范围架构、模块、接口、错误并发、安全迁移、测试和原型拆成章节确认。没有开放决策时可直接写入最终 `design.md`、完成 `design.technical`、启动 Reviewer/Prototype 并进入 Plan。首次 Design 的 Hash Approval 仍是正式治理停点；它不要求预先逐节确认。reconciliation 跳过重复确认，只有真正越过 Authority Baseline 才升级。
</INTERACTIVE-GATE>

## Conversation presentation

- 只有通过四项 Authority 测试的开放决策才提问；优先把相互关联的选择合并成一个 Decision Package。
- 章节是最终产物结构，不是会话停点。展示 Decision Package 或审批摘要时按内容选择最简洁的表达：结论用短文，并列项用列表，比较、规则和映射用表格，简单流程、依赖或状态变化用紧凑 ASCII 图。
- 只有视觉表达明显比文字更容易理解时才使用图；不要为了丰富形式强制添加图表，也不要把结构化内容全部写成连续段落。
- ASCII 图应保持简短；关系复杂或容易产生歧义时，在最终产物中使用 Mermaid，并在审批摘要中说明关键关系。图形表达方式属于设计者责任，不单独请求用户确认。UI 布局和视觉交互交给 `$rockspec-prototype`。
- 对普通工程选择在 Design 中记录推荐、备选和排除依据，不向用户逐项征求偏好；独立 Reviewer 负责验证方案正确性和风险。

## 执行

严格按以下顺序执行：

1. 静默从磁盘重新读取已批准的 Requirements、已有 Design 和适用的 Prototype，再检查仓库规则、受影响模块、相邻实现、公共接口、测试、数据流和交付约束；不要依赖聊天记忆。
2. 判断需求是否包含可独立交付、测试或回滚的多个目标；只有边界会改变发布/回滚单位且仓库事实无法确定时，才把 Change 拆分作为开放决策。不要因模块、文件或 Task 数量增多重新询问。reconciliation 只核对既有范围。
3. 对仍可能改变外部行为、兼容承诺、重大不可逆架构/迁移承诺、运行成本边界或风险接受的事项执行四项 Authority 测试。全部通过时合并进一个 Decision Package 并等待；普通技术选择采用有依据的推荐方案并记录。reconciliation 只有遇到真正 Authority 变化才升级人工。
4. 若仓库事实表明已批准需求成本过高、不可实施或应简化，不得在 Design 中静默改变业务行为，也不得继续 reconciliation。先升级为人工策略，展示变更理由、候选方案、受影响的 R/S/D ID、将失效的 Requirements Review/审批及下游产物，等待用户确认；确认后调用 `rockspec revise --source design.technical --target requirements ...`，交还 `$rockspec-requirements` 从受影响章节开始修订。
5. 对每个重大技术选择在 Design 中比较 2 至 3 个真正不同的方案并给出推荐；只有一个可行方案时记录排除依据。比较方案不等于要求用户选择，只有通过 Authority 测试的差异才进入 Decision Package。反馈已决定的行为和显然的仓库惯例不重新选择；reconciliation 不创造决策。
6. 没有开放决策时，静默完成范围架构、模块边界、接口数据流、错误并发、安全迁移、测试和原型章节。当前 Revision 已确认过的 Authority 决策不得重复确认；reconciliation 以冻结 ID 替代确认。
7. 将当前已批准 Spec Aggregate Hash 写入 `design.md` 的 `inputs.spec_hash`，将最终决策映射到 Requirement ID，并把每个 `D-xxx` 到 R/S ID 的映射写入 YAML Frontmatter；所有已批准 Requirement 和 Scenario 必须至少被一个决策覆盖。
8. 对账 UI 影响。交互、布局、导航、响应式、可访问性行为或视觉系统变化时，在技术设计写入后、Design 最终审批前调用 `$rockspec-prototype`。Prototype 完成后重新进入本 Skill，把原型的技术影响写回 Design，再次提交 `design.technical`；原型产生新的 Authority 选择时形成一个 Decision Package，越过已批准 Requirements 时启动 Revision，其余技术影响直接修订并交给 Reviewer。
9. 重新读取写入磁盘的 Design，检查 `TODO/TBD`、空泛占位、内部矛盾、范围膨胀、多义解释、需求遗漏、Frontmatter/正文不一致和过期仓库证据；发现问题直接修订。只有修订产生新的 Authority 决策时才请求用户，不得重新确认整个章节。
10. Attached 模式提交 `design.technical`；Engine 会校验 `inputs.spec_hash`、结构化决策映射和已批准 Spec 的覆盖。完成必要原型对账并使 Prototype 状态达到 `reconciled` 后，人工策略运行 `rockspec approval package design <change-id>`，展示决策与输入摘要并用返回 Hash 执行 `rockspec approve design <change-id> --package <sha256>`；自动策略交给 `$rockspec-review` 执行 `reconcile.design`，不得再次要求用户批准。

可从 [design.md](assets/design.md) 起草设计。编写或完成受治理 Design 前读取 [action-design.technical.yaml](references/action-design.technical.yaml)。

报告输入来源、仓库证据、决策、未解决风险、原型状态、审批状态，并将 `$rockspec-plan` 作为通常的下一能力。
