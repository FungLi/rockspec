---
name: rockspec-change
description: 用于完整交付、恢复或路由 RockSpec Change；编排分级、需求、设计、计划、实施、评审、验收和收尾。仅需单项能力时改用对应 Skill。
---

# RockSpec Change

只作为薄路由器。不要在本 Skill 内实现 Requirements、Design、Plan、代码、评审、验收或收尾工作。

## CLI 入口

本文的 `rockspec ...` 是逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 路由请求

1. 用户明确请求单项能力时直接调用：
   - 风险或 Profile 选择：`$rockspec-triage`
   - Requirements 或 Spec：`$rockspec-requirements`
   - 技术设计：`$rockspec-design`
   - UI/UX 原型：`$rockspec-prototype`
   - 实施计划或 Readiness：`$rockspec-plan`
   - Task 实施：`$rockspec-implement`
   - 代码、Task 或 Final CR：`$rockspec-review`
   - 验收或 TE：`$rockspec-acceptance`
   - 最终验证、知识演进或归档：`$rockspec-finish` 调度 `$rockspec-evolve` 后继续收尾
   - 并行、隔离、恢复或清理 Worktree：`$rockspec-worktree`
2. 完整或恢复中的受治理 Change 必须使用 `rockspec` CLI。解析 Git 根目录和已注册 Worktree；用户点名的 Change 位于其他 Worktree 时先调用 `$rockspec-worktree` 定位并固定后续 `cwd`，再运行 `rockspec status --change <change-id> --view summary --json`。默认只使用紧凑摘要；需要调度 Task、处理 Recovery 或核对内容新鲜度时分别请求 `--view tasks`、`--view recovery` 或 `--view hashes`，只有诊断 Engine 状态本身时才使用 `--view full`。
3. 没有匹配 Change 时调用 `$rockspec-triage`。Triage 提出不可变的英文 kebab-case Change ID 和 Profile 后，由 `$rockspec-worktree` 选择 current 或隔离 Worktree；调用方只在选定工作区内通过底层 `rockspec new` 创建 Change。用户不手动执行该命令，也不得在新 Worktree 中重新安装 Skill 或执行 `rockspec init`。
4. 每次读取 CLI 返回的 `recommended_next.entry_skill`、`recommended_next.action`、`alternatives`、`blocked_by` 和 `recovery`。存在 `recovery.kind=revision` 时，使用 `rockspec recover apply <change-id> --affected <R-/S-/D-id>`；自动对账时先注册真实 `revision_author` execution 并传入 `--author-execution`。Engine 原子消费当前 `review_id`、全部 `finding_ids`、最早 `target`、分类和 Authority Impact；不得手工重抄这些字段、遗漏 Finding、打开第二个 Revision或降级责任域。只有实施前主动修订才直接调用 `rockspec revise`。通过宿主真实 Skill 机制调用返回的 Skill，禁止凭记忆模拟其他 Skill。
5. 人工验收反馈先分级，再使用 `rockspec feedback submit --interaction <mode>` 形成一个 Feedback Batch；同一验收轮次的相关项合并提交。分级只问：**这些反馈能否在不替用户新增产品选择的前提下，直接转换为可测试 Scenario？** 文件数、反馈项数和改动大小都不参与判断。
   - `reconcile`：只恢复已批准语义的一致性，Authority 不变；绑定真实 Author execution ID，走独立 Reviewer 自动对账。
   - `compact`：反馈明确、有边界、可直接转为 Scenario，但会改变行为；不增加内容确认，独立 Review 后直接进入一次 Hash Approval，仍保留 Prototype、Task Review、Acceptance、Delivery Review 和最终验证。
   - `full`：存在歧义、竞争方案、范围冲突、兼容性选择或风险接受；允许开放式决策探索，但只暂停真正需要用户 Authority 的 Decision Package，不逐章节 authoring。
   已明确陈述且没有开放选择的验收反馈默认使用 `compact`。不得因为 `approval_policy: human` 自动升级为 `full`，也不得重复确认当前 Revision 中用户已经确认过的内容。
