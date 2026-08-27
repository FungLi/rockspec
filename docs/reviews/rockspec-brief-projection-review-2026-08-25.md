# RockSpec Brief 投影优化复审（提交 a669a9a）

> 日期：2026-08-25
> 性质：`rockspec-vs-superpowers-implementer-context-2026-08-25.md` 的落地复审
> 审查对象：提交 `a669a9a`（"feat: harden governed delivery context"，engine +1277 行，55 文件）
> 审查方法：源码精读 + 两路独立子代理交叉核查 + 关键缺陷本地实测复现 + 全量测试执行
> 测试状态：`npm test` **134 passed (13 files)**，耗时 82.53s
>
> **基线说明**：结论基于 `a669a9a` 提交内容，工作树无未提交修改。

---

## 一、结论摘要

1. **方向完全正确，落地质量高于原建议本身。** Reviewer 不对称投影、投影反向硬校验、`DECISION_COVERAGE_GAP`、telemetry 量化，均超出原方案。
2. **「负向裁剪」做得扎实，「正向完整性」有多条静默丢失路径。** 不该给的确实没给（4 条 `not.toContain` 测试为证）；但该给的是否给全，缺乏机器保证。
3. **已实测复现两个静默丢失缺陷**：
   - 代码围栏内的 `#` 行被误判为标题 → 段落**静默截断**（critical）
   - Requirement 末尾 Scenario 未选中时 → **尾部正文全部丢失**（important）
4. **根因是架构性的双解析路径**：gap 校验跑在 `validateSpec` 的结构层，实际切片跑在 `markdownHeading` 的文本层。两层对同一份 Spec 可得出不同结论，而校验信任的恰好是**没被影响的那一层**。因此 `TASK_AUTHORITY_PROJECTION_GAP` 只保证「ID 存在」，不保证「内容完整」——**Authority Manifest 会谎报已投影**。
5. **Design 的横切约束整体缺席**：design.md 模板无「全局约束」章节，而「安全与隐私」「兼容、迁移与回滚」「失败与边界行为」不在任何投影路径上。安全约束从 Implementer 视野里消失，属切片引入的实质回归。
6. **投影意识只覆盖下游**：`implement` / `review` 有，`requirements` / `design` / `plan` 三个上游 Skill 完全没有——而它们才是决定「投影出来够不够用」的作者方。

---

## 二、做对的部分

### 2.1 切片是真的，不是改个说法

`composeTaskBrief`（`packages/engine/src/engine.ts:4258-4333`）产出六段结构：

| 段 | 来源 |
|---|---|
| Task Contract | `tasks/<id>.md` 全文 |
| Relevant Approved Requirements | 按 `requirement_ids`/`scenario_ids` 投影 |
| Relevant Approved Design Decisions | 按 `decision_ids` 投影 |
| Applicable Global Constraints | design.md / plan.md 的同名章节 |
| Dependency Delivery Facts | 依赖 Task 的 produces / commit / 路径 |
| Authority Manifest | 全部权威文件的路径 + SHA-256 + 投影 ID |

`proposal.md` 与 `plan.md` 降级为**仅索引**（只进 Manifest，正文不拼接）。

关键是测试断言了**切掉了什么**，而非只测不报错：

```1404:1407:packages/engine/test/engine.test.ts
expect(firstBrief).not.toContain("#### S-002 Scenario: Secondary projection");
expect(firstBrief).not.toContain("### D-002 Secondary boundary");
expect(firstBrief).not.toContain("Proposal marker must remain index-only.");
expect(firstBrief).not.toContain("Plan marker must remain index-only.");
```

### 2.2 Reviewer 不对称投影 —— 超出原建议

原建议是「Reviewer 拿同一份切片 Brief」。实际实现（`engine.ts:4539-4572`）更强，Review Package 含四块：

- `### Frozen Implementer Projection` —— Implementer 当时看见的原件 + path + hash
- `### Reviewer-only Projection Audit` —— **与本 Task 的 R/S 相关、但未被 `decision_ids` 声明**的 Decision 差集
- `### Implementer Report` —— 报告全文 + 内容 hash
- `### Executed Evidence Index`

差集逻辑（`engine.ts:4550-4552`）：

```ts
const relatedDecisions = design.decisions.filter((decision) =>
  !task.decision_ids.includes(decision.id) &&
  (intersects(decision.requirement_ids, task.requirement_ids) ||
   intersects(decision.scenario_ids, task.scenario_ids)));
```

