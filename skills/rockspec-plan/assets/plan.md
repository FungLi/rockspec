---
schema_version: 1
verification_only_scenario_ids: [{{scenario_ids_verified_without_product_task}}]
---

# 实施计划：{{title}}

## 目标与方法

{{goal_and_approach}}

## 全局约束

{{versions_dependencies_naming_platform_and_delivery_constraints}}

## 文件职责图

| 路径 | 操作 | 单一职责 | 对应 Task |
|---|---|---|---|
| `{{exact_path}}` | `CREATE` / `MODIFY` / `TEST` | {{responsibility}} | {{task_id}} |

## 覆盖矩阵

| Requirement | Scenario | Design Decision | Task |
|---|---|---|---|
| {{requirement_id}} | {{scenario_id}} | {{design_id}} | {{task_id}} |

## Task 图

```text
{{task_dag}}
```

## 接口与跨 Task 约束

| 生产 Task | `Produces` | 消费 Task | `Consumes` |
|---|---|---|---|
| {{producer_task}} | {{exact_name_signature_and_type}} | {{consumer_task}} | {{exact_name_signature_and_type}} |

## 交付顺序

{{ordered_delivery}}

## 风险与回滚

{{risk_and_rollback}}

## 验证策略

{{verification_strategy}}

Frontmatter 只列不需要产品 Task、将在 Acceptance 中直接验证的 Scenario；没有时使用 `[]`。每个其他 Scenario 必须由至少一个 Task 的 `scenario_ids` 覆盖。