6. 默认路由为 `same_change`，由 Engine 在当前 Change 上打开 `feedback_reopen` Revision，保留历史 Task 和 Commit，仅新增修复 Task。只有移除反馈后原 Change 仍可独立验收、发布和回滚时，才展示 `new_change` 建议并等待人工确认。
7. `new_change` 不得自动创建新 Worktree。用户确认后，独立 Worktree 使用 `rockspec new --based-on-change <id> --confirm-boundary`；复用当前 Worktree 必须显式使用 `--based-on-change <id> --reuse-workspace`，且父 Change 已有冻结的 `delivery_head`。
8. 下游能力发现跨阶段问题时，按 [reconciliation-loop.md](references/reconciliation-loop.md) 分类。`consistency_fix|derived_gap|implementation_fix + authority_impact=unchanged` 且已有人工 Authority Baseline 的 Revision 进入自动对账；Finding 严重度决定阻塞强度和验证深度，不单独把技术修复变成产品授权。`decision_change|intent_change|risk_acceptance` 或 `changed|unknown` 才展示原因、方案、受影响 R/S/D ID 和失效范围并等待用户。实施中的 Recovery 必须绑定已提交的 non-PASS Review 和 Open Finding，且包含 Engine 返回的全部 Finding；用户反馈重开不需要伪造 Review Finding，但仍必须经过受影响的 Review、验收和最终验证。不得因文件 Hash 过期直接重新审批。
9. `$rockspec-research`、`$rockspec-requirements` 和 `$rockspec-design` 是在线作者能力。Requirements 和 Design 只有返回尚未关闭的 Decision Package 时才将控制权交还用户；章节、普通工程方案和派生内容不是等待点。没有开放决策时允许当前 Skill 完成产物、Review 准备并重新加载状态，但不得替用户执行正式 Hash Approval。Research 仍按自己的证据探索协议执行。
10. 非交互原子 Skill 返回后重新加载状态。交互 Skill 只有在报告当前模式要求的确认已完成且最终产物或 Action 已完成后才可重载状态。仅当用户要求端到端执行且 Engine 状态允许时继续。
11. 需要分析流程成本或 Runtime 阻塞时运行 `rockspec telemetry report <change-id> --json`。遥测只记录命令类别、耗时、结果码、响应体积和 Change ID，不替代 Event、Review 或 Evidence，也不得据此绕过 Gate。

编排完整 Standard 或 Strict 流程前读取 [change-recipe.yaml](references/change-recipe.yaml)；调度任何 Worker 或 Reviewer 前读取 [orchestration.md](references/orchestration.md)。

## 停止边界

- 首次 Spec、Design 和 Implementation Approval，以及 Engine 对当前 Gate 返回 `gate_policies.<gate>: human` 时必须暂停。`auto` 只能通过独立 Reconciliation Review 续期已失效的既有人工 Gate；`preserve` 不得重复审批。不得再次要求用户批准未改变的意图或决策。
- 在线作者 Skill 只有结构化开放决策和正式 Approval Package 是等待点；章节不得制造等待。用户要求端到端执行不构成对尚未展示 Authority 决策或 Hash Package 的预先确认。
- 遇到 `BLOCKED`、歧义、Provider 不可用或用户要求独立结果时停止。
- 不得因为已有上游文档就静默跳过能力；调用对应原子 Skill，由它选择 Attached 或 Standalone 模式。
- 工作区绑定不匹配、基线验证失败或宿主无法固定 Subagent `cwd` 时停止，不回退到共享目录。
- 同一 Worktree 可以顺序承载多个 Change，但每个 Change 在验证通过时冻结 `delivery_head`。后续 Change 的提交不得改变前一个 Change 的验收、Review、收尾或知识沉淀边界。
- 仅在 `$rockspec-finish` 报告归档完成，或用户明确选择不归档的停止点后结束。

报告当前 Change、模式、已完成能力、产物、阻塞项，以及 Engine 给出的下一 Skill 和 Action。
