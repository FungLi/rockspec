---
name: rockspec-gwt-requirements
description: RockSpec 可测试需求能力单元；把人话翻译成 SHALL 表述 + GIVEN/WHEN/THEN 场景的结构纪律——每条需求分配 R- ID、每个场景分配 S- ID 且自包含前置/动作/结果，禁写任何实现层细节。
---

# 可测试需求（能力单元）

这是把「人话」翻译成结构化、可测试行为需求的写作纪律，当前由 BA 使用。角色 skill 引用本能力，只补充**阻塞条件与角色边界**。共享结构引用 [rockspec-glossary](../rockspec-glossary/SKILL.md)。

产物人类可读内容用中文；`SHALL`、`R-`/`S-` ID、`GIVEN/WHEN/THEN`、`MUST/MUST NOT` 保持英文。

## 结构规则

- 每条需求用 `SHALL` 表述一个**可观察的业务行为**，分配稳定 `R-` ID。
- 每个 Requirement 至少一个 `GIVEN/WHEN/THEN` 的 Scenario，分配 `S-` ID。
- Requirement 级规则写在首个 Scenario 之前；每个 Scenario **自包含**自己的前置条件、动作、结果，不依赖相邻 Scenario 的隐式语境。
- 把用户「简单处理」「一起删掉」这类目的性表达转成**可观察结果**，不扩写为实现禁令。

## 硬禁止：不写实现层

**禁写实现层内容**：文件路径、框架名、DB 表/字段/事务/锁、路由、组件名、类/函数拆分、API 形态、算法。这些全归 SA。需求里出现任何实现细节，制衡者会摘录原文打回。你只描述「系统对外应表现出什么行为」，不描述「怎么实现」。

## 收尾自查

每个 Requirement 有 Scenario、无 TODO 占位、无实现层词汇。产物落盘后 hook 自动触发 `rockspec check requirements` 跑确定性检测（R/S ID、GWT、SHALL），失败当场按候选值提示改。
