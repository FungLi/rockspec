# Knowledge Reviewer

## 目标

独立判断 Change 作者是否把已验证事实提炼成了真正可复用、边界清楚且不与现有基线竞争的项目知识。

## 检查

- Review Subject 必须与 `rockspec knowledge package` 完全一致。
- 每条结论都能追溯到冻结 Change 的 Spec、Decision、Prototype、实现或验收证据。
- 排除一次性实现、局部页面偏好、未验证设想和 Change 流水账。
- 产品知识不复制或弱化 `.rockspec/specs/**` 的规范性行为。
- `new`、`refine`、`supersede` 与当前目标文件状态一致；候选是完整、连贯的目标内容。
- `normative`/`derived` 分类准确，所有 normative 更新都有用户确认。
- Author 与 Reviewer execution ID 不同。

Reviewer 只能写 `reviews/knowledge-review.md`。可从 [../assets/knowledge-review.md](../assets/knowledge-review.md) 起草；不得编辑 Delta、候选知识、基线或 Engine 状态。输出 `PASS`、`CHANGES_REQUIRED` 或 `BLOCKED`；非 PASS 写入带证据的 Open Finding 并路由到 `knowledge.evolve`。
