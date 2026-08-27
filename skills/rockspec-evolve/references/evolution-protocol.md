# Knowledge Evolution Protocol

## 基线与目标

`.rockspec/specs/**` 保存规范性产品行为。可复用背景和规则只进入以下目标：

- `product/**`：术语、领域模型、能力地图和业务背景，不复制 Spec 场景。
- `architecture/**`：稳定服务边界、接口语义、技术原则和 ADR。
- `experience/**`：设计令牌、公共组件规则、交互模式、无障碍和响应式规则。

目标必须是这些目录下的 Markdown 文件。仅在真实内容出现时创建文件，不预建空目录或百科骨架。

## Delta 与候选

Change 只包含一个 `knowledge-delta.md`。Frontmatter 的 `outcome` 为：

- `no_change`：`updates` 必须为空；仍然完成 Action 并生成凭证。
- `proposed`：至少一个 Update，并为每个 `target` 提供 `knowledge/updates/<target>` 完整候选文件。

Update 的 `operation` 为 `new`、`refine` 或 `supersede`。`authority` 为：

- `derived`：整理、索引或从既有权威产物直接推导，不改变公共规则。由 Author 内联自检，Engine 确定性核验来源、目标、操作和 Hash，不启动独立 Reviewer。
- `normative`：新增或改变后续 Change 应遵守的产品语境、架构原则或体验规则，必须在 Delta 中记录 `approval.approved_by` 和 `approval.approved_at`。

每个 Update 必须引用具体 Change 产物和稳定 ID；仅有抽象总结、未来设想或单次实现偏好时选择 `no_change`。

## 条件式 Review

写完 Delta 和候选后运行：

```text
rockspec --json knowledge package <change-id>
```

全部更新均为 `derived` 时，Package 返回 `review_required: false`，不生成 `reviews/knowledge-review.md`；Author 在 Delta 正文记录直接推导、排除一次性偏好、不改变公共规则和不与基线竞争的自检结论。Engine 检查引用的 Change 产物存在、候选与目标完全匹配、操作符合基线状态、文件非空并固定全部 Hash。

包含任一 `normative` 更新时，Package 返回 `review_required: true`。把输出的 `source_digest`、`delta_hash`、`baseline_hashes` 和 `candidate_hashes` 原样写入 `reviews/knowledge-review.md`。Reviewer 必须使用不同 execution ID，只能编辑自己的报告。非 PASS 必须提供 Open Finding，`owner_domain: workflow`、`route_to: knowledge.evolve`。

## 幂等与对账

Engine 使用最终 Commit 和已验证 Change 产物计算 Source Digest，并维护：

- Change 凭证：`knowledge-evolution.yaml`，随 Change 归档。
- Canonical 凭证：`.rockspec/knowledge/.evolution/<change-id>.yaml`。

相同 Source、Delta、基线和候选再次执行时返回 `already_evolved`，不重复写入。`no_change` 采用相同规则。

Source 变化表示最终验证输入已过期，必须先恢复验证。Delta、候选或知识基线变化会使现有凭证失效；`derived` 重新执行确定性校验，`normative` 产生新的 Review Subject 并重新 Review。已归档 Change 不可重写，只核验双向凭证；新的知识演进必须来自新的 Change。

归档时 Engine 在锁内构造完整知识基线副本，校验 Review 时的 `before_digest` 和候选 `after_digest`，写 canonical receipt 后原子替换知识目录。冲突返回 `KNOWLEDGE_BASELINE_DIVERGED`，不覆盖当前基线。
