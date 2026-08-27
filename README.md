# RockSpec

RockSpec 是面向编码 agent 的**受治理变更交付**框架。主会话扮演 **PM**，编排一组专职 agent（BA / SA / RR / Dev / CR / TE）在两阶段流程中协作，质量靠**对抗式制衡**与**确定性 Hook** 保证，而非一套硬编码的引擎状态机。

> 本仓库是 PM 编排架构的工作版本（完全重写，不含旧引擎兼容代码）。设计见 [`docs/proposals/pm-orchestration-rearchitecture.md`](docs/proposals/pm-orchestration-rearchitecture.md)，执行与边界见 [`docs/proposals/pm-orchestration-execution-plan.md`](docs/proposals/pm-orchestration-execution-plan.md)。

## 核心思想

- **PM 只编排，不干活**：读结论、派任务、处理打回、把产品决策抛给用户；不写产物、不判质量。
- **7 角色两阶段**：
  - **PROPOSE**：BA（需求）→ SA（设计+拆 Task）→ RR（就绪硬校验）。
  - **APPLY**：Dev（TDD 实现）→ CR（代码审查）→ TE（独立测试）。
- **对抗式制衡**：每个产物由独立上下文的制衡者（RR/CR/TE）把关，制衡者结论用 `subject_hash` 绑定当前产物，杜绝“评审了旧版本 / 假 PASS”。
- **确定性 Hook（硬地板）**：产物产出即由 CLI 跑机器规则检测（schema、必备章节、需求覆盖、证据绑定），失败当场打脏 mark；制衡者见脏 mark 直接打回，不浪费语义评审。
- **唯一硬门 = Finish 不变式**：每个产物需 `制衡 PASS + hook clean + subject_hash 匹配` 才能交付。没有 18 状态机，顺序由 PM 依赖判断。
- **inline 共创 vs 隔离返工**：首次 BA/SA 在主会话与用户交互式澄清/设计；被驳回则派隔离子 agent 机械返工；不可自决的冲突升级用户裁决。
- **放漂三级**：L1 全对抗、L2 关键对抗、L3 纯 Hook（对标强模型自主流程）。

## 组成

```text
packages/ledger/     # @rockspec/ledger —— 自包含的 Ledger + Hook + CLI
skills/rs2-pm/       # PM 编排器
skills/rs2-ba/       # 业务分析师（需求）
skills/rs2-sa/       # 方案架构师（设计 + Task）
skills/rs2-rr/       # 就绪评审员（PROPOSE 出口硬校验）
skills/rs2-dev/      # 开发（TDD）
skills/rs2-cr/       # 代码审查
skills/rs2-te/       # 测试（4 类验收）
skills/rs2-glossary/ # 结论协议 / Hook mark / Finish 不变式 词汇表
```

`@rockspec/ledger` 只依赖 `yaml` / `zod` / `commander`，无其他内部包依赖。

## 开发快速开始

前置：Git、Node.js 20.19+、pnpm 10。

```bash
pnpm install
pnpm build
pnpm test        # 构建后跑 vitest
```

## CLI 用法

`rockspec` 是 Ledger 的命令入口（等价 `node packages/ledger/dist/bin.js`）。

```bash
# 创建一个 Change（放漂级别 L1|L2|L3）
pnpm rockspec new my-change --rigor L1

# 查看 worklist / 跨压缩续接视图
pnpm rockspec status my-change --view worklist
pnpm rockspec status my-change --view resume

# 标记进入生产，返回调度模式（首次 BA/SA=inline，返工=subagent）
pnpm rockspec making my-change requirements

# 对产物跑确定性 Hook 检测
pnpm rockspec check my-change requirements

# 提交生产者结论 / 制衡者结论（--file 读 YAML/JSON，或 stdin）
pnpm rockspec conclude-maker my-change --file maker.yaml
pnpm rockspec conclude-checker my-change --file checker.yaml

# 预检并执行 Finish 不变式，然后归档
pnpm rockspec finish-check my-change
pnpm rockspec finish my-change
pnpm rockspec archive my-change
```

全局选项：`--json`（结构化输出）、`--repo <path>`（指定仓库根，默认当前目录）。

Change 状态存于目标仓库的 `.rockspec2/changes/<id>/`：`change.yaml`（元数据）+ `events.ndjson`（仅追加事件日志）+ 各产物文件。

## 结论协议（要点）

生产者与制衡者各产出一个结构化结论。制衡者结论的 `subject_hash` 必须等于当前产物 hash，否则 Ledger 拒绝登记。完整字段见 `skills/rs2-glossary/SKILL.md`。

## 状态

- 已实现：Ledger（事件日志 + 投影）、Hook 层、结论协议、subject_hash 绑定、Finish 不变式、放漂三级、`rockspec2`→`rockspec` CLI 全链路、7 角色 + 词汇表 skill。
- 已知边界（见执行计划文档）：model tier 强制门待接 host adapter；code 证据检测待接 git；Ledger 多进程锁；skill 的 host 分发集成。
