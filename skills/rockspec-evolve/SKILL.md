---
name: rockspec-evolve
description: 用于 RockSpec Change 收尾前，从已验证的 Requirements、Design、Prototype、实现与证据中提炼可复用的产品知识、架构规则和 UI/UX 设计系统增量，并以幂等凭证对账到项目知识基线。
---

# RockSpec 知识演进

## 产物语言

读取 `.rockspec/config.yaml` 的 `artifact_language`；缺省按 `zh-CN`。知识变更、评审正文和终端摘要使用配置语言，Schema Key、ID、CLI/Action、Verdict 和规范标识保持英文。

只沉淀能够约束或帮助后续 Change 的稳定知识；不要把 Change 总结、一次性实现细节或尚未验证的设想写入基线。产品行为仍以 `.rockspec/specs/**` 为唯一权威来源。

## CLI 入口

本文的 `rockspec ...` 是逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 执行

1. 查询 Engine 状态。仅在 `READY_TO_FINISH` 且推荐 `knowledge.evolve` 时执行写操作；对已归档 Change 只运行 `rockspec knowledge package <change-id>` 核验凭证。
2. 读取已验证的 Spec、Design、Prototype、实现证据、Acceptance 和 Delivery Review，并对照 `.rockspec/specs/**` 与 `.rockspec/knowledge/**`。区分一次性选择与跨 Change 可复用的产品语境、架构契约、体验模式。
3. 先运行 `rockspec execution start knowledge.evolve.author --role knowledge_author`，把返回 ID 写入 [knowledge-delta.md](assets/knowledge-delta.md)，并保存到 Change 根目录。候选完整文件写入 `knowledge/updates/<target>`；Author 完成写入后立即运行 `rockspec execution complete <id> <change-id> --outcome <outcome>`。不得直接修改 `.rockspec/knowledge/**`。
4. `no_change` 也必须生成 Delta。先用 `rockspec validate <change-id> --artifact knowledge-delta.md` dry-run。存在候选更新时，运行 `rockspec --json knowledge package <change-id>` 固定 Source、Delta、基线和候选 Hash，并读取返回的 `review_required` 与非阻塞 `semantic_warnings`。全部为 `derived` 时不启动 Reviewer：Author 在 Delta 的「评估」中自检每条内容是否由已验证来源直接推导、是否排除一次性实现偏好、是否不新增公共规则、是否不与现有知识竞争；若提示 MUST/必须/可以/恰好等义务强度可能变化，核对其是否真正改变规则，改变时改为 `normative`，等义或误报可说明后继续，提示本身不得阻断流程。Engine 负责来源存在、目标匹配、操作合法、文件非空、基线/候选 Hash 和归档原子性检查。无法靠上述边界证明为纯派生时改为 `normative`，不得用 `derived` 规避审查。Engine 对纯 `derived` 的 Reviewer 启动请求返回 `KNOWLEDGE_REVIEW_NOT_REQUIRED`，收到后直接继续完成 Action，不得改用其他 Agent 重试。
5. 只要包含 `normative` 更新，必须先在会话区结构化展示拟改变的公共规则、变更前后、适用范围、对后续 Change 的影响、冲突/风险、回退方式和正式候选路径，再取得明确确认；不要只给出知识文件路径。摘要允许按目标归组，格式或个别内容缺失不得成为额外 Gate，完整依据仍是 Delta 和候选文件。将确认人和时间写入 Delta。随后运行 `rockspec execution start knowledge.evolve.review --role knowledge_reviewer`，按 [role-knowledge-reviewer.md](references/role-knowledge-reviewer.md) 写入 `reviews/knowledge-review.md`；Reviewer 返回并写完报告后立即运行 `rockspec execution complete <id> <change-id> --outcome <outcome>`。
6. 运行 `rockspec action complete knowledge.evolve <change-id>`，随后重新查询状态。Engine 写入 Change 侧凭证；归档事务才安装候选知识并写入 `.rockspec/knowledge/.evolution/<change-id>.yaml`。

重复执行、冲突判定、目标目录和产物格式必须遵循 [evolution-protocol.md](references/evolution-protocol.md)。提交 Action 前读取 [action-knowledge.evolve.yaml](references/action-knowledge.evolve.yaml)。

报告 Change ID、`no_change` 或更新目标、Review/人工确认结果、Source Digest、凭证状态和下一推荐 Action。
