---
name: rs2-glossary
description: RockSpec2 PM 编排架构的共享词汇表；定义结论协议 schema、Hook mark 结构、Worklist 项字段、放漂三级与 Finish 不变式，供 rs2-pm/ba/sa/rr/dev/cr/te 引用。
---

# RockSpec2 共享词汇表

本文是单一事实源。其他 rs2-* skill 不重复定义以下结构，只按名引用本文。产物人类可读内容用中文；Schema Key、R/S/W ID、CLI/子命令、`verdict`、`SHALL`、`GIVEN/WHEN/THEN`、`PASS/REJECT/BLOCK/FAIL` 保持英文。

## 结论协议

每个 agent 结束时产出**恰好一个**结构化结论，写入 Ledger，是 PM 唯一消费的东西。

### 生产者结论（BA / SA / Dev）

```yaml
role: ba | sa | dev
artifact_id: requirements | design | <task-id>
output_path: .rockspec/changes/<id>/<artifact>
output_hash: sha256:...        # 由 rockspec2 conclude 计算，绑定当前产物
self_report: "一句话自述完成范围与覆盖的 R/S/W"
blockers: []                    # 无法自决的产品决策 → PM 升级给人，非空即阻塞
```

### 制衡者结论（RR / CR / TE）

```yaml
role: rr | cr | te
subject_hash: sha256:...        # 必须 == 被评审产物的 output_hash，否则登记被拒
hook_marks_seen: clean | dirty  # 先读 hook mark，脏则直接判负、不做语义评审
verdict: PASS | REJECT          # RR 语义等价词 BLOCK，TE 语义等价词 FAIL
problem_owner: dev | te | upstream-contract   # PM 据此路由
findings:                        # verdict != PASS 必须至少一条；PASS 不得含 open critical/important
  - id: F-001
    severity: critical | important | minor
    evidence: "src/foo.ts:42 偏离 design W-03"
    route_to: dev                # 打回给哪个生产者角色
```

约束：`subject_hash` 不匹配当前产物 hash 一律拒绝登记（防「评审了旧版本」）。PM 只读 `verdict`、`problem_owner`、`blockers`，不读 findings 全文（findings 留给被打回的生产者）。

## Hook mark 结构

生产者产出后，其 hook 自动触发 `rockspec2 check <artifact>`，跑纯机器检测集，结果写为 mark：

```yaml
artifact_id: design
hash: sha256:...                 # 检测所绑定的产物 hash
checks:
  - id: schema-valid
    status: pass | fail
    detail: "缺少 未解决风险 章节"
marked_at: <iso8601>
```

状态派生：任一 check `fail` → mark **脏 (dirty)**；全 `pass` → **干净 (clean)**。脏 mark 不阻止 agent 结束（活已交），但制衡者见脏 mark 必打回。

## Worklist 项字段

Ledger 为每个产物维护一项，是 PM 的唯一状态：

```yaml
artifact_id: requirements
maker_role: ba
checker_role: rr
status: pending | making | checking | passed | blocked
depends_on: [<artifact_id>...]   # 如 design 依赖 approved requirements
output_hash: sha256:...          # 生产者结论登记后写入
verdict_ref: <conclusion-id>     # 制衡者结论登记后写入
```

打回 = 把项的 status 从 `checking` 改回 `pending` 并附 findings。没有状态机迁移表，只有这一个动作。

## 放漂三级

| 级别 | 配置 | 适用 |
|---|---|---|
| **L1 全对抗 + hook** | RR/CR/TE 全启用，hook 全开，Finish 不变式强制 | 高风险、弱模型、需审计 |
| **L2 关键对抗 + hook** | 仅 CR + TE，PROPOSE 期只跑 hook 不配 RR 语义评审 | 中等风险、中等模型 |
| **L3 纯 hook 放漂** | 不配语义制衡者，只有 hook 机器检测，PM 采信 hook 干净即过 | 强模型、快速迭代 |

制衡者 dispatch 强制声明 model tier，Ledger 校验不低于该角色 minimum（属 Finish 不变式的延伸）。

## Finish 不变式（唯一一道引擎级硬门）

一个 Change 允许进入「交付」，当且仅当**每个**工作产物都满足三个条件同时成立：

1. 存在该产物的制衡者 `PASS` 裁决；
2. 该产物全部 hook mark 干净；
3. 制衡裁决绑定的 `subject_hash` == 该产物当前 hash。

引擎不再管顺序（先需求还是先设计全归 PM），只在 `rockspec2 finish` 时守这一条：没经过制衡、没过 hook 的东西不能被当成 done。

## 两阶段边界

- **PROPOSE（提案期）**：BA → SA → RR。阶段内可在 BA↔SA↔RR 间打回。
- **APPLY（实施期）**：Dev → CR → TE。阶段内按 `problem_owner` 路由。
- **跨 PROPOSE↔APPLY 边界的问题只能升级给人**，不能自动回退。RR PASS + 人确认后才进入 APPLY。

## CLI 子命令集（rockspec2）

| 命令 | 用途 | 主要调用者 |
|---|---|---|
| `rockspec2 status --view worklist` | 拉工作清单全景 | PM |
| `rockspec2 status --view resume` | 跨压缩续接投影 | PM |
| `rockspec2 brief <role> --artifact <id>` | Ledger 冻结投影生成 dispatch brief（PM 不手写 brief） | PM |
| `rockspec2 check <artifact>` | 跑确定性检测集，写 hook mark | 生产者 hook 自动触发 |
| `rockspec2 mark <artifact>` | 读产物当前 mark 状态（clean/dirty） | 制衡者 |
| `rockspec2 conclude --role <r> --artifact <id> [--output <path>] [--subject-hash <h> --verdict <v> --problem-owner <o> --report <path>]` | 登记生产者/制衡者结论 | 全部 agent |
| `rockspec2 gate confirm <change-id>` | 跨阶段闸门的人确认登记 | PM（人授权后） |
| `rockspec2 finish <change-id>` | 校验 Finish 不变式，通过则允许交付 | PM |