这让「Plan 漏映射一条 Decision」有机会在 Task Review 被抓到，正好补上原报告担心的系统性盲区。

### 2.3 投影有反向硬校验（三层防线）

| 层 | 机制 | 位置 |
|---|---|---|
| Plan Gate | `DECISION_COVERAGE_GAP` / `SCENARIO_COVERAGE_GAP` / `REQUIREMENT_COVERAGE_GAP` | `engine.ts:4228-4249` |
| Brief 生成 | `TASK_AUTHORITY_PROJECTION_GAP`（声明的 ID 投不出来即失败） | `engine.ts:4367-4373` |
| 段落抽取 | `AUTHORITY_SECTION_MISSING` | `engine.ts:4996-5003` |

### 2.4 Brief 防篡改

`assertTaskBriefFresh`（`engine.ts:3245-3265`）重算磁盘 Brief 的 SHA-256 与 `task.brief_hash` 比对，不一致抛 `STALE_TASK_BRIEF`。三处调用点覆盖 review package 准备、action complete、reviewer context 生成。

### 2.5 Skills 下游三层同步

- `skills/rockspec-implement/SKILL.md:24`：「不得默认读取 proposal、完整 Specs、完整 Design 或完整 Plan 来重新解释 Task」
- `skills/rockspec-implement/references/role-task-implementer.md:16`：同义
- `skills/rockspec-implement/references/action-task.execute.yaml:52`：新增不变量

### 2.6 顺带清掉主评审 P0（不在本次建议范围）

| 项 | 位置 |
|---|---|
| Finish HEAD 封口 | `engine.ts:2263-2271` + 专项测试 |
| Evidence 的 Scenario 语义绑定 | `check run --scenario` |
| `max_review_rounds` 真实强制（原先配置了不用） | `engine.ts:693` |
| 批准改 `approval package` 双重 hash 绑定 | `engine.ts:895-921` |
| `scope_assessment` 集合相等校验 | `engine.ts:3382-3390` |
| telemetry + 校准指标 `context_weight` | `storage.ts:522-540` |

`scope_assessment` 四层同步（Engine 校验 ↔ schema ↔ SKILL ↔ 模板）是本次契约同步做得最完整的一处，**可作为修复下述 5.2 / 5.3 的参照模板**。

---

## 三、【Critical】投影会静默截断 —— 已实测复现

### 3.1 缺陷

`extractMarkdownSectionById`（`engine.ts:4986-5015`）与 `extractOptionalMarkdownSection`（`engine.ts:5017-5034`）逐行调用 `markdownHeading` 判定段落边界，**不维护代码围栏（code fence）状态**。

`markdownHeading`（`engine.ts:4981-4984`）：

```ts
const match = /^(#{1,6})\s+(\S.*)\s*$/.exec(line);
```

代码块内以 `# ` 开头的注释行会被判定为 level-1 标题，导致段落在此提前终止。

### 3.2 实测复现

输入（一条含 bash 示例的 Requirement）：

```markdown
### R-001 Requirement: 导入用户

#### S-001 Scenario: CSV 导入

- GIVEN 一个 CSV
- WHEN 运行导入

```bash
# 运行导入脚本
./import.sh users.csv
```

- THEN 用户被创建

#### S-002 Scenario: 失败回滚
- GIVEN ...
```

实际投影输出：

```markdown
### R-001 Requirement: 导入用户

#### S-001 Scenario: CSV 导入

- GIVEN 一个 CSV
- WHEN 运行导入

```bash
```

**丢失 8 行**，包括 `- THEN 用户被创建` 和完整的 S-002。

### 3.3 危害

- Implementer 拿到**半截需求**，THEN 子句缺失。
- `AUTHORITY_SECTION_MISSING` **不触发**（标题找到了）。
- `TASK_AUTHORITY_PROJECTION_GAP` **不触发**（ID 匹配成功）。
- Authority Manifest 照常显示「已投影 R-001」。
- 全链路无任何告警。

### 3.4 严重度判定：critical

理由：

1. 直接违反本次优化的核心承诺——切片必须无损。
2. 全量拼接时代**不存在**该风险（全文都在），属于切片引入的回归。
3. 触发条件不罕见：Spec 写命令、Design 写接口签名或错误码示例是常态。本项目自身的技术方案文档就含 **116 个代码块**。
4. 失败是静默的，不会被任何现有 Gate 拦截。

### 3.5 参照实现

Superpowers 的 `scripts/task-brief` 恰好处理了这一点：

```awk
/^```/ { infence = !infence }
!infence && /^#+[ \t]+Task[ \t]+[0-9]+/ { ... }
```

