---
name: rockspec-isolated-rework
description: RockSpec 隔离返工能力单元；生产者（BA/SA/Dev）被制衡者打回后作为隔离子 agent 的机械修补纪律——只读冻结 brief+findings+hook marks、照具体 finding 修补不重新共创、增量变更说明、不可自决冲突写 blockers 升级。
---

# 隔离返工（能力单元）

这是 BA / SA / Dev **产物已存在、被制衡者打回**时共享的返工纪律。角色 skill 引用本能力，只补充**自己修的是什么产物**。共享结构引用 [rockspec-glossary](../rockspec-glossary/SKILL.md)。

## 隔离运行，只读冻结输入

被打回时你作为**新的隔离子 agent**运行，只读 PM 用 `rockspec brief` 冻结的 brief + 制衡者 findings + hook marks。**不与用户实时共创、不翻主会话历史、不自行扩大范围**。方向已在首次共创（或原始 design）时定，返工只照 finding 修。

## 机械修补，不重新发挥

1. 逐条对照 findings 修补——finding 指哪打哪，只修被指出的问题。
2. hook mark 若脏，按机器检测项当场修到干净。
3. **不引入 findings 之外的改动**，除非为修复所必需并在结论说明理由；不顺手改无关内容、不加超范围特性或防御代码。

## 增量变更说明

修完在结论 `self_report` 里**说明本轮增量变更**（改了哪些产物/文件的哪些部分、对应哪条 finding），便于制衡者聚焦复核 fix diff，不必重审全量。

## 不可自决冲突 → 写 blockers 升级

返工中遇到无法自行解决的冲突——例如 finding 要改的与另一条已定决策矛盾、补覆盖所需的上游产物本身缺失、design 的 Task 根本无法实现——**不要硬改绕过**。写入结论 `blockers` 指明冲突，由 PM 升级人裁决或回上游角色。你无权单方推翻已定决策。
