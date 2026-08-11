---
schema_version: 1
decisions:
  - id: D-001
    requirement_ids: [{{requirement_ids}}]
    scenario_ids: [{{scenario_ids}}]
---

# 技术设计：{{title}}

## 上下文

{{repository_facts_and_constraints}}

## 范围适配与拆分

{{single_change_fit_or_decomposition}}

## 需求覆盖

| Requirement | Scenario | Decision | 公共测试接缝 |
|---|---|---|---|
| {{requirement_id}} | {{scenario_id}} | {{decision_id}} | {{api_ui_cli_or_event}} |

## 决策

### 总体方案比较

| 方案 | 核心思路 | 优点 | 代价与风险 | 结论 |
|---|---|---|---|---|
| A | {{approach_a}} | {{approach_a_benefits}} | {{approach_a_costs}} | `RECOMMENDED` / `REJECTED` |
| B | {{approach_b}} | {{approach_b_benefits}} | {{approach_b_costs}} | `RECOMMENDED` / `REJECTED` |
| C（如适用） | {{approach_c_or_not_applicable}} | {{approach_c_benefits}} | {{approach_c_costs}} | `RECOMMENDED` / `REJECTED` / `NOT_APPLICABLE` |

推荐理由：{{recommendation_and_repository_evidence}}

### D-001 {{decision_title}}

- 覆盖：{{requirement_ids}}
- 决策：{{decision}}
- 备选方案：{{alternatives}}
- 取舍：{{tradeoffs}}
- 仓库证据：{{evidence}}

## 接口与数据流

{{interfaces_and_flow}}

## 失败与边界行为

{{errors_idempotency_concurrency}}

## 安全与隐私

{{security_privacy_or_not_applicable}}

## 兼容、迁移与回滚

{{compatibility_migration_rollback}}

## UI/UX 对账

- 是否要求原型：`{{prototype_required}}`
- 绑定原型：{{prototype_path_and_hash_or_none}}
- 已吸收影响：{{prototype_consequences}}

## 验证策略

{{unit_component_integration_e2e_strategy}}

## 未解决风险

{{unresolved_risks_or_none}}

Frontmatter 是 Engine 的需求覆盖事实源。每个正文 `D-xxx` 决策必须在 `decisions` 中出现；所有已批准 Requirement 和 Scenario 必须至少被一个决策覆盖。