### 3.6 根因：投影与校验跑在两条独立的解析路径上

这不只是一个正则疏漏，而是架构性的双解析问题：

| 关注点 | 解析器 | 位置 |
|---|---|---|
| gap 校验（ID 是否存在） | `validateSpec` 状态机，逐行匹配 `^####\s+(S-\d{3,}) Scenario:` | `packages/protocol/src/spec.ts:163` |
| 实际切片（内容边界） | `markdownHeading` + level 比较，**无围栏感知** | `engine.ts:4981`、`5006-5013` |

`validateSpec` 同样不感知围栏，但它**不做段落边界判定**——只在匹配行记录，代码块里的 `# comment` 对它无害。于是：

> 围栏里的 `#` 让**文本层**截断，却完全不影响**结构层**。两层对同一份 Spec 得出不同结论，而 gap 检查信任的恰好是没被影响的那一层。

后果链条：

1. 结构层看到 S-001 存在 → 从 `remainingScenarios` 删除 → 不报 gap
2. 文本层没把 S-001 切进来 → Brief 缺失
3. `renderAuthorityManifest`（`engine.ts:5060-5073`）照抄 `projections` 的 ID 列表 → **Manifest 声称 S-001 已投影**

**结论：`TASK_AUTHORITY_PROJECTION_GAP` 只能保证「ID 存在」，不能保证「Brief 内容完整」。** Authority Manifest 是这套机制的信任锚点，它谎报比它缺失更危险。

### 3.7 修复

**方案 A（推荐，根治）**：让投影层复用 `validateSpec` 已解析出的行号，按行号切片而非重新做文本边界判定。

行号字段**已经存在**，只是被显式丢弃：

- `packages/protocol/src/spec.ts:59`：`DraftScenario.line`
- `packages/protocol/src/spec.ts:68`：`DraftRequirement.line`
- `packages/protocol/src/spec.ts:232`：`scenarios.map(({ line: _line, ...item }) => item)` ← 在此丢掉

把 `line` 透出到 `SpecDocument`，投影层直接按 `[requirement.line, nextRequirement.line)` 区间切片，两条解析路径合并为一条，围栏问题自然消失。

**方案 B（止血，半小时）**：在以下三处引入围栏状态机（遇 ` ``` ` 翻转 `inFence`，为真时跳过标题判定）：

- `extractMarkdownSectionById`（`engine.ts:4986`）
- `extractOptionalMarkdownSection`（`engine.ts:5017`）
- `projectRequirementMarkdown`（`engine.ts:5036`）

注：实测确认 Scenario 过滤层因只匹配 level-4 而不会被围栏误切，但仍应统一处理，避免正文出现 `#### ` 开头的示例行时出错。design.md 的 Decision 段落不经 `validateSpec`，因此即使采用方案 A，`extractMarkdownSectionById` 仍需围栏状态机。

建议：先做 B 止血，再做 A 根治。

---

## 三之二、【Important】Requirement 尾部正文被静默丢弃 —— 已实测复现

### 独立缺陷，与围栏问题无关

`projectRequirementMarkdown`（`engine.ts:5048-5057`）用「遇到 level-4 Scenario 标题就翻转 include 开关」：

```5050:5056:packages/engine/src/engine.ts
let include = true;
for (const line of lines) {
  const heading = markdownHeading(line);
  const scenarioMatch = heading?.level === 4 ? /^(S-\d{3,})\s+Scenario:/.exec(heading.title) : undefined;
  if (scenarioMatch) include = scenarioIds.has(scenarioMatch[1]!);
  if (include) projected.push(line);
}
```

开关一旦被某个**未选中**的 Scenario 关掉，**永远不会因为「Scenario 段落结束」而恢复**。

实测：

```markdown
### R-001 Requirement: X
#### S-001 Scenario: A
- THEN a
#### S-002 Scenario: B          ← 未选中，include 关闭
- THEN b
注意：以上所有 Scenario 都受同一并发约束。   ← 丢失
```

只选 S-001 时，末尾这句 **Requirement 级的横切约束丢失**。

### 危害

