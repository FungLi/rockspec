# RockSpec Standard 流程耗时分析与 Profile 裁剪建议

> 日期：2026-08-23
> 性质：主评审报告（`rockspec-workflow-design-review-2026-08-23.md`）的补充——响应真实使用体感
> 触发输入：真实用户反馈——**"任何一个中小规模的需求，可能都要跑个 3~4 个小时"**，宿主 Codex，模型 `gpt-5.6-terra`
> 关联：主报告 §十"战略性提醒"（复杂度预算）、前序评审（2026-08-11）第七点"复杂度预算"、`docs/reference-designs/calibration-protocol.md`

---

## 一、结论摘要

1. **慢的大头不是模型，是流程结构。** 当前 Codex Adapter 的 tier 映射中 `fast` 与 `balanced` 均为 `gpt-5.6-terra`（仅 reasoning effort 不同，low/medium），`deep` 为 `gpt-5.6-sol` + high（`adapters/codex/adapter.yaml:38-47`）。模型分层已经做了，继续压模型收益有限。
2. **这条体感就是校准协议等待的第一份真实数据。** 技术方案规定"Profile 裁剪必须基于 3-5 个真实 Change 数据"——现在第一个真实用户的数据来了：Standard 对中小需求过重。应记入校准记录：`Standard 单 Change 3-4h（gpt-5.6-terra，约 5 tasks）`。
3. **建议新增 Express 档**（`lite → express → standard → strict`），砍掉 4 道 AI 关卡、保留全部机器校验与 Task Review，预计将中小需求耗时压到 1-1.5 小时。

---

## 二、3~4 小时的构成拆解

一个约 5-task 的 Standard 中小需求：

| 时间构成 | 量级 | 性质 |
|---|---|---|
| Interactive 需求澄清 + 设计逐章节确认 + 3 个人工批准点 | 30-60 min | **用户在回路**，无法后台化，切换成本真实存在 |
| Stage Review ×3（Requirements / Readiness / Knowledge）+ TE + Delivery Review | 5 次 subagent 冷启动 | 每次都要重新读产物与仓库上下文 |
| 5 × (Implementer TDD：读上下文 → 写测试 → 跑失败 → 实现 → 跑通过 → commit) + 5 × Task Reviewer + 修复轮 | 10-15 次调度 | **fresh context 税是最大隐藏成本**：每次 subagent 冷启动重新建立仓库理解 |
| 全量 verify（完整测试套件 + 构建 + lint） | 5-15 min | 一次性 |

合计 **15-20 次 subagent 调度，每次冷启动**。结构性成本（fresh context、串行链、关卡数量 × 每道一个独立 subagent）远大于单次推理成本。

速度与独立性的根本张力：fresh context 是"角色独立性"的代价。中小需求的正确取舍是**保留最值钱的一道独立审查（Task Review），砍掉边际收益低的 stage 审查**。

---

## 三、各关卡对中小需求的边际收益

| 关卡 | 边际收益 | 分析 |
|---|---|---|
| Requirements Review | **低** | interactive 模式下 Spec 已经过用户逐章节确认——Spec 本身就是用户确认的产物。AI Reviewer 再审一遍，抓到的主要是格式/可测性问题，与用户确认存在覆盖 |
| Readiness Review 的 AI 部分 | 低 | **机器校验（DAG 无环/R-S 覆盖/接口 producer-consumer）便宜且有值，应保留**；AI 审任务粒度的部分边际收益低 |
| Task Review | **高** | 代码质量主防线。四轴审查（Spec/Design/Standards/Tests）+ Review Package 固定 Diff + 修复循环，是全流程对"实现不走样"贡献最直接的一道 |
| TE 独立验收 | 低-中 | Task Review 已四轴审过（含测试质量轴）；中小需求补集成/E2E 的价值密度低，且 TE 是一次完整 subagent 循环（写测试 + 跑 + 报告） |
| Delivery Review | 中 | 全量终审有价值（覆盖 TE 资产与修复），但中小需求可用快模型或与最终 verify 合并 |

