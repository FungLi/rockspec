# RockSpec 开发工作流设计评审报告

> 评审日期：2026-08-23
> 评审视角：两个核心诉求——**设计阶段聊清楚**、**按预期交付可运行功能**
> 评审对象：
> - `docs/rockspec/rockspec-technical-solution.md`（Draft v0.15）
> - `skills/`（14 个 Canonical Skills、Action/Role 契约、产物模板）
> - `packages/engine`、`packages/protocol`（状态机、门禁、校验实现）
> - `packages/engine/test/engine.test.ts`（测试覆盖）
> - 前序评审 `docs/rockspec/rockspec-design-review.md`（2026-08-11）
>
> **基线说明**：仓库当前存在大量未提交修改（几乎所有被审查的 Skills/Engine 文件均为 modified 状态）。本报告结论基于**工作树当前内容**而非 HEAD；若后续回滚部分改动，P0 清单需对照重验。
>
> 评审方法：文档精读 + Skills 契约层探索 + Engine 实现层独立深挖（含测试覆盖分析），三方证据交叉验证。

---

## 一、总体判断

这套设计的成熟度显著高于社区同类项目，且前序评审（8/11）的问题大多已真实修复：DAG 环检测、R/S 覆盖矩阵、Task frontmatter 结构化（`acceptance_criteria`/`consumes`/`produces`）、YAML↔Engine 一致性测试均已落地。它做对了一件根本性的事：**把质量保障从"提示词纪律"升级为"引擎强制"**。

但对照核心诉求，当前存在三类真实风险，按危险度排序：

1. **声称强制、实际可绕过的门禁**（实现层旁路，共 7 处，含 3 个严重级）——你会以为它在保护你，其实没有
2. **"聊清楚"发生在文档层，"交付"发生在软件层**——两者的表示鸿沟没有被任何机制桥接
3. **追踪链的最后一公里未机器化**——Spec 说清了、任务排好了，但"每个 Scenario 是否真有测试证据"仍靠 AI 自觉

三方证据收敛到同一个判断：

> **Engine 已经能证明"流程材料彼此一致"（Hash、Diff、Commit、状态推进都做得扎实），还不能证明"交付的功能符合用户真实预期"。** 差距集中在四件事：最终 HEAD 封口、证据的业务语义绑定、身份真实性、以及文档批准与可运行交付之间的鸿沟。

好消息：P0 全部是小时到天级的工作，修复路径清晰（有现成测试模式可循）。

---

## 二、值得坚守的设计资产（不要在演进中丢掉）

| 机制 | 为什么关键 |
|---|---|
| 单一状态写入者 + 审批绑定内容 Hash + 失效传播 | Agent 无法自我声明完成；上游一变下游审批自动失效（`engine.ts:2541-2573`）。这是全案的骨架 |
| Executed Evidence（`check run` 引擎亲自执行、绑定 commit 与日志 Hash） | "跑过测试"从口头声明变成可验证事实；手工 `evidence add` 不能满足 Standard/Strict 主门禁（`engine.ts:3721-3763`） |
| Review Package 固定 Diff + Reviewer 身份隔离 + 结构化 Finding | Reviewer 审不错对象、不能自审、结论不可被静默改写（`engine.ts:3655-3718`、`schemas.ts:699-739`） |
| TE 不读前序 Review 结论 + TE 后 Final CR 固定顺序 | 打破确认偏差的正确结构，且 Final CR 永远看到最终代码与最终测试 |
| **Authority Baseline vs Content Hash 的概念分层** | 全案最精妙的设计：区分"内容变了"和"意图变了"，让自动续期有严格边界（`engine.ts:636-787`） |
| 只升不降的 Profile + 校准协议 | "未经真实数据不裁剪 Gate"是成熟的工程态度（`docs/reference-designs/calibration-protocol.md`） |

---

## 三、缝隙一：引擎声称强制、实际可绕过（最优先修）

### 3.1 严重级（S1-S3）

**S1. `finish()` 不封口 Git HEAD——最直接的交付完整性漏洞**

`finish()` 只检查 `verification.commit === deliveryHead`，**不检查当前 HEAD 仍等于 deliveryHead**（`engine.ts:1789-1799`），`archive()` 同样不复查（`engine.ts:1804-1863`）。攻击路径完整存在：

```text
Delivery Review PASS → 验证冻结 commit A → 新增 commit B → finish/archive 照常成功
```

