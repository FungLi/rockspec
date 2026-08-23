---
schema_version: 1
revision_id: "{{revision_id}}"
gate: {{spec_design_implementation}}
round: {{reconciliation_round}}
verdict: {{PASS_CHANGES_REQUIRED_BLOCKED}}
reviewer_execution_id: "{{actual_reviewer_execution_id}}"
classifications: {{exact_revision_classifications}}
authority_delta: {{unchanged_changed_unknown}}
finding_ids: {{exact_trigger_finding_ids}}
subject:
  artifact_hashes: {{exact_package_artifact_hashes}}
  aggregate_hash: "{{exact_package_aggregate_hash}}"
findings: []
---

# 对账评审

- Reconciliation Package：`{{package_path}}`
- Revision Author：`{{author_execution_id}}`
- Authority Baseline：`{{authority_basis_hash}}`

## 对账结论

确认当前产物是否只修复 Package 声明的 Finding，是否完整重放受影响的下游派生内容，以及范围、外部行为、验收标准和已批准决策是否保持不变。

`PASS` 必须使用 `authority_delta: unchanged` 且不得包含 Open Finding。非 `PASS` 必须包含至少一个 Open Finding；无法证明权威边界未改变时使用 `unknown`。

## 证据

{{artifact_comparison_traceability_and_repository_evidence}}
