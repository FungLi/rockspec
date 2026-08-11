# RockSpec 真实项目校准协议

本协议用于判断 Lite、Standard、Strict 的实际成本和各 Gate 的边际收益。它只定义数据采集和裁剪规则；在真实 Change 数量不足前，不给出流程优劣结论。

## 样本要求

- 第一轮至少完成 3 至 5 个真实 Change，至少包含一个 Lite、两个 Standard，以及一个跨模块或 UI Change。
- 只统计已归档或明确终止的 Change，不使用为评测虚构的顺利样例替代真实交付。
- 每轮校准记录 RockSpec 版本、宿主、仓库类型和模型映射，避免跨版本数据直接混算。
- 产物中不得记录凭据、客户数据、完整 Prompt 或不必要的源代码。

## 数据来源

优先从 `.rockspec/archive/**` 的 `change.yaml`、`events.ndjson`、Review Frontmatter、Task Record 和 Evidence 元数据确定性提取；暂时无法自动取得的时间等待、人工批准等待和逃逸缺陷由维护者补充，但必须标记为人工数据。

每个 Change 至少记录：

| 字段 | 定义 |
|---|---|
| `profile` | 最终 Profile，以及是否由 Lite 升级 |
| `actions` | 完成和重做的 Action 数量 |
| `agent_dispatches` | 按 Action、角色和模型 Tier 统计的 Agent 调度次数 |
| `review_verdicts` | 每个 Gate 的 PASS、CHANGES_REQUIRED、BLOCKED 数量 |
| `repair_rounds` | Task、Acceptance、Delivery 各自触发的修复轮次 |
| `task_count` | 普通 Task 和 Remediation Task 数量 |
| `elapsed_time` | Change 总时长、Agent 执行时长、人工等待时长和验证时长 |
| `model_tier` | 每次 Subagent 调度实际选择的 fast、balanced、deep 及宿主模型 |
| `findings` | Finding severity、category、owner_domain、route_to 和最终状态 |
| `escaped_defects` | Archive 后确认与该 Change 相关的缺陷数及严重度 |

## Gate 收益判断

对 Requirements Review、Readiness Review、Task Review、Acceptance 和 Delivery Review 分别计算：

- 非 PASS 率：`(CHANGES_REQUIRED + BLOCKED) / 总评审次数`。
- 有效 Finding 率：最终被确认且导致产物或代码变化的 Finding 数 / 全部 Finding 数。
- 独占发现率：只由当前 Gate 首次发现的问题数 / 当前 Gate 有效 Finding 数。
- 平均修复轮次和从发现到关闭的耗时。
- 逃逸率：本应由该 Gate 捕获、却在下游或归档后才发现的问题数。

某 Gate “很少驳回”不能单独证明它无价值；还要结合风险预防、独占发现和逃逸情况判断。

## Profile 裁剪规则

完成第一轮 3 至 5 个真实 Change 后只提出候选调整，不立即删除 Gate。满足以下条件时，才进入下一轮对照验证：

1. 某 Gate 连续两个校准窗口独占发现率接近零。
2. 将它下放为 Strict-only 后，Standard 的下游修复率和逃逸缺陷没有上升。
3. 它承担的确定性检查已经被 Engine Gate 覆盖，而不是简单丢弃保护。
4. 调整仍保留风险触发后的 Profile 向上升级路径。

候选调整先记录为版本化决策，在下一批真实 Change 中对照；未经数据支持，不把当前 Standard 当成终态，也不为了缩短耗时直接绕过审批、Evidence 或 Final CR。

## 输出

每轮生成一份不含敏感数据的校准报告，至少包含样本表、各 Gate 指标、异常样本解释、候选调整和下一轮验证假设。报告属于 RockSpec 工程演进资料，不写入用户项目的 Active Change。