写在最后一个 Scenario 之后的 Requirement 级补充说明——并发约束、边界条件、跨 Scenario 注意事项——只要末尾那个 Scenario 未被选中，就全部丢失。开头正文的处理是对的（`include` 初值为 `true`），问题只在尾部。

### 修复

识别「下一个 level ≤ 4 的非 Scenario 标题」时重新打开开关，或改用结构化边界（配合 §3.7 方案 A 一并解决）。

---

## 三之三、【Important】依赖事实不含 supersedes 祖先

### 口径不一致

同一份代码里有两个祖先收集函数，口径不同：

| 函数 | 用途 | 是否含 `supersedes` | 位置 |
|---|---|---|---|
| `collectAncestors` | `consumes` 契约校验 | ✅ 含 | `engine.ts:4127-4130` |
| `collectTaskAncestors` | Brief 的 Dependency Delivery Facts | ❌ **不含** | `engine.ts:4961` |

后果：一个 Task 可以合法 `consume` 来自 superseded 祖先的契约（通过校验），但**该祖先的交付事实不会出现在 Brief 里**。

Implementer 拿到一个自己要消费、却看不到任何交付信息的契约。

### 危害场景

Recovery Plan 的 Replacement Task——正是**最需要上下文**的场景。虽然窄，但失败代价高。

两个函数都做传递闭包、都对环安全（图本身已在 `assertTaskPlanValid` 用 `TASK_DEPENDENCY_CYCLE` 校验过），差异只在是否并入 `supersedes`。

### 修复

`collectTaskAncestors`（`engine.ts:4961`）的 `visit` 中并入 `dependency.supersedes`，与 `collectAncestors` 对齐。渲染时可标注该祖先为 superseded 状态。

---

## 四、【Critical】Design 的横切约束进不了 Brief

### 4.1 缺陷

`engine.ts:4286-4289` 从 design.md 和 plan.md 提取标题为 `Global Constraints` / `全局约束` 的章节：

```ts
["design.md", extractOptionalMarkdownSection(designContent, ["Global Constraints", "全局约束"])],
["plan.md",   extractOptionalMarkdownSection(planContent,   ["Global Constraints", "全局约束"])],
```

实测模板情况：

| 模板 | 是否有该章节 |
|---|---|
| `skills/rockspec-plan/assets/plan.md:12` | ✅ 有「## 全局约束」 |
| `skills/rockspec-design/assets/design.md` | ❌ **无** |

`design.md` 模板的实际章节为：上下文 / 范围适配与拆分 / 需求覆盖 / 决策 / 接口与数据流 / **失败与边界行为** / **安全与隐私** / **兼容、迁移与回滚** / UI-UX 对账 / 验证策略 / 未解决风险。

Engine 完全不感知后三节（全仓 grep 无匹配）。`extractOptionalMarkdownSection` 找不到即返回 `undefined`，**静默降级**，不报错。

### 4.2 危害

「所有写操作必须在事务边界内」「PII 字段禁止进日志」「本次变更不得破坏 v1 API 兼容」这类**横切约束**，除非恰好写在某条被投影的 D-ID 正文里，否则**没有任何 Task 的 Implementer 会看到**。

全量拼接时代这些内容是在 Brief 里的。属于切片引入的真实回归。

### 4.3 修复（二选一，建议前者）

**方案 A（推荐，显式优于约定）**：
- `skills/rockspec-design/assets/design.md` 增加「## 全局约束」章节
- `skills/rockspec-design/SKILL.md` 增加填写要求（含「不适用」时的显式写法）
- 考虑在 Engine 侧对 Standard/Strict 校验该章节存在

**方案 B**：Engine 直接投影 design.md 的三节固定标题（安全与隐私 / 兼容、迁移与回滚 / 失败与边界行为）。缺点是标题名变成隐式契约。

工作量：约半天。

---

## 五、【Important】上游 Skill 无投影意识

### 5.1 现状

全仓 grep「投影」在 `skills/` 下仅命中 5 个文件、8 处：

| Skill | 命中 |
|---|---|
| `rockspec-implement`（SKILL / role / action yaml） | ✅ 3 处 |
| `rockspec-review`（SKILL / role） | ✅ 2 处 |
| `rockspec-requirements` | ❌ 0 |
| `rockspec-design` | ❌ 0 |
| `rockspec-plan` | ❌ 0 |

