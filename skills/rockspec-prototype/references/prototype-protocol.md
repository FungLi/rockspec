# 原型协议

将原型产物写入 `.rockspec/changes/<change-id>/prototype/`。

## 必需文件

### `brief.md`

记录绑定的 Requirements 和 Design Hash、产品类型、目标用户、用户任务、页面范围、支持的技术栈、仓库 UI 约定、体验目标、约束、内容假设、非目标和必需视口。分开记录已知事实、假设和开放问题。

### `design-system.md`

记录包含对比度意图的颜色 Token、字体、间距、布局网格、组件状态、图标方式、交互反馈、响应式断点/行为、可访问性规则，以及偏离仓库设计系统的内容。优先复用仓库 Token，不建立平行系统；没有已批准品牌时不得自行发明。

### `prototype.md`

记录每个页面及其目的；导航和主流程；适用的加载、空、错误、成功、禁用、权限和危险操作状态；键盘/焦点行为；移动端/桌面端适配；内容层级；可检查原型路径或外部 URL；限制。使用 `assets/` 下的相对路径引用本地截图或素材。

### `assets/`

只保存检查或实施已批准原型所需的素材。记录第三方素材的来源和许可证。不得复制 `ui-ux-pro-max` Skill 或其参考库。

## Provider 请求

向 Provider 提交有边界的 Brief，并要求结果写入上述四个协议位置。在产物元数据中保留 Provider 名称和版本/来源标识。Provider 提供设计专业能力；RockSpec 负责编排、Hash、Gate 和生命周期。

Installed Provider 的发现必须显式且只对当前进程有效。对 status、Action 完成和 Gate 调用传入可重复的全局参数 `--provider ui-ux-pro-max`，或设置逗号分隔的环境变量 `ROCKSPEC_AVAILABLE_PROVIDERS=ui-ux-pro-max`。不得仅因某台机器存在目录就推断 Provider 可用。

## 完整性检查

- 每个 UI Requirement 和 Scenario 映射到一个或多个页面/状态。
- 关键路径包含失败和恢复行为。
- 明确响应式行为，不能只用桌面截图暗示。
- 按需明确键盘、焦点、语义标签、对比度、减少动态效果和触摸目标要求。
- 组件符合现有技术栈和设计系统。
- Technical Design 已吸收原型发现的数据/API/组件影响。
- 无需依赖隐藏聊天上下文即可检查原型。

原型问题仍会改变可观察行为时，不得批准 Design。将问题路由到 `requirements.clarify`，然后重新生成原型并对账。
