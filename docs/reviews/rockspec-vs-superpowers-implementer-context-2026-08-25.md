# RockSpec vs Superpowers：Implementer 上下文哲学对照

> 日期：2026-08-25
> 性质：主评审报告（`rockspec-workflow-design-review-2026-08-23.md`）与耗时分析（`rockspec-standard-workflow-cost-analysis-2026-08-23.md`）的补充——回应「两个设计哲学哪个更好」
> 触发输入：对照 Superpowers `subagent-driven-development` 的 Implementer 输入结构，审视 RockSpec `composeTaskBrief` 的全量拼接
> 对照源码：
> - Superpowers：`docs/open-project/superpowers/skills/subagent-driven-development/`（`SKILL.md`、`implementer-prompt.md`、`task-reviewer-prompt.md`、`scripts/task-brief`）、`docs/open-project/superpowers/skills/writing-plans/SKILL.md`
> - RockSpec：`packages/engine/src/engine.ts`（`composeTaskBrief`）、`skills/rockspec-implement/SKILL.md`、`skills/rockspec-plan/assets/task.md`
>
> **基线说明**：`composeTaskBrief` 结论基于撰写时工作树；若后续已改为按 ID 切片，本文「投影层」建议需对照重验。权威分层、冻结 Brief、`decision_ids` 等治理机制不在本文反对范围内。

---

## 一、结论摘要

1. **实施阶段 Superpowers 更好；权威模型 RockSpec 更好。** 把两者捆成同一套「给 Implementer 看什么」，是当前最大的设计误判。
2. **全量权威链塞给 Implementer，不是质量杠杆，是质量幻觉。** 对「设计聊清楚之后按预期交付」这个目标，它不增加保真，只增加冷启动体积和二次解释空间。
3. **正确拆法是分层采用：权威要全，工单要薄。** 全量给 Engine 存、给 Reviewer 按需取、给人审；给 Implementer 的永远是投影。
4. 这与 Express 档正交：Express 砍关卡数量，Brief 切片砍每一次 Implementer/Reviewer 的冷启动体积。两件事叠起来，中小需求才可能从 3–4 小时掉到约 1 小时。

一句话：

> **人把 Design 钉死 → Plan 把钉死的决策投影成可执行合同 → Implementer 只看见合同 → Reviewer 拿合同审 Diff → 机器检查覆盖和证据。**
>
> 中间任何一环让 Implementer「再读一遍为什么」，都是在邀请它改写预期。

---

## 二、两种哲学分别在赌什么

### 2.1 Superpowers：走样来自没看清任务、以及会话被历史污染

对策：Plan 写成可转录的菜谱；每个 fresh subagent 只看见 Task N + 点状接口。防走样的责任在 Planner 写细、Reviewer 拿同一份 Brief 审 Diff。Implementer 被当成手稳的执行器，不负责重新理解「为什么」。

实际输入结构：

1. Controller 跑 `scripts/task-brief PLAN_FILE N`，awk 只抽出 `### Task N:` 一节，写到 `.superpowers/sdd/<plan>/task-N-brief.md`。
2. Dispatch prompt 固定五块：一句话场景、Brief 路径、前序 Task 的接口/决策、Controller 对 Brief 歧义的裁决、报告路径与状态契约。
3. 硬性规则：「精确值只出现在 Brief」「Never make a subagent read the whole plan file」「不要粘贴累积的前序 Task 摘要」。他们踩过一次坑：某次 dispatch 42k 字符，99% 是粘贴的历史。

Task 正文被要求自包含到可以转录：Files、Interfaces（Consumes/Produces 精确签名）、带真实代码的 TDD 步骤、精确命令、Commit。Plan 头的 Global Constraints 对每个 Task 隐式生效，由 Controller 点状注入；Reviewer 另拿 `[GLOBAL_CONSTRAINTS]`。

### 2.2 RockSpec：走样来自只盯 Task 文档、丢掉已批准意图

对策：Spec / Design / Plan / Task 分层权威；Implementer 对照整条链推理。防走样的责任在执行者自己对齐权威；Engine 用 hash、覆盖、证据把对齐过程钉死。

当前 `composeTaskBrief`（`packages/engine/src/engine.ts`）仍是全量拼接：

- `proposal.md`
- `specs/` 下全部 `.md`
- 整份 `design.md`
- 整份 `plan.md`
- 当前 `tasks/${taskId}.md`
- 若需要 Prototype，再加 `prototype/design-system.md` 与 `prototype/prototype.md`

Skill 要求「只把 Engine 返回的冻结 Brief 交给 Worker」，冻结机制（路径 + SHA-256）是对的；但 Brief **内容本身已经是全集**。`tasks/T-xxx.md` 作为合同已经相当接近 Superpowers 的 Task 结构（目标、文件范围、Consumes/Produces、验收、TDD 命令），差的不是 Task 文档，是 Engine 把整条权威链又糊回去了。

### 2.3 两笔赌注作用在不同层

