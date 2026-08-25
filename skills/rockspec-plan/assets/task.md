---
schema_version: 1
id: {{task_id}}
title: "{{task_title}}"
dependencies: [{{task_dependency_ids}}]
supersedes: [{{suspended_task_ids_replaced_or_empty}}]
requirement_ids: [{{requirement_ids}}]
scenario_ids: [{{scenario_ids}}]
decision_ids: [{{decision_ids}}]
finding_ids: [{{remediation_finding_ids_or_empty}}]
acceptance_criteria:
  - "{{machine_checkable_acceptance_criterion}}"
consumes: [{{exact_contracts_consumed_from_dependency_tasks}}]
produces: [{{exact_contracts_produced_for_downstream_tasks}}]
allowed_paths:
  - {{repository_relative_product_path}}
---

# {{task_id}}：{{task_title}}

## 目标

{{objective}}

## 追踪关系

- Requirements：{{requirement_ids}}
- Scenarios：{{scenario_ids}}
- Recovery Findings：{{remediation_finding_ids_or_none}}
- Design Decisions：{{design_ids}}
- 依赖：{{task_dependencies_or_none}}
- 替代冻结 Task：{{superseded_task_ids_or_none}}

## 环境与前置条件

{{environment_and_prerequisites}}

## 文件范围

| 操作 | 准确路径 | 责任 |
|---|---|---|
| `CREATE` / `MODIFY` / `TEST` | `{{exact_path}}` | {{responsibility}} |

Frontmatter 的 `allowed_paths` 是计划阶段预计创建、修改或测试的项目相对产品路径，供 Implementer 定位、供 Review Package 展示实际偏差，不是 Engine 的产品 Diff 白名单。尽可能准确填写，但实施中为完成既有 Task 行为而产生的合理路径扩展不要求修订 Plan。不得使用绝对路径、`..`、反斜杠或 `.rockspec/**`；工作流产物不进入该范围。

Frontmatter 的 `acceptance_criteria` 必须逐项表达可观察结果。`consumes`/`produces` 使用完全一致的接口名称、签名和类型字符串；没有接口依赖时使用 `[]`。每个 `consumes` 必须由当前 Task 的直接或传递依赖唯一 `produces`。

普通 Task 使用 `supersedes: []` 和 `finding_ids: []`。Recovery Plan 新增的 Replacement/Remediation Task 必须列出其负责关闭的触发 Finding ID；新增 `supersedes` 只指向不再恢复的 Suspended Task，且该旧 Task 不得同时出现在 `dependencies`。后续 feedback reopen 或 Recovery 必须保留已完成 Task 的历史 `supersedes` 原样，不得把它当成新的 Replacement。不得把 Finding 追加到历史 Task。

## 接口契约

- `Consumes`：{{exact_inputs_names_signatures_and_types_or_none}}
- `Produces`：{{exact_outputs_names_signatures_and_types_or_none}}

## 非目标与禁止改动

{{non_goals_and_forbidden_scope}}

## 已批准 UI/UX 上下文

- Design System：{{design_system_path_and_hash_or_none}}
- Prototype：{{prototype_path_and_hash_or_none}}

## 验收标准

{{acceptance_criteria}}

## TDD 与验证

1. 失败测试：{{failing_test_behavior_and_location}}
   - 命令：`{{exact_failing_test_command}}`
   - 预期：{{expected_failure_observation}}
2. 最小实现：{{minimal_implementation_boundary}}
3. 通过测试：
   - 命令：`{{exact_passing_test_command}}`
   - 预期：{{expected_success_observation}}
4. Task 回归：
   - 命令：`{{exact_task_regression_command}}`
   - 预期：{{expected_regression_result}}

## 完成契约

- 只产出一个最终 Commit，提交信息包含 `{{task_id}}`。
- 记录文件、测试、命令、退出码、结果数量和 Commit SHA。
- 不得写入工作流状态或声明 Task Gate 已通过。
