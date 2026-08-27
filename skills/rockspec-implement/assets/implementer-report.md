---
schema_version: 1
task_id: {{task_id}}
execution_id: {{implementer_execution_id}}
base_commit: {{task_base_commit}}
brief_path: {{brief_path}}
brief_hash: {{brief_hash}}
outcome: {{implemented_or_blocked}}
# outcome=blocked 时必须填写 blocker；implemented 时删除 blocker
blocker:
  kind: {{contract_conflict_or_authority_conflict}}
  source_refs: [{{conflicting_task_requirement_scenario_decision_or_path_refs}}]
  summary: {{concrete_conflict_summary}}
  recommended_route: {{plan.create_or_requirements.clarify_or_design.technical}}
---

# {{task_id}} 实施报告

- Execution ID：`{{implementer_execution_id}}`
- Base Commit：`{{task_base_commit}}`
- Final Commit：`{{task_head_commit}}`
- Frozen Brief：`{{brief_path}}`
- Brief Hash：`{{brief_hash}}`

## 已实施行为

{{implemented_behavior_and_traceability}}

## 改动文件

{{changed_files_and_responsibilities}}

## 参考范围扩展

{{paths_outside_task_allowed_paths_with_behavioral_justification_or_none}}

逐项说明超出 Task `allowed_paths` 参考范围的路径为何是完成既有验收标准所必需，以及为何没有改变 Task 的行为、接口、依赖或责任边界。没有扩展时填写 `None`。

## TDD 与验证证据

{{red_green_refactor_observations_and_executed_evidence_ids}}

## Diff 摘要

{{final_diff_summary}}

## 风险与阻塞项

{{concerns_residual_risks_or_none}}
