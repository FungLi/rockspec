# RockSpec 设计评审报告

> 评审对象：`docs/rockspec/origin-prd.md`（requirements）、`docs/rockspec/rockspec-technical-solution.md`（design）、`skills/` + `packages/`（plans 与实现）
> 评审日期：2026-08-11
> 评审基线：工作区当前状态，`pnpm build && pnpm typecheck && pnpm test` 实测通过（9 个测试文件 / 70 个用例）

## 总体判断

三份设计的核心是站得住的，而且已经不只是纸面方案——Engine、Protocol、CLI 已实现到能跑通 70 个测试的程度。

需要说明的一点：在未执行 `pnpm build` 的情况下 `pnpm typecheck` 报 63 个类型错误、`pnpm test` 有 5 个失败，但这是 workspace 依赖陈旧 `dist` 导致的假象，先 build 后全部干净。这本身是个工程问题（见"较小的问题"第 1 条），但不是设计缺陷。

### 值得肯定的三点

**1. "单一状态写入者 + 审批绑定 Hash" 是这套设计真正的骨架。**

没有让 Agent 自己声明"我完成了"，而是把状态迁移权收归 Engine，审批绑定内容 Hash，上游产物一变下游审批自动失效（`assertApprovalFresh`、`assertReviewFresh` 都真实实现了）。这比 Superpowers 靠 prompt 纪律约束 Agent 强一个量级，是从"提示词工程"跨到"Harness 工程"的关键一步。

**2. 能力原子性 vs 状态迁移原子性的分离是正确的抽象。**

用户侧看到 13 个 `rockspec-<能力>` Skill，内部保留 14 个 Action ID，不做一对一映射。这解决了 OpenSpec 那种"每个命令一个 Skill"导致的宿主 Skill 列表污染，也避免了 Superpowers 那种把角色暴露成用户命令的问题。`rockspec-change` 作为薄路由器读 `recommended_next.entry_skill` 这个设计尤其干净。

**3. Attached / Standalone 双模式解决了真实痛点。**

大多数工作流项目要求从第一步开始，而现实是手里常常已经有 PRD 或 Design。允许从任意能力切入、产物落到 `.rockspec/workbench/` 且明确标记 `governed_change: false`，这个务实的妥协很有价值。

---

## 一、Design 阶段缺少独立评审者（设计上的不对称）

这是最需要补的结构性缺口。

`origin-prd.md` 明确写了：

> - BA-业务分析师 review Spec
> - **SA方案架构师 review Design、Plans**

但当前实现是：

| 阶段 | 独立 Reviewer | 落点 |
|---|---|---|
| Requirements | 有 | `skills/rockspec-requirements/references/role-requirements-reviewer.md` |
| Design | **无** | 仅 `design.technical` 一个 inline action，自检靠 `SKILL.md` 第 8 步主 Agent 自读 |
| Plan | 有 | `skills/rockspec-plan/references/role-readiness-reviewer.md`（同时审 Design + Plan）|

真正的独立审查要等到 `readiness.review`，而那时 Plan 已经写完了。

### 问题

**Design 错了，Plan 一定跟着错。** 等 Readiness Reviewer 发现 Design 覆盖不全，`route_to` 打回 `design.technical`，Plan 全部作废重写。这正是张乐方案里 RR 在开发前拦一道的价值，但把 Design 和 Plan 合并到同一个 Gate 后，反馈环变长了。

对比张乐方案的原始设计：SA 输出 design.md 后，RR 做的是**需求纯净度 + 方案覆盖度**两项硬校验，这两项本来是分开的关卡。

### 三个可选方案

**方案 A（最小改动，推荐）**

保留单 Gate，但在 `design.technical` 的 completion 里加一条硬门禁——Design 写完后必须先跑一次"需求覆盖矩阵自检"，把 `design.md` 的覆盖矩阵与已批准 Spec 的 R/S ID 做机器比对，缺一个就阻塞。不新增 Agent，但把"覆盖度"从人工检查变成确定性校验。成本几乎为零。

**方案 B**

新增 `design.review` Action + `role-design-reviewer.md`，Standard 1 个 Reviewer，Strict 2 个。Readiness 退回只审 Plan 和前置条件。语义最干净，但多一次 Agent 调用和一个用户批准点的等待。

**方案 C**

Profile 分档——Standard 沿用现状，Strict 才启用独立 `design.review`。折中，但增加了 Profile 之间的差异复杂度。

### 倾向

倾向方案 A。Design 阶段本来是"与用户频繁脑暴"的 inline 协作（`origin-prd.md` 里明确说了没法让独立 Agent 做），用户本身就在回路里，再加一个 Reviewer 边际收益不高。真正缺的是**机器可验证的覆盖度检查**，而不是又一个 AI 读一遍。

