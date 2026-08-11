---
name: rockspec-prototype
description: 通过外部 ui.prototype Provider（默认 ui-ux-pro-max）创建或修订可检查的 UI/UX 原型。页面、布局、导航、交互流程、响应式、可访问性行为或视觉系统发生变化时使用；既可接入受治理 Design，也可从外部 Brief 或 PRD 直接开始。
---

# RockSpec 原型

只产出一个结果：完整原型包及其对技术设计的影响。保持 Provider 能力与 RockSpec 治理相互独立。

## 选择模式

- Change 合法允许 `design.prototype` 时使用 **Attached（挂接）** 模式；要求当前 Requirements、技术设计草稿和可用的已配置 Provider。
- 用户提供 Brief、PRD、Design 或现有界面，且没有活动 Change 时使用 **Standalone（独立）** 模式。将原型包和 `receipt.yaml` 写入 `.rockspec/workbench/prototype/<slug>/`，并设置 `governed_change: false`。

## 执行

1. 通过宿主可用性解析 `ui.prototype`，保留 Provider 原名。默认使用 `ui-ux-pro-max`；不要复制或改写其源码。
2. 读取 [prototype-protocol.md](references/prototype-protocol.md)。根据用户、页面、目标技术栈、现有 UI 约定、体验目标、约束、状态和非目标组装有边界的 Brief。
3. 调用 Provider 产出设计系统、页面/状态模型、交互行为、响应式规则、可访问性约束和可检查原型。
4. 将结果规范化为 `brief.md`、`design-system.md`、`prototype.md` 和 `assets/`，保留 Provider 归属和证据。
5. Attached 模式将发现对账进 `design.md`，在声明 Provider 可用的情况下提交 `design.prototype`，然后为 Design 审批暂停。Provider 输出不能迁移状态或通过 Gate。

可从 [brief.md](assets/brief.md)、[design-system.md](assets/design-system.md) 和 [prototype.md](assets/prototype.md) 起草产物。完成 Attached 模式前读取 [action-design.prototype.yaml](references/action-design.prototype.yaml)。

只改按钮文案或错别字，且不影响布局、导航、交互和可访问性语义的 Lite Change 不要求原型。
