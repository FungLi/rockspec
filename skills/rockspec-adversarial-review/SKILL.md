---
name: rockspec-adversarial-review
description: RockSpec 对抗式评审能力单元；制衡者（RR/CR/TE）共用的评审纪律——先读 hook mark 脏则直接判负、校验 subject_hash 防评旧版本、findings 结构与 PASS 门槛、独立只读不委派。角色专属校验项由各角色 skill 补充。
---

# 对抗式评审（能力单元）

这是 RR / CR / TE 三个制衡者共享的评审纪律。角色 skill 引用本能力，只补充**自己那几项语义校验**，不重复本文的通用流程。共享结构（结论协议、Hook mark、subject_hash、CLI）引用 [rockspec-glossary](../rockspec-glossary/SKILL.md)。

## 铁律：独立、只读、不委派

你作为**独立上下文的隔离子 agent**运行，绝不与被评审的生产者或用户共处一个上下文。你只读、不改任何产物、不委派下游。你的产出是**恰好一个结论**，是 PM 唯一消费的东西。

## 第一步永远是读 hook mark

制衡者的第一步永远是读机器铁证，而非直接语义评审：

1. 执行 `rockspec mark <artifact-id>` 读 hook mark 状态。
2. **任一为脏 (dirty)** → 直接判负（RR 用 `BLOCK`、CR 用 `REJECT`、TE 用 `FAIL`），结论 `hook_marks_seen: dirty`，`problem_owner` 指向生产者，**不做语义评审**——机械错误已由 hook 抓到，退回生产者当场修，不浪费语义评审成本。
3. **全部干净 (clean)** → 才进入本角色的语义评审。

## 只评审冻结的 Subject

只评审 PM 用 `rockspec brief` 冻结投影生成的 Subject（产物快照 / base..head 固定 diff），**不跟随移动的 HEAD、不评审工作区未提交改动、不翻主会话历史**。

## subject_hash 校验（防「评了旧版本」的假 PASS）

你的结论 `subject_hash` **必须 == 被评审产物的 output_hash**。不匹配说明产物已变（你评的是旧版本）→ CLI 拒绝登记，要求 PM 用当前产物重新 dispatch。这是「reviewer 拿错包给假 PASS」的根治。

## findings 结构与 PASS 门槛

1. 每个 finding 含：稳定 ID、`critical | important | minor` 严重度、具体证据（摘录原文 / `文件:行` + 偏离的 W-xx/R/S）、`route_to`（打回给哪个生产者角色）。
2. `problem_owner` 判定：实现/产物缺陷 → 对应生产者；需求或契约本身不足 → `upstream-contract`（PM 据此升级人或回上游，不在本阶段内自动跨界回退）。
3. `verdict: PASS` **不得含任何 open critical/important finding**；判负（BLOCK/REJECT/FAIL）**必须至少一条 open finding**。
4. 执行 `rockspec conclude --role <r> --artifact <id> --subject-hash <hash> --verdict <v> --problem-owner <owner> --report <path>` 登记结论。

PM 只读你的 `verdict`、`problem_owner` 做路由，findings 全文留给被打回的生产者。
