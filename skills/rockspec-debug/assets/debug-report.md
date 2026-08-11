# 调试报告：{{title}}

- 状态：`{{INVESTIGATING_BLOCKED_NOT_REPRODUCED_DIAGNOSED_FIX_VERIFIED}}`
- 调试 Case：`{{debug_case_id}}`
- 关联 Change/Task：{{change_and_task_or_none}}
- 调查时间：{{started_at}} 至 {{finished_at}}

## 症状

- 预期：{{expected_behavior}}
- 实际：{{actual_behavior}}
- 影响：{{impact}}
- 环境与版本：{{environment_and_version}}
- 频率：{{frequency}}

## 反馈环

- 命令：`{{exact_command}}`
- 目标信号：{{exact_symptom_assertion}}
- 实际结果：{{observed_result}}
- 稳定性与耗时：{{reliability_and_duration}}

## 最小复现

{{minimal_reproduction_and_load_bearing_inputs}}

## 证据

| ID | 观察 | 来源 | 支持/反对 |
|---|---|---|---|
| E-001 | {{observation}} | {{file_log_trace_command_or_url}} | {{hypothesis_ids}} |

## 假设

| 排名 | 假设 | 可证伪预测 | 实验 | 结论 |
|---:|---|---|---|---|
| 1 | {{hypothesis}} | {{prediction}} | {{probe_and_result}} | `CONFIRMED` / `REJECTED` / `OPEN` |

## 根因链

```text
{{trigger_to_root_cause_to_symptom}}
```

{{root_cause_explanation_or_not_confirmed}}

## 修复与验证契约

- 根因所有者：{{owner}}
- 建议结果：{{required_outcome_without_guess_patch}}
- 回归测试接缝：{{regression_test_seam}}
- 原始反馈环：`{{full_repro_command}}`
- 路由：`{{next_skill_or_blocked}}`

## 清理

- 临时探针：{{removed_or_remaining}}
- 脱敏检查：{{redaction_result}}
- 剩余风险：{{residual_risks}}
