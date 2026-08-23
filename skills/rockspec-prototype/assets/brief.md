---
schema_version: 1
inputs:
  spec_hash: "{{approved_spec_hash}}"
  design_hash: "{{design_draft_hash}}"
requirement_ids: [{{requirement_ids}}]
scenario_ids: [{{scenario_ids}}]
decision_ids: [{{decision_ids}}]
---

# 原型 Brief

- Change ID：`{{change_id}}`
- Requirements Hash：`{{requirements_hash}}`
- Design Draft Hash：`{{design_hash}}`
- Capability：`ui.prototype`
- Provider：`{{provider_name}}`
- Provider 来源/版本：{{provider_identity}}

## 产品与用户

{{product_type_users_and_jobs}}

## 页面与流程

{{screen_scope_and_primary_flows}}

## 技术栈与现有系统

{{ui_stack_tokens_components_and_conventions}}

## 体验目标

{{experience_goals}}

## 约束与视口

{{constraints_and_viewports}}

## 假设、问题与非目标

{{assumptions_questions_non_goals}}