这直接破坏"最终交付等于已验证功能"的核心承诺。修复是一行代码（`currentCommit !== deliveryHead` 抛 `STALE_EVIDENCE`）加一个反例测试。

**S2. 风险分级只在 CLI 层，Engine API 可直接建 Lite 高风险变更**

Triage 规则本身正确（`packages/protocol/src/profile.ts:71-121`：支付/迁移等强制 Strict、feature/fix 至少 Standard），CLI 入口会先调用 `triageProfile()`（`packages/cli/src/program.ts:238-271`）。但 `RockSpecEngine.newChange()` 只是 `input.profile ?? config.default_profile`（`engine.ts:153-157`），不携带也不校验 kind/risk。当前 AI 走 CLI 会被拦，但 AI 可以直接 import Engine；技术方案明确保留了 MCP/SDK/编排器路径。**分级校验应下沉进 Engine**。

**S3. `recordEvidence()` 硬编码 `scenario_ids: []`**（`engine.ts:1283-1300`）

证据模型有 `scenario_ids` 字段但从不填充——Scenario 覆盖校验连数据入口都没开。且测试套件自己用 `node -e process.exit(0)` 满足门禁（`engine.test.ts:1332-1337`、`:1368-1373`、`:1426-1431`），印证"证据只证明有命令返回 0"的语义空洞。

### 3.2 门禁旁路（P0）

| # | 旁路 | 证据 | 后果 |
|---|---|---|---|
| B1 | **Design 审批不重跑覆盖校验**。`assertDesignCoverage` 只在 `design.technical` 完成时调用（`engine.ts:434-442`）；`approve design` 前置检查（`engine.ts:2597-2606`）只看 spec 审批新鲜 + design 落盘 + prototype 对账，不重验覆盖与 `inputs.spec_hash` | action 完成后、审批前改写 `design.md`，Engine 按新 Hash 直接放行。Spec→Design 的机器覆盖保障存在**窗口期失效** |
| B2 | **Stage Review 的 legacy 纯文本 PASS 旁路**（`engine.ts:4102-4131`）：无 Frontmatter 的报告只要正文含 PASS 就以 `legacy:<path>` + 空 findings 通过 | Requirements/Readiness 的结构化要求（真实 execution ID、非 PASS 必须有 Finding）可被一段纯文字绕过。Strict 两份纯文本报告会得到两个不同的 `legacy:<path>`，形式上也满足"双 Reviewer 不同 ID" |
| B3 | **`reviewer_execution_id` 接受任意非空字符串**（`StageReviewDocumentSchema`，`schemas.ts:741-775`），填 `"TODO"` 也通过 | "Reviewer 必须是登记过的真实 execution"仅是提示词约定；身份独立性可被伪造。所有身份字段（`approved_by`、`reviewer_execution_id`、`author_execution_id`）均为自报字符串，Engine 强制"声明的 ID 不相等"，不强制"真实执行来源不同" |
| B4 | **占位检测只拦 `TODO` 不拦 `TBD`**（`assertMaterialized`，`engine.ts:2682-2714`），而 Design/Plan Skill 都要求两者都禁 | TBD 占位的半成品可落盘并进入审批 |

**修法**：① `approve design` 重跑 `assertDesignCoverage` + `inputs.spec_hash` 校验；② 移除 legacy PASS 路径（或至少要求 execution ID 登记），非结构化报告一律 BLOCKED；③ Stage Review 的 execution ID 与 Engine 已登记的 execution 记录比对（建议直接按全链 execution lineage 做：禁止 Reviewer 与 Requirements/Design/Planner/Readiness/TE 作者重用 execution）；④ 占位词表扩为 `TODO/TBD/FIXME/<placeholder>`。

---

## 四、缝隙二：围绕"聊清楚"的四个结构性问题

### 4.1 需求不确定性没有进入分流维度

Triage 按**技术风险**（鉴权/支付/迁移…）分 Lite/Standard/Strict，但**需求模糊度**是正交维度。一段高度模糊的需求直接进 Standard 写 Spec，产出的是一份"精确但错误"的 Spec——把模糊冻结成了错误的具体。这是"聊清楚了但交付的不是想要的"的最大上游来源。

**建议**：Triage 增加不确定性评估——高不确定需求先路由 `rockspec-research` 或强制原型/Spike，再写 Spec。

### 4.2 批准的媒介是文档，交付的媒介是软件