---

## 二、Protocol 声称的 Validator 有相当一部分没有实现

`rockspec-technical-solution.md` §10 列了 Validator 必须检查的 7 项，逐条对照代码：

| §10 声称的检查 | 实现状态 |
|---|---|
| ID 唯一且引用存在 | 部分（格式校验有，跨文件引用存在性没有）|
| 每个 Requirement 至少一个 Scenario | 已实现（`RequirementSchema` 强制）|
| 每个 Scenario 至少对应一种验证方式 | **未实现** |
| 每个 Design Decision 可定位覆盖的 Requirement | **未实现** |
| 每个 Task 有独立验收标准 | 部分（frontmatter 不含此字段）|
| 所有 Requirement 被 Task 或非代码验证覆盖 | **未实现** |
| Final Review 前无未关闭的 Critical/Important Finding | 已实现 |

另外 §2.1 目标里的 "Task DAG 无环" 也没有环检测——`packages/` 下 grep `cycle`/`topological`/`visited` 零命中。`syncTasks` 只检查了 `dependencies.includes(task.id)` 这种自环，`A→B→A` 能顺利通过。

README 的 MVP boundaries 里诚实地写了 "full dependency extraction and DAG cycle validation are deferred"，这点值得肯定，但 §10 和 §2.1 目标里的表述没有同步这个 deferred 状态，读起来像已实现。

### 建议

环检测是几十行代码，收益/成本比很高，建议直接补上。覆盖矩阵校验（R/S → T）是方案 A 的核心，也建议一并做。

剩下的在 §10 加一列"实现状态：MVP / Deferred"，让文档与代码一致——**文档声称的门禁如果没实现，就是最危险的那种技术债，因为你会以为它在保护你**。

---

## 三、Task 契约在"给人看"和"给机器读"之间有裂缝

`TaskDefinitionSchema` 从 frontmatter 读 7 个字段：`schema_version`、`id`、`title`、`dependencies`、`requirement_ids`、`scenario_ids`、`allowed_paths`。

但 `skills/rockspec-plan/assets/task.md` 正文里还有 9 个章节（接口契约、非目标、验收标准、TDD 四步、完成契约……），这些**全部不进 Schema**，Engine 完全看不见。后果：

- Readiness Reviewer 检查 `Consumes`/`Produces` 一致性，只能靠 AI 读 Markdown 表格，无法机器校验
- `acceptance_criteria` 在 `TaskRecordSchema` 里是 `string[]`，但 `syncTasks` 从不填充它，永远是空数组
- Plan 里的"文件职责图"与 Task 的 `allowed_paths` 没有交叉校验

`origin-prd.md` 第 3 点说得很对："plans 需要有给人看的一篇 md 文档，也需要有给 ai 用的，按照 task 切分的独立的任务文档"。但现在的实现里，**给 AI 用的那部分只有 frontmatter 那 7 个字段是真的"给 AI 用"**，其余仍是自然语言。

### 建议

把 `acceptance_criteria` 和 `produces` / `consumes` 提到 frontmatter（作为结构化数组），正文保留人类可读的展开说明。这样 Reviewer 的一致性检查可以变成确定性校验，而不是又一次 AI 阅读理解。

不需要全部结构化——只提那些**需要跨 Task 比对**的字段。

---

## 四、`agents/openai.yaml` 只有 4 行，双宿主对等性存疑

每个 Skill 的 `agents/openai.yaml` 都是 4 行。而 `adapters/claude/adapter.yaml` 有 60 行，包含完整的模型 tier 映射、cwd 固定要求、降级策略。

`rockspec-technical-solution.md` §14 声称双宿主"共用 Protocol、Engine 和 Canonical Skills"，§19.3 列了 6 项宿主契约测试。但 `tests/` 下只有一个 `host-assets.test.ts`，校验的是文件存在性和引用完整性，不是行为对等性。

### 建议

这不是必须现在解决的问题——README 已经把 "live installation tests in both host applications" 标为 release work。

但建议在文档里把"双宿主支持"降级为"双宿主设计，Claude Code 已验证，Codex 待验证"，避免自己误判成熟度。同时支持两个宿主的成本是持续的，如果 Codex 不是主力环境，先做单宿主 + 保留 Adapter 抽象层可能更务实。

---

## 五、YAML 里的声明式表达式没有解释器

`skills/rockspec-design/references/action-design.technical.yaml` 里有：

```yaml
requires_user_approval_on_pass_when: "prototype.required == false"
```

`skills/rockspec-change/references/change-recipe.yaml` 里有 `when: "prototype.required == true"`。