即：**决定「投影出来够不够用」的作者方，完全不知道下游只能看到投影。**

### 5.2 Readiness Reviewer 未承接新职责

`skills/rockspec-plan/references/role-readiness-reviewer.md:7` 的读取范围仍是完整权威链（Specs / design.md / Prototype / plan.md / Task Brief），但**未新增**「校验投影后 Task 是否仍足以独立实施」这一检查项。

这是关键缺口：Readiness Review 是投影生效前**最后一个能看到全量上下文**的角色，理应承担「投影完整性」的上游保障责任。

### 5.3 Plan SKILL 未加强 Task 自包含性要求

`skills/rockspec-plan/SKILL.md:29`（第 6 步，关于测试先行步骤与命令）措辞与改动前完全相同。既然 Brief 现在只投影 Task 契约 + 相关段落，Task 文档已成为 Implementer 上下文的主干，理应有更强的自包含要求。

### 5.4 修复

- `role-readiness-reviewer.md` 增加检查项：「逐 Task 确认其 frontmatter 声明的 R/S/D、验收标准、接口契约与 TDD 命令，在不读取完整 Design/Plan 的前提下是否足以独立实施」
- `rockspec-plan/SKILL.md` 增加一句说明：下游 Implementer 只能看到按 ID 投影的内容，Task 必须自包含
- `rockspec-design/SKILL.md` 说明：横切约束必须写入「全局约束」章节，否则不会进入任何 Task Brief

工作量：约半天。

---

## 六、其余问题

| # | 问题 | 证据 | 严重度 |
|---|---|---|---|
| 6.1 | `execution start --context-hash` **零校验**：Engine 只记录不验证。对比 Approval Package 有完整双重 hash 校验（`895-921`）。Implementer 侧因 Engine 自生成 Brief 而可信，**Reviewer 侧完全靠自觉** | `engine.ts:513-514`；`program.ts:511-512`（`.option` 非 `.requiredOption`）；`schemas.ts:374-375`（`.optional()`） | 高 |
| 6.2 | `CONTRACT_CONFLICT` / `AUTHORITY_CONFLICT` 全仓仅 3 处自然语言出现，**无 RockSpecError、无 schema、无 CLI、无报告字段、无路由表**。Engine 在 Brief 头部用英文承诺了一个无接收端的协议 | `engine.ts:4318`（字符串字面量）；`implement/SKILL.md:24`；`role-task-implementer.md:16` | 高 |
| 6.3 | 两个新错误码 `AUTHORITY_SECTION_MISSING` / `TASK_AUTHORITY_PROJECTION_GAP` **零测试覆盖**；`context_package*` 字段亦零测试覆盖 | 两个 test 目录 grep 无结果 | 中 |
| 6.4 | Projection Audit 只对 **Decision** 做差集，R/S 误映射无机器辅助（因 R/S 之间无横向关联键，属结构性限制）。但 `role-task-change-reviewer.md:21` 措辞易让 Reviewer 误以为已覆盖全部映射错误 | `engine.ts:4550-4552` | 中 |
| 6.5 | Delivery Reviewer 的 Authority Manifest 传空 `projections`，全部渲染为 `index only`，不提供投影覆盖信息 | `engine.ts:4581` + `5069-5070` | 中 |
| 6.6 | 非 Implementer 角色（requirements/readiness/acceptance reviewer）的 context package **无 Engine 产物定义**，与 Implementer 的强绑定共用同一对字段，事后无法从 registry 区分可信度 | `orchestration.md:16`；`requirements/SKILL.md:53`；`plan/SKILL.md:31` | 中 |
| 6.7 | `task.md` 同一模板内命名不一致：frontmatter 用 `{{decision_ids}}`，正文追踪关系用 `{{design_ids}}` | `task.md:9` vs `task.md:30` | 低 |
| 6.8 | `prepareReviewPackage` 的 `mutate` 回调返回值（`2089`）剔除了 `hash`/`mode`/`scope`，与 `2092` 的 `return prepared` 语义分叉，事件 payload 缺 hash | `engine.ts:2089` vs `2092` | 低（代码坏味道） |
| 6.9 | 技术方案 §1093 仍写「包含 Task、相关 Specs/Design/Prototype 和已完成依赖接口」，未更新为投影语义；全文无「Brief 投影」机制描述 | `docs/rockspec/rockspec-technical-solution.md:1093` | 低 |
| 6.10 | `parseDesignDefinition` 结果未被使用（`design` 变量在 4283-4333 全域零引用），实为「frontmatter 必须合法」的校验副作用；`noUnusedLocals` 未开启，后续易被误删 | `engine.ts:4283` | 低 |
| 6.11 | Prototype 的 `references` 无条件 push（4272-4275），`sections` 有条件产出（4294-4308）。`relevant === false` 时 Manifest 列出正文不存在的三条来源——但显示为 `index only`，与 proposal/plan 同构，语义自洽 | `engine.ts:4272-4275` vs `4294-4308` | 低（取舍） |