三个人工批准点（Spec/Design/Implementation）批准的全是文档；Implementation 批准确认的是"Plan/Tasks 可执行包"（`engine.ts:2608-2617`），**不是代码**。用户第一次结构化接触"可运行的东西"要等到 Task 实施甚至 Acceptance。人对"自己要什么"的认知很大程度是 outcome-dependent（看到才知道）——这是表示鸿沟，不是流程严谨性能弥补的。

现有机制里只有 UI 变更的 Prototype 部分桥接了这个鸿沟，非 UI 的行为类功能没有等价物。

**建议**（两条互补）：
- **早期可运行反馈**：把 Matt 的 tracer-bullet 内化再进一步——Plan 的第一个 Task 结构化为"走通骨架"（walking skeleton），完成后给用户一次轻量可运行确认点
- **终端用户验收走查（UAT）**：Delivery Review 之后、Finish 之前加一个用户亲手走查核心 Scenario 的环节（UI/交互类强制，其他可选）。当前 Acceptance 是 TE（AI）从 Spec 视角验收的——**"按预期"的最终裁判应该有一个回合交还给用户本人**

### 4.3 `approve` 不强制展示决策摘要，存在确认疲劳

`approve` 命令只写 `mode/approved_by`（`engine.ts:606-632`），展示什么给用户完全靠会话 AI 自觉。逐章节确认 + 三个批准点 + worktree/profile 选择叠加，长会话中用户会机械性通过。而 Requirements 的"次要细节保守假设"（`skills/rockspec-requirements/SKILL.md:46-49`）——**恰恰是没聊清楚的部分**——如果不显式呈现，就是走样的暗渠道。

**联动发现：Proposal 完全没有机器校验**。`packages/protocol/src/spec.ts` 只解析 `specs/**/*.md`；Spec Gate 对 `proposal.md` 的检查只有存在性 + `assertMaterialized`。**范围、非目标、假设、开放问题的模板结构完全不进 Schema**——而 Proposal 恰恰是"聊清楚"过程的结构化沉淀。假设清单如果要进批准摘要，Proposal 必须先有结构化 Frontmatter（如 `assumptions: [{description, basis, impact_if_wrong}]`、`open_questions: [{id, blocking}]`），否则摘要只能靠 AI 现场归纳，又回到自觉问题。

**建议**：批准前强制生成"批准摘要"：关键决策、非目标边界、**假设清单（含错误影响）**、开放问题、新增 MUST 数。可以在 CLI `approve` 输出或 Skill 契约中固化，并把"Proposal 最小结构化"并入同一工作项。

### 4.4 compact authoring 的模式判定权在 AI

compact 模式（反馈可直接转 Scenario，只做一次合并确认）是否可用的判定由 AI 做——若 AI 误把含产品选择的反馈判为 compact，用户只确认了合并结果而未做过选择（Engine 只验 `interaction_mode` 枚举与 authority 字段，不判语义，`schemas.ts:195-210`）。

**建议**：compact 准入加一条硬规则——凡引入新的用户可见行为即必须 full 模式；并在批准摘要中列出"本轮被判定为 compact 的反馈清单"供用户否决。

---

## 五、缝隙三：追踪链的最后一公里

### 5.1 Acceptance 的 Scenario→Test→Evidence 链未机器校验（严重）

README 诚实标注了"UT/IT/E2E 到 evidence 的完整追溯是 future work"，但这个优先级值得提前，因为它是核心闭环：

- `test-plan.md`/`test-report.md` 模板有覆盖矩阵，但 `AcceptanceDocumentSchema`（`schemas.ts:777-798`）只验 verdict/execution/commit/findings
- `assertFreshEvidence`（`engine.ts:3721-3764`）只要求**存在一条**当前 commit、exit 0 的 executed evidence——**不校验是否覆盖每个 Scenario**
- `recordEvidence` 固定 `scenario_ids: []`（见 S3）

也就是说：TE 可以在弱测试 + 空泛覆盖摘要下合法 PASS。Spec 写得再清楚，验收层也可能整体走过场。

**建议**：给 `test-report` 增加结构化 `scenario_coverage: [{scenario_id, test_ids, evidence_refs}]` Frontmatter，Engine 在 Acceptance Gate 校验每个非 `verification_only` 的 S 至少有一条绑定 executed evidence 的测试；`recordEvidence` 开放 `scenario_ids` 入参。这是把"按预期交付"从口号变成机器事实的**性价比最高的一步**。

