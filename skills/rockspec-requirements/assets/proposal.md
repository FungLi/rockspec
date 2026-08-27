---
schema_version: 1
non_goals:
  - "{{non_goal_or_remove_item}}"
assumptions:
  - id: A-001
    description: "{{assumption}}"
    basis: "{{basis}}"
    impact_if_wrong: "{{impact_if_wrong}}"
open_questions:
  - id: Q-001
    question: "{{question}}"
    impact: "{{scope_behavior_compatibility_or_acceptance_impact}}"
    status: resolved
---

# 需求提案：{{title}}

## 原因与价值

{{problem_and_value}}

## 行为变化

{{behavioral_change_summary}}

## 范围

{{scope}}

## 非目标

{{non_goals}}

## 假设

| ID | 假设 | 依据 | 假设错误时的影响 |
|---|---|---|---|
| A-001 | {{assumption}} | {{basis}} | {{impact_if_wrong}} |

## 开放问题

| ID | 问题 | 实质影响 | 状态 |
|---|---|---|---|
| Q-001 | {{question_or_none}} | {{scope_behavior_compatibility_or_acceptance_impact}} | `BLOCKING` / `NON_BLOCKING` / `RESOLVED` |

## 影响

{{users_systems_and_compatibility}}