### 关于 6.8 的更正说明

初次核查曾判定「`prepareReviewPackage` 丢弃 hash 导致 Skills 要求的 Package Hash 拿不到」为高危。经核对**不成立**：`engine.ts:2092` 的 `return prepared` 才是函数真实返回值，CLI（`program.ts:863-869`）拿到的是含 `hash` 的完整对象。`2089` 仅影响 mutate 内部事件 payload，降级为代码坏味道。

---

## 六之二、测试覆盖分析：缺陷为何能逃逸

### 现有覆盖

唯一直接覆盖投影的测试：`engine.test.ts:1339` — `it("projects Task authority narrowly and gives Reviewers an independent cross-check")`。

它是一个**「幸福路径 + 负向裁剪」**测试：4 条 `not.toContain` 很好地证明了「不该给的没给」，但对「该给的是否给全」只在最理想输入下抽样。

### 关键缺口

| 缺口 | 后果 |
|---|---|
| 测试 fixture 的 Spec（`:1355`）和 design.md（`:1366`）**都不含任何代码块** | §三 的 critical 缺陷完全隐形 |
| `TASK_AUTHORITY_PROJECTION_GAP` 全仓零命中 | 该错误码从未被任何测试触发过 |
| `AUTHORITY_SECTION_MISSING` 全仓零命中 | 同上 |
| 测试的 design.md 和 plan.md **都写了** `## Global Constraints` | 没有测试验证「缺失时会怎样」，§四 因此逃逸 |
| **中文 `## 全局约束` 分支从未被测试命中** | 测试用英文标题，而模板实际用中文（`plan.md:12`）——**测试与模板脱节** |
| 依赖只有 T-001 ← T-002 **两级直接依赖** | `collectTaskAncestors` 的递归分支（`engine.ts:4961`）未覆盖；三级传递链未验证 |
| Requirement 尾部无正文 | §三之二 隐形 |
| `composeTaskBrief` 的 prototype 分支（4294-4308）零覆盖 | 现有 prototype 测试走 `design.prototype`，未到达 `startTask` |
| `context_package*` 字段零覆盖 | 与 6.1 同源 |

### 最值得注意的一点

**测试 fixture 与生产模板脱节**：测试用英文 `## Global Constraints` 通过，而两份真实模板一份用中文 `## 全局约束`、一份**完全没有这个章节**。这直接导致 §四 这个 critical 缺陷逃逸。

修复测试时应优先让 fixture 向真实模板对齐，而非另造一套理想输入。

---

## 七、修复优先级

| 顺序 | 项 | 落点 | 工作量 | 严重度 |
|---|---|---|---|---|
| 1 | 代码围栏状态机（止血） | `engine.ts:4986` / `5017` / `5036` | 半小时 | **critical** |
| 2 | Requirement 尾部正文丢失 | `engine.ts:5050-5056` | 半小时 | **important** |
| 3 | design.md 加「## 全局约束」+ Design SKILL 强制 | `skills/rockspec-design/assets/design.md`、`SKILL.md` | 半天 | **critical** |
| 4 | 补测试（fixture 向真实模板对齐） | `packages/engine/test/engine.test.ts` | 半天 | important |
| 5 | `collectTaskAncestors` 并入 `supersedes` | `engine.ts:4961` | 半小时 | important |
| 6 | Plan/Readiness 承接投影责任 | `role-readiness-reviewer.md`、`rockspec-plan/SKILL.md` | 半天 | important |
| 7 | `--context-hash` 补校验（至少 Reviewer 侧） | `engine.ts:505-515` | 半天 | 高 |
| 8 | `CONTRACT_CONFLICT` 二选一：补 report frontmatter 字段 + Engine 校验，或降级为普通描述（不用大写错误码形态） | `implementer-report.md`、`engine.ts:4318` | 半天 | 高 |
| 9 | **根治双解析路径**：透出 `spec.ts` 行号，投影改按行号切片 | `protocol/src/spec.ts:59,68,232`；`engine.ts:4335-4375` | 1 天 | 架构 |
| 10 | 清理 6.4–6.11 | 各处 | 半天 | 中/低 |