### 5.2 D→Task 断链

Engine 校验 Design 的 D→R/S 覆盖（`engine.ts:3190-3243`）、校验 Task 的 R/S 覆盖（`:3492-3555`），但 `TaskDefinitionSchema`（`schemas.ts:446-495`）没有 `design_ids` 字段——**已批准的技术决策到代码只通过 R/S 间接传递**。实现绕开某条具体 Design Decision（行为上仍满足 R/S）时，四轴 Review 里"Design Compliance"只能靠 AI 阅读理解发现。

**建议**：Task frontmatter 增加 `design_ids`，Engine 校验全部 D 被 Task 覆盖（或显式标记 non-implementation decision）。

---

## 六、系统性风险（机制层，无法用小时级修复解决）

1. **AI 审 AI 的同源偏差**。身份隔离（不同 execution）≠ 认知隔离。Reviewer/Implementer/TE 大概率同模型家族，共享盲区与品味偏差；Strict 双 Reviewer 互不同 execution，但可能同模型——独立性对"相关性错误"无效。且 Strict 的双 Reviewer 只覆盖 Requirements/Readiness/Task/Delivery 四类，**Acceptance、Reconciliation、Knowledge Review 均为单 Reviewer**，Design Gate 没有双 Reviewer。**建议**：Adapter 的 model_policy 增加"Reviewer 与 Implementer 异模型家族"选项（至少 Strict 启用）；把校准协议里的"独占发现率"按模型组合分桶统计。

2. **Revision 分类的博弈空间**。`classification`/`authority_impact` 由 revision author（AI）声明，auto 续期由独立 Reviewer（也是 AI）确认边界不变。AI 存在把 `decision_change` 报成 `consistency_fix` 的动机（减少打扰、少一轮人工）。防线全在 AI vs AI 之间。**建议**：① auto 续期设频率上限（一个 Change 超过 K 次自动升级人工）；② 用户下次批准点强制展示"期间自动续期清单"（事后审计比事前批准便宜，且异常模式可见）。

3. **Lite 没有质量网**。Lite 跳过全部澄清/设计/评审/验收（`workflow.ts:12-14`；`engine.ts:1709-1767`），Triage 又是主会话 inline 判断、只能事后升级——一旦漏判（尤其叠加 S2 的 API 绕过），后续无结构化补救。**建议**：Lite 保留一个最小"预期对齐"步骤——brief 里一句话验收标准 + 用户确认（不是 Spec，一次交互）；并按 S2 把分级校验下沉 Engine。

4. **`allowed_paths` 是披露而非约束**（`engine.ts:3672-3705`）。合理（避免误杀辅助文件），但"无关改动混入"的发现完全依赖 Reviewer，Engine 对 `expanded_paths.length > 0` 无任何拒绝或显式 scope acceptance 要求。**建议**：至少在 Review Package 中要求 Reviewer 对每条 expanded path 给出相关性结论（结构化字段），保持"披露+判断"但让判断显式留痕。

5. **角色独立性的真实边界**。所有角色共享同一 Change Worktree 的磁盘，Reviewer 理论上可以主动读取 `.rockspec/changes/.../reviews/` 下的前序报告——当前没有文件系统 ACL、沙箱或工具层 deny。Engine 只能证明 execution_id 不同、报告 Hash 未篡改，**不能证明"未共享上下文"**。TE 不读 CR 结论、Reviewer 不读前序 Review，是提示词级纪律 + 身份记录，不是强制隔离。该环节应归入"依赖 AI 自觉"清单而非"引擎强制"清单。

---

## 七、新增高危发现（H1-H4）

| # | 发现 | 证据 | 说明 |
|---|---|---|---|
| H1 | **状态文件无防篡改根**：`change.yaml` 无签名/hash chain，`events.ndjson` 读取时不重放校验；与工作区共处的 AI 有写权限即可直接伪造合法 state/approval。且 mutation 先写 `change.yaml` 再 append event，append 失败时状态已落盘、审计缺事件 | `storage.ts:368-385`、`engine.ts:2254-2268` | **"用确定性状态机约束 Agent"是这套系统的立项动机**，这是核心威胁模型内的问题，不是边缘场景。完整密码学防篡改可不做，最小方案（state snapshot hash 写入 events 并读取时校验，或 event-first 写入）值得入路线图 |
| H2 | **Prototype evidence 只查 `kind === "ui.prototype"` 标签**：不验 source=executed、不验响应式/无障碍/交互三类证据、不绑报告 hash——错误消息声称的要求与实现不符 | `engine.ts:3766-3778` | "声称强制实际可绕过"的典型点 |
| H3 | **`max_review_rounds` 配置未接线**：硬编码 `review_attempts >= 3` 却报错 "exhausted its two fix reviews"，配置/阈值/文案三方漂移 | `engine.ts:493-497` vs `schemas.ts:1191-1193` | 小问题但属于"配置幻觉"类 |
| H4 | **Strict Stage Review 来源文件后续不做 freshness 检查**：Task/Delivery 有 `assertReviewSourcesFresh`，Spec/Implementation 审批的 `assertReviewFresh` 只查产品制品 hash，不复查 Reviewer source 文件是否被改写 | `engine.ts:2660-2680` | 削弱审计证据完整性 |

