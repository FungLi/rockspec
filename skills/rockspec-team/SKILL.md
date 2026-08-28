---
name: rockspec-team
description: RockSpec 团队组织图（PM 专属地图）；7 角色拓扑、生产者/制衡者制衡矩阵、两阶段 PROPOSE/APPLY 边界、回退路由规则、inline 共创 vs 隔离执行的调度模式。PM 据此决定「派谁、用什么模式、打回去哪」。
---

# RockSpec 团队组织图（PM 地图）

本文是 **PM 专属的组织架构图**：PM 据此决定派谁、用什么调度模式、结论回退去哪。角色的具体干法在各角色 skill，共享结构（结论协议、Worklist、Hook mark、Finish 不变式、CLI、看板）在 [rockspec-glossary](../rockspec-glossary/SKILL.md)。本文只讲**团队拓扑与流转**。

## 7 角色拓扑

| 角色 | skill | 阶段 | 类型 | 制衡对象 |
|---|---|---|---|---|
| PM | rockspec-pm | 全程 | 编排器（不干活） | — |
| BA 业务分析师 | rockspec-ba | PROPOSE | 生产者 | 被 RR 制衡 |
| SA 方案架构师 | rockspec-sa | PROPOSE | 生产者 | 被 RR 制衡 |
| RR 就绪评审员 | rockspec-rr | PROPOSE 出口 | 制衡者 | 制衡 BA + SA |
| Dev 开发工程师 | rockspec-dev | APPLY | 生产者 | 被 CR + TE 制衡 |
| CR 代码审查员 | rockspec-cr | APPLY | 制衡者 | 制衡 Dev |
| TE 测试工程师 | rockspec-te | APPLY 出口 | 制衡者 | 制衡 Dev（且双重制衡 CR） |

## 制衡矩阵（maker → checker）

```
PROPOSE:  BA ─┐
              ├─→ RR （就绪评审，进 APPLY 前唯一硬校验）
          SA ─┘

APPLY:    Dev ─→ CR （代码审查）
              └─→ TE （独立验收，不看 CR 结论，构成对 CR 的双重制衡）
```

- 每个生产者产物都必须过其制衡者的 `PASS` 才算 done（Finish 不变式，见 glossary）。
- TE **不读 CR 结论**独立验收，CR 的遗漏由 TE 兜底——这是刻意的双重制衡，不是冗余。

## 两阶段边界

- **PROPOSE（提案期）**：BA → SA → RR。阶段内可在 BA↔SA↔RR 间打回。
- **APPLY（实施期）**：Dev → CR → TE。阶段内按 `problem_owner` 路由。
- **跨 PROPOSE↔APPLY 边界的问题只能升级给人**，不能自动回退。RR PASS + 人确认（`rockspec gate confirm`）后才进入 APPLY。

## 回退路由规则

- **PROPOSE 内**：RR 判需求污染（实现层夹带）→ 回 BA；判方案漏覆盖 → 回 SA。
- **APPLY 内**：按 `problem_owner` 路由——`dev` 回 Dev，`te`（E2E 资产缺口）回 TE，`upstream-contract`（需求/契约问题）升级人或交 SA/BA。
- **跨阶段**：只能升级给人，不自动跨界回退。

## 调度模式：inline 共创 vs 隔离执行

| 生产性质 | 角色 / 场景 | 调度模式 | 能力 |
|---|---|---|---|
| 共创型 | BA 需求澄清、SA 方案设计（**首次，无既有产物**） | **inline**：主会话戴角色帽子与用户交互 | [rockspec-inline-cocreation](../rockspec-inline-cocreation/SKILL.md) |
| 执行型 | Dev 写代码、BA/SA **被驳回返工** | **隔离子 agent**：照合同/findings 机械执行 | [rockspec-isolated-rework](../rockspec-isolated-rework/SKILL.md)、[rockspec-tdd](../rockspec-tdd/SKILL.md) |
| 制衡型 | RR / CR / TE | **隔离子 agent**：评审必须独立 | [rockspec-adversarial-review](../rockspec-adversarial-review/SKILL.md) |

**首次 vs 返工切换**：BA/SA 首次无产物 → inline 共创（方向对齐用户）；产物已存在被 RR 驳回 → 隔离子 agent 机械返工。切换判据由 `rockspec status` 的 `attempts` 决定，PM 不凭记忆。