| 层 | 该谁负责 | 更强的一方 |
|---|---|---|
| 谁能改什么、什么算已批准 | 权威模型 | **RockSpec**（hash-bound gate、R/S/D 覆盖、Review Package） |
| 这一次 subagent 该看见什么 | 上下文包装 | **Superpowers**（切片、禁止读整份 Plan、精确值只出现一次） |
| Task 写到多细才够执行 | 计划粒度 | **平手，且 Superpowers 有点过头** |

RockSpec 现在的问题是：用「权威模型」的正确性，去为「上下文包装」的错误买单。

---

## 三、为什么全量 Brief 防不住走样

给 LLM 更多权威文本，不等于它更忠于权威。

### 3.1 注意力是竞争性的

Task.md 才是合同，却被 proposal + 全部 specs + design + plan 淹没。模型会跟「最长、最近、最像散文」的那段走，而不是跟 frontmatter 里那几条 `acceptance_criteria` 走。

### 3.2 双源会诱发静默调和

Task 写 X、Design 写得稍像 Y 时，人会停下来问；模型更常「两边都照顾一下」。RockSpec Skill 要求冲突时停、走 `plan.create`，但全量 Brief 让模型觉得自己已经有足够信息做裁决——问的更少，编的更多。Superpowers 的 `NEEDS_CONTEXT` / 「先问再干」反而更容易被触发，因为 Brief 里没有可以拿来脑补的材料。

### 3.3 设计意图不该在实施时被重新解释

Design 已经过人审、绑了 hash。这时把整份 Design 再交给每个 Implementer，是在请他们再设计一次。质量目标要的是保真，不是二次创作。

### 3.4 「为什么」的正确读者是 Reviewer，不是 Implementer

对照 Diff 问「这是否覆盖 R-12 / D-3」是审查动作；让写代码的人同时扛「理解整个 Change」是把一次设计成本乘以 Task 数。这就是 3–4 小时里那笔 fresh context 税的主要来源（见耗时分析报告第二节）。

结论：RockSpec 的权威分层是对的；**把整条链当作 Implementer 的工作记忆，是把给人看的档案室，当成了给模型看的工单。**

---

## 四、Superpowers 不是神药：三处硬伤正好是 RockSpec 已补上的

### 4.1 菜谱里写真实实现代码，在存量代码库里经常是假精确

`writing-plans` 要求 Step 1 就贴测试代码、Step 3 贴最小实现。这对绿场或 Planner 已经读透的文件成立；对真实产品，Planner 要么提前把 Implementer 的活干了，要么计划里的代码是错的。

RockSpec 的 Task 模板更成熟：**契约 + 路径 + 可执行验证命令，不预写实现。** 这条不要学 Superpowers。

### 4.2 质量上限 = Plan 质量

Implementer 被禁止理解「为什么」，Plan 错了就忠实交付错误。Superpowers 靠 Reviewer 兜底，但 Reviewer 也只拿同一份 Task Brief——系统性的 Spec 偏离，两边一起瞎。

RockSpec 的 Design 人审、R/S/D→Task 机器覆盖、Task 强制 `decision_ids`，其实比 Superpowers 更能挡住「Plan 漏了已批准决策」。

### 4.3 切片靠 Controller 纪律，不靠引擎

「精确值只出现在 Brief」「不要粘 42k 历史」是给编排 Agent 的提示词。排程一走样就回到原点。RockSpec 把 Brief 冻成 `runtime/tasks/T-xxx/brief.md` + SHA-256，这条是工程优势，应保留——**改的是 compose 内容，不是冻结机制。**

---

## 五、对照表

| | Superpowers | RockSpec 当前 |
|---|---|---|
| Brief 内容 | 只抽 Task N 一节 | proposal + 全部 specs + 整份 design + 整份 plan + 当前 task.md |
| 精确值放哪 | 只在 Brief；dispatch 禁止复述 | Task.md 有 ID/契约，但 Implementer 同时拿到整条权威链 |
| 前序上下文 | Controller 点状注入接口/裁决 | 靠读完整 `plan.md` 自己找 |
| 全局约束 | Plan 头一行一条，单独注入 | 埋在 design.md 全文里 |
| Task 粒度 | 带真实代码的 TDD 菜谱 | 结构化契约（R/S/D ID、consumes/produces、命令），没有实现代码块 |
| 禁止事项 | 禁止读整份 Plan；禁止粘历史 | Skill 要求只交冻结 Brief，但 Brief 本身已经是全集 |
| 模型假设 | 菜谱完整 → 可用最便宜档转录 | 要从权威链推理 → 需要能读懂 Spec/Design 的模型 |
| 防走样放哪 | Planner 写细 + Reviewer 拿同一份 Brief 审 Diff | Implementer 手里拿全量权威 |
| 权威/治理 | 基本靠提示词纪律 | hash-bound gate、覆盖矩阵、executed evidence、Review Package |
| 切片执行 | awk 脚本 + Controller 纪律 | Engine 冻结，但 compose 未切片 |

---

## 六、按「设计聊清楚 → 按预期交付」拆开看哪个更好