另：`BLOCKED`/`PAUSED`/`SUPERSEDED` 三个协议状态在 Engine 主流程中基本不主动进入，阻塞主要表现为结构化错误 + `blocked_by` + recovery 指示——实际是"线性状态机 + 外挂 blocker/recovery"，与文档的状态列表表述有落差，建议文档同步。

---

## 八、测试覆盖评估

### 8.1 已覆盖的关键质量路径（广度较强，约 29 个场景）

- Profile 与状态机：Lite 生命周期、Brief TODO 阻断、executed evidence、非法 Action、Gate premature、Lite→Standard 升级
- Approval/Hash/追踪：Spec 变化导致 stale、Design 缺 Scenario 覆盖、Design 绑定旧 Spec hash、Review 早于当前 Spec、空目录拒绝
- Revision/Reconcile：无旧人工基线不能 auto approve、两轮不收敛转人工、级联失效全链重批、Finding-bound recovery、Task suspend/resume、Reviewer independence、supersession、amendment
- Task/Evidence/Review：commit message、evidence、Acceptance→Delivery→Verify 顺序、scope-blocked、冻结 Brief、scope expansion、implementer 不能自审、review round
- DAG：环、producer/consumer、Scenario 覆盖
- Strict 缺第二 Reviewer source 失败、锁过期恢复、Worktree binding、Knowledge evolution 全链

### 8.2 元层面红旗：测试自己依赖 legacy PASS 旁路

测试 helper `passReview()` 对 Requirements/Readiness 写的正是**纯文本 PASS**（`engine.test.ts:80-92`）——**测试套件自己依赖 B2 旁路，意味着生产中结构化 Stage Review 路径从未被任何测试执行过**。移除 legacy 旁路时必须同步重写这些 helper；这既是工作量估计的依据，也解释了为什么旁路至今没暴露。

### 8.3 未覆盖的关键反例（按优先级）

- **P0**：verify 后 HEAD 漂移（S1 反例）；Engine API 分级绕过（S2 反例）；Evidence 语义（阻止 `process.exit(0)` 类命令）
- **P1**：evidence 日志篡改（`STALE_EVIDENCE_LOG`/`MISSING_EVIDENCE_LOG`/`INVALID_EXECUTED_EVIDENCE` 错误码无测试触达）；Strict 深度（同 reviewer ID、aggregate 与来源不一致、round 不一致、source 事后改写、Strict Acceptance 仍单 Reviewer 是否符合政策预期）；审批身份伪造（`approvedBy: "user"` 由 AI 调用、Reviewer 自报异 ID、直接编辑 `change.yaml` 注入 approval）；Prototype evidence 实质性（手工 `recordEvidence(kind: "ui.prototype")` 不能通过）
- **P2**：`allowed_paths` 硬边界；状态与事件日志原子性（`change.yaml` 写成功但 event append 失败）

---

## 九、终版行动清单

