---
schema_version: 1
change_id: <change-id>
author_execution_id: <author-execution-id>
outcome: no_change
updates: []
---

# Knowledge Delta

## Assessment

说明本次 Change 是否形成了跨 Change 可复用的稳定知识，以及排除一次性实现细节的依据。

## Proposed Evolution

没有可沉淀内容时说明 `no_change` 原因。有更新时，将 `outcome` 改为 `proposed`，并在 Frontmatter 中为每个候选文件记录：

```yaml
updates:
  - target: experience/form-patterns.md
    operation: refine
    authority: derived
    summary: 统一异步提交表单的状态与反馈模式
    sources:
      - prototype/design-system.md#DS-004
      - design.md#D-007
      - testing/test-report.md#S-012
```

候选文件使用完整目标内容，放在 `knowledge/updates/experience/form-patterns.md`。