目标不是「更像 Superpowers」或「更像一套治理系统」，而是两件事同时成立：

1. 设计阶段把预期钉死
2. 实施阶段按钉死的预期交货，且中小需求不要 3–4 小时

对应关系：

- **钉死预期**：RockSpec 赢。人审 Spec/Design、hash、覆盖、证据、Review Subject，Superpowers 基本没有对等物。
- **按预期交货**：实施时 Superpowers 的切片更好。保真靠「小而硬的合同 + 独立 Reviewer」，不靠「执行者读完全部档案」。
- **成本**：Superpowers 完胜。同一套 fresh-per-task，输入差一个数量级。

综合更好的设计不是二选一，是分层采用：

```text
权威层（RockSpec 保留）
  Spec / Design / Plan / Task 分层、hash、机器覆盖、人闸

投影层（改学 Superpowers）
  Implementer Brief = 当前 Task 合同
                    + 按 ID 抽出的 R/S/D 段落
                    + 依赖 Task 的 produces
                    + 一小段全局约束
                    + 路径/hash 索引（需要再读，默认不读）

校验层（两边都有，RockSpec 更强）
  独立 Task Reviewer 拿同一份切片 Brief + 冻结 Diff
  冲突升级回 Plan/Design，而不是让 Implementer 现场调和
```

Strict / 安全 / 迁移可以加厚投影（威胁模型、不变式、相关 Decision 全文）。那是 Profile 差异，不是「所有 Task 都读整份 Design」的理由。Standard 中小需求用全量 Brief，是用最贵的方式追求一种模型并不具备的阅读能力。

---

## 七、取舍清单

**学 Superpowers：**

- Brief 切片
- 精确值只出现一次
- dispatch 禁止粘历史
- Implementer 先问再干
- Reviewer 只拿 Brief + Diff（可另附按 ID 抽出的 Decision 段落，仍不是全文）

**留 RockSpec：**

- 分层权威
- 冻结 Brief + hash
- `decision_ids` 覆盖
- executed evidence
- Review Package
- 人闸

**不要学 Superpowers：**

- 把实现代码写进 Plan。那是把设计阶段变成预实施，Planner 成本会把刚省下的 Implementer 成本吃回去，而且在存量库里经常写错。

**不要保留现在这样：**

- 合同已经在 `tasks/T-xxx.md` 里了，再把 proposal / specs / design / plan 全文糊回去。这是用正确的权威模型，做了错误的上下文包装。

---

## 八、若要对齐：`composeTaskBrief` 最小改法

前提：Plan 阶段把 Task 写成自包含合同——至少 Consumes/Produces 签名和 TDD 命令已经可执行，而不是「参考 Design 自行判断」。当前 `skills/rockspec-plan/assets/task.md` 已经朝这个方向走了，缺的是 Engine 切片，不是再写一份文档。

建议 `composeTaskBrief` 改为：

1. **主体**：当前 `tasks/${taskId}.md`（本来就是合同）
2. **按 ID 切片，不贴全文**：只抽取该 Task 的 `requirement_ids` / `scenario_ids` / `decision_ids` 对应段落
3. **点状注入**：依赖 Task 的 `produces`（Engine 已有 producer/consumer 图）、上一轮的歧义裁决
4. **全局约束**：从 Design 抽一小节，而不是整份 `design.md` + `plan.md`
5. **权威链做索引**：Brief 里列 `proposal.md` / `design.md` 路径 + hash，需要时再读；默认禁止「先把全文读进上下文」

冻结路径、SHA-256、`task start` 写入 `runtime/tasks/<task-id>/brief.md` 的机制不动。Skill 继续禁止用聊天记忆替代冻结 Brief——只是 Brief 变薄了。

Reviewer 输入应对齐同一份切片 Brief，而不是再喂一遍全量权威。需要核对某个 Decision 时，按 ID 取段落，不取整份 Design。

这与 Express 档（耗时分析 §4.1）正交，可并行：

| 杠杆 | 砍什么 | 预期效果 |
|---|---|---|
| Express 档 | 关卡数量（Requirements / AI Readiness / TE / Delivery Review） | 调度次数 15–20 → 8–12 |
| Brief 切片 | 每一次 Implementer/Reviewer 的冷启动体积 | 单次上下文从「整个 Change」降到「一个合同 + 相关段落」 |

---

## 九、与既有报告的关系

- 主评审报告关注「声称强制、实际可绕过的门禁」和「文档批准与可运行交付的鸿沟」。本文不替代 P0 修复；Brief 切片改变的是 Implementer 看见什么，不降低门禁强度。
- 耗时分析指出 fresh context 税是 3–4 小时的最大隐藏成本，建议用 Express 砍关卡。本文补充：即使关卡数量不变，全量 Brief 也在每个 Task 上把那笔税再乘一遍。
- 校准协议仍应记录首个真实样本：`Standard 单 Change 3-4h（gpt-5.6-terra，约 5 tasks）`。Brief 切片落地后，应用同一类 Change 再采一次，才能把「结构成本」和「上下文体积」分开看。
