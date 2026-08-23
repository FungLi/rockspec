---
name: rockspec-evolve
description: 用于 RockSpec Change 收尾前，从已验证的 Requirements、Design、Prototype、实现与证据中提炼可复用的产品知识、架构规则和 UI/UX 设计系统增量，并以幂等凭证对账到项目知识基线。
---

# RockSpec 知识演进

只沉淀能够约束或帮助后续 Change 的稳定知识；不要把 Change 总结、一次性实现细节或尚未验证的设想写入基线。产品行为仍以 `.rockspec/specs/**` 为唯一权威来源。

## CLI 入口

本文的 `rockspec ...` 是逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 执行

1. 查询 Engine 状态。仅在 `READY_TO_FINISH` 且推荐 `knowledge.evolve` 时执行写操作；对已归档 Change 只运行 `rockspec knowledge package <change-id>` 核验凭证。
2. 读取已验证的 Spec、Design、Prototype、实现证据、Acceptance 和 Delivery Review，并对照 `.rockspec/specs/**` 与 `.rockspec/knowledge/**`。区分一次性选择与跨 Change 可复用的产品语境、架构契约、体验模式。
3. 从 [knowledge-delta.md](assets/knowledge-delta.md) 写入 Change 根目录的统一 `knowledge-delta.md`。候选完整文件写入 `knowledge/updates/<target>`；不得直接修改 `.rockspec/knowledge/**`。
4. `no_change` 也必须生成 Delta。存在候选更新时，运行 `rockspec knowledge package <change-id>` 固定 Source、Delta、基线和候选 Hash，然后让独立 Reviewer 按 [role-knowledge-reviewer.md](references/role-knowledge-reviewer.md) 写入 `reviews/knowledge-review.md`。
5. `normative` 更新必须先向用户展示拟改变的公共规则并取得明确确认，将确认人和时间写入 Delta。`derived` 更新由独立 Review 通过即可。
6. 运行 `rockspec action complete knowledge.evolve <change-id>`，随后重新查询状态。Engine 写入 Change 侧凭证；归档事务才安装候选知识并写入 `.rockspec/knowledge/.evolution/<change-id>.yaml`。

重复执行、冲突判定、目标目录和产物格式必须遵循 [evolution-protocol.md](references/evolution-protocol.md)。提交 Action 前读取 [action-knowledge.evolve.yaml](references/action-knowledge.evolve.yaml)。

报告 Change ID、`no_change` 或更新目标、Review/人工确认结果、Source Digest、凭证状态和下一推荐 Action。