| 优先级 | 行动 | 成本 | 对应问题 |
|---|---|---|---|
| **P0** | `finish`/`archive` HEAD 封口 + 反例测试 | 1 小时 | S1 |
| **P0** | 4 处门禁旁路：Design 审批重跑覆盖校验、移除 legacy PASS（含重写测试 helper）、execution ID 与登记记录比对（建议全链 lineage）、TBD 占位 | 各小时级 | B1-B4 |
| **P0** | Acceptance `scenario_coverage` 结构化 + Engine 校验；`recordEvidence` 开放 `scenario_ids` 入参 | 1-2 天 | S3 + §5.1 |
| **P0** | Triage 分级校验下沉 Engine：`newChange` 接受 kind/risk 并拒绝降档 | 半天 | S2 |
| **P1** | Task `design_ids` + D 覆盖校验 | 小时级 | §5.2 |
| **P1** | 批准摘要机制（含 Proposal 最小结构化：assumptions/open_questions Frontmatter） | 小时~1 天 | §4.3 |
| **P1** | Finish 前用户 UAT 走查（UI 类强制） | 1 天 | §4.2 |
| **P1** | `max_review_rounds` 接线；Prototype evidence 实质化 | 各小时级 | H2、H3 |
| **P2** | 状态防篡改最小方案（event-first 或 snapshot hash） | 1-2 天 | H1 |
| **P2** | Triage 增加需求不确定性维度 → research/prototype 先行 | 半天 | §4.1 |
| **P2** | Lite 最小预期对齐；Revision auto 续期审计与上限；expanded_paths 结构化相关性结论 | 各半天 | §六.3、§六.2、§六.4 |
| **P3** | Reviewer 模型多样性策略 | 机制设计 | §六.1 |
| **P3** | **跑 3-5 个真实 Change 采集校准数据**（前序评审建议 #6，仍是最高杠杆） | 周级 | §十 |

---

## 十、战略性提醒

前序评审的"复杂度预算"问题（Standard 比 Superpowers 更重）至今未解，且**当前最大的项目风险不是设计缺陷，而是弃用**——流程越精密，中途放弃的成本越高。这套设计已经到了"纸面继续加机制"边际收益急剧递减的点：

- **先修 P0（合计约一周内），然后立刻开跑真实项目**，刻意选小而真实的需求
- 校准数据回答的那个问题比任何纸面评审都值钱：**五道关卡里哪一道抓到的问题最少？**（校准协议已定义"独占发现率"，机制齐备，缺的只是样本）
- "预期"有三个载体：**Spec（说的）、测试（验的）、用户体验（感受的）**。当前流程对前两者的保障在修完 P0/P1 后是真实强的；第三个载体目前只有 UI Prototype 覆盖了一角——UAT 走查（P1）是它的兜底。

---

## 附：证据索引（关键文件与行号）

| 主题 | 位置 |
|---|---|
| Action×Profile×State 合法性 | `packages/engine/src/workflow.ts:12-64,503-526` |
| approve 语义与 Design 审批前置 | `packages/engine/src/engine.ts:606-632,2591-2617` |
| Design 覆盖校验（仅 complete 时） | `packages/engine/src/engine.ts:434-442,3190-3243` |
| legacy PASS 旁路 | `packages/engine/src/engine.ts:4102-4131` |
| 占位检测（TODO 不含 TBD） | `packages/engine/src/engine.ts:2682-2714` |
| Stage Review schema（execution ID 弱校验） | `packages/protocol/src/schemas.ts:741-775` |
| finish/archive 不封口 HEAD | `packages/engine/src/engine.ts:1789-1863` |
| newChange 不校验风险分级 | `packages/engine/src/engine.ts:153-157`；`packages/protocol/src/profile.ts:71-121` |
| recordEvidence 固定空 scenario_ids | `packages/engine/src/engine.ts:1283-1300` |
| assertFreshEvidence（仅 exit 0 + commit 匹配） | `packages/engine/src/engine.ts:3721-3764` |
| AcceptanceDocumentSchema | `packages/protocol/src/schemas.ts:777-798` |
| TaskDefinitionSchema（无 design_ids） | `packages/protocol/src/schemas.ts:446-495` |
| Prototype evidence 标签化 | `packages/engine/src/engine.ts:3766-3778` |
| max_review_rounds 未接线 | `packages/engine/src/engine.ts:493-497`；`packages/protocol/src/schemas.ts:1191-1193` |
| 状态读取无防篡改校验 | `packages/engine/src/storage.ts:368-385`；`packages/engine/src/engine.ts:2254-2268` |
| allowed_paths 三清单披露 | `packages/engine/src/engine.ts:3672-3705` |
| 测试 helper 纯文本 PASS | `packages/engine/test/engine.test.ts:80-92` |
| Requirements 保守假设规则 | `skills/rockspec-requirements/SKILL.md:44-50` |
| Lite Action 集 | `packages/engine/src/workflow.ts:12-14`；`skills/rockspec-change/references/change-recipe.yaml:44-55` |
| 编排契约（提示词级隔离） | `skills/rockspec-change/references/orchestration.md:12-33` |
