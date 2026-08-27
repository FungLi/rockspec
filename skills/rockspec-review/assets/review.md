---
schema_version: 1
verdict: {{PASS_CHANGES_REQUIRED_BLOCKED}}
reviewer_execution_id: "{{actual_reviewer_execution_id}}"
subject:
  base_commit: "{{review_package_base_commit}}"
  head_commit: "{{review_package_head_commit}}"
  diff_hash: "{{review_package_diff_hash}}"
round: {{zero_for_initial_review_one_or_two_for_fix_review}}
scope_assessment: []
findings: []
---

# {{review_name}}

- Review Package：`{{review_package_path}}`
- Model Tier：`{{fast_balanced_deep_or_unknown}}`
- 宿主模型：`{{resolved_host_model_or_unknown}}`
- 选择原因：{{model_selection_reasons}}

## 分项结论

| 评审轴 | 结果 | 证据 |
|---|---|---|
| Spec Compliance | {{result}} | {{evidence}} |
| Design Compliance | {{result}} | {{evidence}} |
| Code Standards | {{result}} | {{evidence}} |
| Test Quality | {{result}} | {{evidence}} |

## 评审发现

`PASS` 可以使用 `findings: []`。`CHANGES_REQUIRED` 或 `BLOCKED` 必须把至少一个 Open Finding 写入 Frontmatter；以下是单项结构，不能只写在正文：

```yaml
findings:
  - id: F-001
    severity: important
    category: spec-compliance
    evidence: "{{exact_file_line_artifact_or_observation}}"
    description: "{{problem_required_outcome_and_impact}}"
    owner_domain: implementation
    route_to: task.execute
    status: open
    classification: implementation_fix
    authority_impact: unchanged
```

正文可按 Finding ID 补充解释，但不得与 Frontmatter 冲突。改变既有决策、产品意图或要求接受风险时分别使用 `decision_change`、`intent_change`、`risk_acceptance`，并将 `authority_impact` 设为 `changed` 或 `unknown`。

## 剩余风险

{{residual_risk_or_none}}
