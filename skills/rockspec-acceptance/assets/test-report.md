---
schema_version: 1
verdict: {{PASS_CHANGES_REQUIRED_BLOCKED}}
reviewer_execution_id: "{{actual_acceptance_execution_id}}"
commit: "{{tested_commit_sha}}"
scenario_coverage:
  - scenario_id: S-001
    test_ids: [AT-001]
    evidence_ids: [E-001]
ui_evidence: []
findings: []
---

# 验收测试报告

- 已测试 Commit：`{{commit_sha}}`
- Verdict：`{{PASS_CHANGES_REQUIRED_BLOCKED}}`
- 开始时间：`{{started_at}}`
- 结束时间：`{{finished_at}}`
- Model Tier：`{{fast_balanced_deep_or_unknown}}`
- 宿主模型：`{{resolved_host_model_or_unknown}}`
- 选择原因：{{model_selection_reasons}}

## 结果

| Test ID | 命令 | Exit | Passed | Failed | Skipped | 证据 |
|---|---|---:|---:|---:|---:|---|
| {{test_id}} | `{{command}}` | {{exit_code}} | {{passed}} | {{failed}} | {{skipped}} | {{path}} |

## Scenario 覆盖

{{coverage_summary}}

## 缺陷

`PASS` 使用 `findings: []`。非 `PASS` 必须将 Open Finding 写入 Frontmatter，并包含 `classification` 和 `authority_impact`；实现缺陷使用 `owner_domain: implementation`、`route_to: task.execute`、`classification: implementation_fix`，验收资产或下游派生缺口使用适用责任域、`classification: derived_gap`。只有确认不改变用户批准边界时才使用 `authority_impact: unchanged`；否则使用 `changed|unknown`。只写在正文中的缺陷不能驱动 Recovery。

### 实现缺陷

{{implementation_findings_or_none}}

### 验收资产缺陷

{{test_asset_findings_or_none}}

## UI/UX 证据

{{provider_findings_and_evidence_or_none}}

## 剩余缺口

{{gaps_or_none}}