第 1–4 项完成后，这版切片才算可信。第 9 项建议在前几项稳定后单独排期。

### 第 4 项的回归测试清单

**优先让 fixture 向真实模板对齐**（当前测试用英文标题，模板用中文，是缺陷逃逸的直接原因）：

- Requirement 正文含 ` ```bash ` 代码块且块内有 `# ` 注释行 → 投影必须包含代码块之后的全部内容
- Design Decision 正文同上
- Requirement 末尾 Scenario 未被选中时 → 尾部 Requirement 级正文必须保留
- design.md 缺少「全局约束」章节 → 明确定义行为（当前是静默降级，建议改为 Standard/Strict 报错）
- **中文 `## 全局约束` 分支**必须有测试命中
- frontmatter 声明 D-00x 但正文无对应标题 → 抛 `AUTHORITY_SECTION_MISSING`
- Task 声明的 R/S 在 Spec 中不存在 → 抛 `TASK_AUTHORITY_PROJECTION_GAP`
- 三级传递依赖链（T-003 → T-002 → T-001）→ 验证 `collectTaskAncestors` 递归分支
- `supersedes` 祖先的交付事实出现在 Brief 中
- `prototype.required` 但 `relevant === false` → Brief 无 UI/UX 段、Manifest 显示 `index only`

---

## 八、总评

**方向完全正确，落地质量高于原建议本身。** Reviewer 不对称投影、投影反向硬校验、`DECISION_COVERAGE_GAP`、telemetry 量化，这几项都超出了原方案的设想。Task 间的授权隔离、Brief 冻结哈希、Reviewer 独立交叉核查都是扎实的设计。原报告的核心主张——「权威要全，工单要薄」——在 Engine 层得到了忠实且更强的实现。

但存在一个统一根因：**切片的无损性没有被机器保证。**

全量拼接虽然笨，有个隐含优势：**不会丢**。切成投影之后，「投影完整」成为新的正确性前提，而这个前提目前有四个漏点：

1. **代码围栏截断** —— 实现 bug，段落内容静默丢失（critical）
2. **Requirement 尾部丢失** —— include 开关不恢复（important）
3. **Design 无「全局约束」标题** —— 模板与实现不匹配，安全/兼容性约束整类缺席（critical）
4. **上游三个 Skill 无投影意识** —— 契约缺口，作者方不知道下游看不到全文

前两条同源于**双解析路径**：完整性依赖一个无围栏感知的 Markdown 切片器，而完整性校验又跑在另一条解析路径上，导致 `TASK_AUTHORITY_PROJECTION_GAP` 给出的保证比它看起来弱得多。根治办法是让投影复用 `validateSpec` 已记录的行号（`spec.ts:59,68` 有，`:232` 被丢弃），两条路径合并为一条。

当前状态可概括为：**设计对、负向裁剪对、正向完整性缺一道机器保证。**

值得强调的一点：**测试 fixture 与真实模板脱节**是多个缺陷得以逃逸的共同原因——测试用英文 `## Global Constraints` 且不含任何代码块，而生产模板用中文标题、真实文档普遍含代码块。补测试时应优先让 fixture 向模板对齐。

---

## 九、与既有报告的关系

- `rockspec-vs-superpowers-implementer-context-2026-08-25.md`：本文是其第八节「`composeTaskBrief` 最小改法」的落地复审。建议的 5 条（主体为 Task 合同、按 ID 切片、点状注入依赖、全局约束抽段、权威链做索引）**全部实现**，且 Reviewer 侧做法优于原建议。
- `rockspec-workflow-design-review-2026-08-23.md`：本次顺带修复了 P0 清单中的 finish HEAD 封口、evidence 语义绑定、`max_review_rounds` 未强制等项。
- `rockspec-standard-workflow-cost-analysis-2026-08-23.md`：Express 档未实现（原为建议、未授权，不计缺陷）。本次新增的 `context_weight` 校准指标恰好可用于量化切片对冷启动体积的实际收益——建议切片修复完成后采集同类 Change 的对照样本，把「结构成本」与「上下文体积」分开评估。
