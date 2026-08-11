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

### 实现缺陷

{{implementation_findings_or_none}}

### 验收资产缺陷

{{test_asset_findings_or_none}}

## UI/UX 证据

{{provider_findings_and_evidence_or_none}}

## 剩余缺口

{{gaps_or_none}}
