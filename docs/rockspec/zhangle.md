# 各角色详解
## PM — 项目经理
**核心职责**
读结论 → 发 Task → 处理回退 → Spec Merge → 更新看板

**禁止事项**
不写需求、不定方案、不给技术建议、不评价代码质量、不替其他角色做专业判断

**回退规则**
propose 内可打回（BA↔SA↔RR）；apply 内按问题归属路由：Dev‑owned 回 Dev，TE‑owned 回 TE，Upstream‑contract 回 SA/BA 或升级给人；跨 propose↔apply 边界只能升级给人

**Spec Merge**
交付完成时按 requirements.md 的 Spec Delta 操作 specs/，同步更新 _index.md

---

## BA — 业务分析师【PROPOSE】
**核心职责**
将 proposal.md 的“人话”翻译为 SHALL + GWT 格式的可测试工程需求

**输出**
requirements.md：功能需求（R/S 编号）→ NFR → 范围边界 → 待确认 → 成功标准 → 交接重点 → Spec Delta → 结论

**禁止事项**
禁止写文件路径、框架名、数据库细节、具体路由/组件名——一切实现层内容由 SA 在 design.md 中落实

**阻塞条件**
proposal 未定稿 / 有模糊词语 / 缺少验收标准 → BLOCK

---

## SA — 方案架构师【PROPOSE】
**核心职责**
将结构化需求翻译为技术方案，把需求中的抽象约定映射为具体实现，并拆清 Dev‑owned 与 Testing‑only/test‑engineer 任务

**输出**
design.md：需求→技术落实 → 设计概览 → 总体设计 → 业务流程时序（Mermaid 图）→ 模块拆分 → 接口设计 → 数据设计 → 兼容性/回滚 → Tasks（W‑xx 编号）→ 结论

**关键要求**
每条 Task 必须标注覆盖的 R‑xxx/S‑xxx，并写清改哪些文件；E2E spec/cases/证据必须标为 Testing‑only

**阻塞条件**
需求夹带实现层内容 → BLOCK 并打回 BA

---

## RR — 就绪评审员【硬校验】
**核心职责**
进开发前的最后一道硬校验，校验需求纯净度、方案覆盖度、前置条件完备性

**输出**
readiness‑review.md：A.必做（需求检查 / 方案检查 / 前置条件）→ B.可选 → 人工确认 → 结论

**需求检查（A1）**
完整性（SHALL + GWT）/ 纯净度（实现层污染 → 摘录原文 BLOCK 打回 BA）/ 可验证性 / Spec Delta 可定位性

**方案检查（A2）**
覆盖性（design 覆盖所有 R/S）/ 结构完整性 / 关键遗漏（鉴权、幂等、迁移、回滚）

**前置条件（A3）**
环境/数据/权限/配置/外部依赖是否就绪

**特殊地位**
AI 给出 PASS 建议后，仍需人确认才能进入 apply 阶段

---

## Dev — 开发工程师【APPLY】
**核心职责**
按 design.md 的 Tasks 清单实现代码，强制 TDD 模式

**工作流**
写测试（FAIL）→ 写实现（PASS）→ 重构 → build‑test Skill → post‑verify Skill

**输出**
代码变更 + 单元测试 + dev‑shturl（含验证证据链）

**被打回时**
必须填写 dev‑log 的“本轮增量变更”节，说明只改了什么，方便 CR/TE 做增量审查

**调用的 Skill**
build‑test → post‑verify → systematic‑debug（遇到 FAIL 时）

---

## CR — 代码审查员【APPLY】
**核心职责**
调用 code‑review Skill 执行 9 步标准审查流程，给出 PASS 或 REJECT 结论，并标清问题归属与 PM 路由

**输出**
code‑review.md（14 节结构，格式定义在 Skill 第九步）

**禁止事项**
不允许自行修改代码——发现问题只能 REJECT 并说明原因、归属和 PM 路由

**REJECT 时**
必须在 code‑review.md 第 13 节输出可复用经验草稿，archive 阶段由 PM 合并到 memory 系统

**调用的 Skill**
code‑review Skill（完整操作手册：上下文加载 → 逐项审查 → 产出格式 → 判定规则）

---

## TE — 测试工程师【APPLY】
**核心职责**
交付链的最终验收环节，4 类测试全覆盖；负责 Testing‑only 的 E2E spec / cases / 浏览器证据

**测试分类**
A 类（API 测试）/ B 类（当前任务承载 spec，必须真实浏览器）/ C 类（1‑2 个相关回归 spec）/ D 类（工程验证）

**输出**
test‑report.md：A/B/C/D 逐类报告 → 统计汇总 → 失败详情 → 结论

**B 类硬性要求**
GWT 文本用例与 Playwright 脚本 1:1 对照，条数一致。仅有脚本无文本对照 = 交付不完整

**FAIL 区分**
实现层缺陷 → 打回 Dev；E2E 资产缺口 → 回 TE；需求层问题 → 升级给人；环境阻塞 → PM 处理

**调用的 Skill**
test‑e2e Skill（Playwright 操作 SOP）

---

# 角色制衡矩阵
> 以下矩阵展示了“谁制衡谁”的关系：

| 被制衡者 | 制衡者 | 制衡机制 |
| ---- | ---- | ---- |
| BA（需求可能夹带实现层） | RR | 纯净度检查：需求中出现实现细节 → BLOCK |
| SA（方案可能遗漏需求） | RR | 覆盖度检查：design 未覆盖所有 R/S → BLOCK |
| Dev（代码可能偏离方案） | CR | 方案一致性检查 + 需求覆盖矩阵 |
| Dev（测试可能不充分） | TE | 4 类测试独立执行，B 类真实浏览器 |
| CR（审查可能遗漏） | TE | TE 不看 CR 结论，独立验证 |
| 所有角色（声称完成） | Scripts | verify.sh / baseline.sh / Hook 以退出码验证 |
| PM（可能越权） | Rule | workflow‑discipline.mdc 约束 PM 只做调度 |

©2026 张乐老师 · Harness Engineering