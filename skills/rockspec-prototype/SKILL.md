---
name: rockspec-prototype
description: 用于页面、布局、导航、交互、响应式、可访问性或视觉系统变更；通过 ui.prototype Provider 创建或修订 UI/UX 原型。
---

# RockSpec 原型

## 产物语言

读取 `.rockspec/config.yaml` 的 `artifact_language`；缺省按 `zh-CN`。Prototype、Design System、说明和终端摘要使用配置语言，Schema Key、R/S/D ID、CLI/Action、Verdict 和规范关键字保持英文。

只产出一个结果：完整原型包及其对技术设计的影响。保持 Provider 能力与 RockSpec 治理相互独立。

## CLI 入口

Attached 模式把本文的 `rockspec ...` 视为逻辑命令：先从绑定 Worktree 的 Git 根目录读取 `.rockspec/install.lock.yaml` 中的 `rockspec.runtime_path`，确认入口存在且 SHA-256 与锁中的 `integrity` 一致，再执行 `node <runtime_path> ...`。安装锁存在时禁止用 `command -v rockspec`、全盘 `find` 或 package manifest 猜测入口；锁、入口或完整性异常时停止并交给 `$rockspec-debug` 修复安装。

## 选择模式

- Change 合法允许 `design.prototype` 时使用 **Attached（挂接）** 模式；要求当前 Requirements、技术设计草稿和可用的已配置 Provider。
- 用户提供 Brief、PRD、Design 或现有界面，且没有活动 Change 时使用 **Standalone（独立）** 模式。将原型包和 `receipt.yaml` 写入 `.rockspec/workbench/prototype/<slug>/`，并设置 `governed_change: false`。

Attached 按 Open Revision 的 `interaction_mode` 执行：`reconcile` 只同步冻结 R/S/D ID；`compact` 生成完整的视觉 Delta，并以一次完整页面/状态/响应式检查点供用户核对，禁止按页面或设计章节反复确认；`full` 才进行开放式 UI/UX 方案探索。旧 `feedback_reopen` 缺字段时按 compact。需要新的 UI/UX 决策、改变可观察行为或无法证明 Authority Impact 未变时停止并升级。

## 执行

1. 通过宿主可用性解析 `ui.prototype`，保留 Provider 原名。默认使用 `ui-ux-pro-max`；不要复制或改写其源码。
2. 读取 [prototype-protocol.md](references/prototype-protocol.md)。根据用户、页面、目标技术栈、现有 UI 约定、体验目标、约束、状态和非目标组装有边界的 Brief；在 Frontmatter 中绑定当前 Spec Approval Hash、Design Draft 文件 Hash 和适用的 R/S/D ID。
3. 调用 Provider 产出设计系统、页面/状态模型、交互行为、响应式规则、可访问性约束和可检查原型。
4. 将结果规范化为 `brief.md`、`design-system.md`、`prototype.md` 和 `assets/`，保留 Provider 归属和证据。
5. 原型发现只影响既有视觉表达时直接修订原型；compact 把所有受影响页面、状态、交互、响应式和可访问性结果合并为一次会话审阅投影，说明原行为、新行为、影响页面/状态、关键取舍、验证方式和待确认项，使用户通常无需逐个打开原型文件即可核对核心视觉 Delta；用户已在当前 Revision 核对过完整视觉 Delta 时不得重复。投影不完整时允许用户下钻正式原型，不得因摘要格式阻断流程。影响技术边界时列出受影响 D/R/S 并交还 `$rockspec-design`。改变可观察业务行为、替换已批准决策或 Authority Impact 未知时不得继续自动对账；升级人工。Provider 不得自行改变 Requirements 或 Design。
6. Attached 模式提交 `design.prototype` 后必须回到 `$rockspec-design`，将原型技术影响写入 `design.md` 并再次完成 `design.technical`。只有 Engine 将 Prototype 标记为 `reconciled` 后才可请求 Design Approval。

可从 [brief.md](assets/brief.md)、[design-system.md](assets/design-system.md) 和 [prototype.md](assets/prototype.md) 起草产物。完成 Attached 模式前读取 [action-design.prototype.yaml](references/action-design.prototype.yaml)。

只改按钮文案或错别字，且不影响布局、导航、交互和可访问性语义的 Lite Change 不要求原型。
