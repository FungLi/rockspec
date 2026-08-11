# 业务研究：{{title}}

- 状态：`{{READY_FOR_REQUIREMENTS_MORE_RESEARCH_NEEDED_NO_ACTION_RECOMMENDED_BLOCKED}}`
- 研究时间：{{started_at}} 至 {{finished_at}}
- 证据截止：{{evidence_cutoff}}
- 关联 Change：{{change_id_or_none}}

## 研究问题与决策

- 问题：{{bounded_research_question}}
- 要支持的决策：{{decision_to_inform}}
- 受众：{{decision_audience}}
- 范围：{{scope}}
- 非范围：{{out_of_scope}}
- 停止条件：{{stopping_criteria}}

## 结论摘要

{{decision_relevant_summary}}

## 当前业务现状

### 角色与目标

{{actors_goals_and_jobs}}

### 当前工作流

```text
{{current_workflow}}
```

### 痛点与替代方案

{{pain_frequency_severity_and_workarounds}}

## 领域术语与规则

| 术语/规则 | 定义或行为 | 来源 | 冲突 |
|---|---|---|---|
| {{term_or_rule}} | {{definition_or_behavior}} | {{source_id}} | {{conflict_or_none}} |

## 证据与主张

| ID | 类型 | 主张 | 来源 | 时间/范围 | 置信度 |
|---|---|---|---|---|---|
| C-001 | `FACT` / `USER_REPORT` / `INFERENCE` / `HYPOTHESIS` / `UNKNOWN` | {{claim}} | {{source_ids_or_none}} | {{freshness_and_scope}} | `HIGH` / `MEDIUM` / `LOW` |

## 来源登记

| ID | 来源与所有者 | 路径/URL | 发布/数据时间 | 访问时间 | 限制 |
|---|---|---|---|---|---|
| SRC-001 | {{title_and_owner}} | {{path_or_url}} | {{published_or_window}} | {{accessed_at}} | {{limitations}} |

## 洞察、矛盾与机会

### 洞察

{{evidence_backed_insights}}

### 矛盾

{{source_or_domain_conflicts}}

### 待验证机会

{{opportunities_as_hypotheses_not_requirements}}

## 未知与下一步

| 未知 | 是否阻塞 | 负责人/来源 | 验证方式 |
|---|---|---|---|
| {{unknown}} | {{yes_or_no}} | {{owner_or_source}} | {{validation_method}} |

## 交接建议

- 是否进入 Requirements：{{yes_no_or_later}}
- 建议下一能力：`{{rockspec_requirements_or_research_or_none}}`
- 必须保留的证据边界：{{evidence_constraints}}