`packages/` 下所有 `.ts` grep 过，**零个地方解析这些字符串**。实际的条件判断硬编码在 `packages/engine/src/workflow.ts` 里。

也就是说这些 YAML 目前是"给 AI 读的文档"，不是"给 Engine 执行的配置"。这本身可以接受（Skill 的 references 本来就是给 Agent 看的），但存在两个风险：

1. 看起来像可执行配置，后来者会以为改 YAML 能改行为
2. YAML 和 `workflow.ts` 会漂移，没有任何测试保证它们一致

### 建议

二选一：

- 明确注释"本文件为 Agent 指引，非 Engine 配置，权威实现见 `workflow.ts`"
- 加一个测试，断言 YAML 里声明的 Action 集合、profile 归属、审批点与 `workflow.ts` 的状态机一致

后者几十行代码，能防住长期漂移。

---

## 六、较小的问题

1. **`pnpm typecheck` 在未 build 时报 63 个错。** workspace 依赖 `dist` 而非 source 的经典问题。建议 `typecheck` 脚本前置 build，或在 tsconfig 里配 project references / paths 指向 src。否则每个新贡献者（包括未来的自己）第一次跑 typecheck 都会以为项目是坏的。

2. **`rockspec-technical-solution.md` §21 有两个 "13"**（第 13 项重复编号）。

3. **`docs/open-project/` 有 3347 个文件进了仓库。** 既然 §17.3 已经用 commit hash 固定了参考基线，这些源码副本没必要留在仓库里，`git submodule` 或干脆只保留 `adoption-matrix.yaml` 更清爽。

4. **`docs/reference-designs/` 目录不存在。** §17.11 规定要维护它，§21 完成标准第 15 项要求"内化矩阵完成评审"，但目录还没建。矩阵内容目前散在 §17.5–17.9 里，建议要么建目录拆出去，要么把 §17.11 改成"矩阵维护在本文档 §17.5–17.9"。

---

## 七、一个更根本的问题：复杂度预算

这套设计有 14 个 Action、13 个 Skill、3 个 Profile、15 个状态、6 个 Role Prompt、2 个宿主、约 6300 行 TS。Standard 流程走完一个变更要经过 3 个用户批准点、至少 5 次 Agent 调度。

`origin-prd.md` 里对 Superpowers 的批评是：

> Superpowers 的 subagent 太重了，每个任务都会多轮实施 + 多个 review Agent 去验证，这里执行的效率非常低

**RockSpec 的 Standard 流程比 Superpowers 更重，不是更轻。**

确实把单任务的 Agent 数从"多个 review Agent"压到了 Dev + CR 两个（这个改进是实的），但整条流程加了 Triage、Requirements Review、Readiness Review、Acceptance、Delivery Review 五道额外关卡。一个普通功能从需求到归档，用户要等 5+ 次 Agent 往返、批准 3 次。

Lite Profile 是对的解药，但 Lite 的准入条件有 8 条**全部必须满足**，现实中相当多的中等改动会落到 Standard。

### 说明

这不是设计错误——显然是有意选择"质量优先"。

但建议在真实项目上跑通 3–5 个变更后，量化 §19.4 里已经列的指标（Agent 调用次数、修复轮次、总耗时），然后回答一个问题：**Standard 的五道关卡里，哪一道抓到的问题最少？**

如果 Requirements Review 在实际使用中从来没有 `CHANGES_REQUIRED` 过，它就应该降级为 Strict-only。

Harness 工程的价值在于"确定性约束"，但约束的**边际收益是递减的**，而每一道关卡的成本是线性累加的。现在的设计把所有关卡都设成 Standard 默认开启，建议保留一个"按实测数据裁剪 Profile"的演进路径，而不是把当前的 Standard 当成终态。

---

## 建议的行动顺序

| # | 行动 | 预估 | 解决的问题 |
|---|---|---|---|
| 1 | 修 `typecheck` 的 build 依赖 | 小时级 | 六.1，阻碍所有后续开发体验 |
| 2 | 补 DAG 环检测 + R/S→Task 覆盖矩阵校验 | 小时级 | 二 + 一（方案 A）|
| 3 | 把 §10 / §2.1 目标标注实现状态 | 小时级 | 二，消除"以为有保护"的风险 |
| 4 | `acceptance_criteria` + `produces`/`consumes` 提到 Task frontmatter | 小时级 | 三 |
| 5 | 加 YAML ↔ `workflow.ts` 一致性测试 | 小时级 | 五 |
| 6 | 真实项目跑 3–5 个变更，按 §19.4 指标裁剪 Profile | 周级 | 七 |

前 5 项都是小时级的工作。第 6 项才是决定这套工作流最终好不好用的关键——设计已经足够扎实，现在缺的是真实使用数据来校准复杂度。