---

## 四、建议方案

### 4.1 新增 Express 档（正式解法）

升级链变为：`lite → express → standard → strict`（保持只升不降）。

```text
Triage → 简式 Spec（一次合并确认，不做逐章节；含一句话验收标准与假设清单）
      → Plan（机器校验 DAG/覆盖/接口全保留；无 AI Readiness Review）
      → 每 Task：Implementer + Task Review（TDD、executed evidence、单 Commit 全保留）
      → 最终 verify + 用户快速 UAT 走查 → finish
```

**保留**：全部机器校验（Spec 解析、Design 覆盖、Task DAG、证据绑定——这些是零边际成本的确定性保障）、Task Review、用户确认点、风险自动升级。

**砍掉**：Requirements Review、AI Readiness Review、TE 独立验收、Delivery Review、knowledge.evolve 独立 Review（降为 inline 记录）。

**AI 审查关卡从 5 道降到 1 道，subagent 调度从 15-20 次降到 8-12 次。**

预计耗时：3-4 小时 → **1-1.5 小时**。

实施落点：
- `packages/engine/src/workflow.ts`：`ACTION_PROFILES` 增加 express 集合
- `packages/protocol/src/profile.ts`：triage 规则增加 express 档准入（介于 Lite 8 条与 Standard 之间）
- `packages/protocol/src/schemas.ts`：profile 枚举扩展
- `skills/rockspec-change/references/change-recipe.yaml`：express 编排
- 测试：express 生命周期 + 升级路径

预估工作量 1-2 天。

### 4.2 放宽 Lite 准入 + Lite 最小预期对齐（先做，本周可用）

当前 Lite 准入 8 条全满足过于严苛，且 Lite 无任何预期对齐（主报告 §六.3）。两者一起改：

- Lite 准入从"8 条全满足"放宽为"核心 3 条"（无鉴权/支付/迁移类高风险 + 范围局部 + 有明确验证方式）
- Lite Brief 增加一句话验收标准 + 用户一次确认

预估半天。

### 4.3 不改代码、当天可用的缓解

1. **中小需求主动声明走 Lite**（明确告知 Triage 不必保守升级）
2. **Interactive 确认合并**——协议明确允许"简单内容将相邻章节合并成一个短确认"，用户主动要求可砍掉约一半在回路时间
3. **不需要治理轨迹的改动用 Standalone 模式**（如 `$rockspec-implement` 从已有 diff 开始），产物进 workbench、不进 Engine

### 4.4 不建议的方向

- **牺牲 Task Review 的独立性换速度**（implementer/reviewer 复用上下文）——Task Review 是砍掉其他关卡后仅存的代码质量防线，独立性是它的价值来源
- **Task 并行化**——中小需求 task 数少，收益有限而复杂度高（技术方案已将其列为有严格前置条件的未来项）

---

## 五、行动选项与推荐

| 方案 | 工作量 | 效果 |
|---|---|---|
| B. 放宽 Lite 准入 + Lite 最小预期对齐 | 半天 | 马上缓解，Lite 从"太裸"变"够用" |
| A. 实现 Express 档 | 1-2 天 | 正式解法，3-4h → 1-1.5h |
| C. 调 tier 映射（fast 换更快模型） | 小时级 | 收益有限（结构成本是大头） |

**推荐顺序：B 先做，A 跟上。** 同时将本次体感记入校准数据（`docs/reference-designs/calibration-protocol.md` 的样本要求：每轮记录宿主与模型映射——本条即首个样本：Codex + gpt-5.6-terra，Standard，~5 tasks，3-4h）。

---

## 六、与主评审报告的关系

本建议不与主报告 P0 清单冲突：**先修 P0 旁路（约一周内）仍是第一优先**——速度优化改变的是关卡数量，P0 修复保证留下来的关卡是真的。两者可并行：Express 档的机器校验（DAG/覆盖/证据）恰好全部落在 P0 加固的引擎能力上。
