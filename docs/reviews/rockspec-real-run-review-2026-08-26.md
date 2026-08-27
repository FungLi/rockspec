# RockSpec 真实运行复盘：翻译单候选 Change（2026-08-26）

> 日期：2026-08-26
> 性质：基于一次**完整真实使用**的流程复盘，非代码静态审查
> 素材来源：codex 会话 `01a039b8-d55a-7ea2-89de-1be4a91905ec`
> 被观察的 Change：在 `ai-service` 里把翻译「候选 agent → 校验 agent 串行」改成「单候选 → 服务端硬校验 → 失败时定向修正一次」
> 流程覆盖：triage → requirements → design → plan → implement → review → acceptance → Final CR → verify → knowledge → push（全闭环，Standard Profile）
> 观察方法：逐条解析会话 228 条消息 + 时间戳对齐压缩事件 + 对照 rockspec 源码定位根因
> 会话规模：25MB / 4140 行 / 6 个上下文窗口

---

## 一、结论摘要

这是一次成功的端到端交付，流程本身运作正常。但从**质量保证、效率、成本**三维度看，暴露出若干可优化点，且多数可精确定位到代码/文档。核心发现：

1. **质量门时序倒挂**：真正的实现缺陷（类型契约、测试位置）拖到最贵的 Final CR / Readiness 复审才暴露，滚成三轮返工。
2. **Reviewer 可能"假 PASS"**：一次 reviewer 拿错包路径、没看到代码就给了结论（会话 [108]）。
3. **schema/frontmatter 格式错误反复打断**：至少 7 次因产物格式被 Engine 拒绝重试，是全程最高频的摩擦。
4. **主上下文消耗过快**：单个 Change 烧 6 个窗口，被迫 6 次手写 handoff——根因是压缩触发，且 handoff 内容多为 Engine 已持久化状态的冗余重述。
5. **只读侦察工作未外包**：评审/验收/实现已强制隔离子上下文，但 design/debug/research 的只读核对仍留在主循环，是烧上下文的元凶之一。**（本项已修复，见第五节）**
6. **push 处置"记录决策 ≠ 实际执行"**：Engine 只记录了 push 决策，未真正发布 git ref，靠 agent 手动补推（会话 [218]）。

---

## 二、开发质量保证维度

### 2.1 质量门时序倒挂（成本放大源头）

产品代码缺陷不是在 task review 抓到，而是拖到末端：

- 会话 [134]：**Final CR** 才发现运行时工厂类型契约仍暴露已移除的 validator 依赖 → 触发 RV-001。
- 会话 [144]：**Readiness 复审** 才发现负向测试放在 `tests/` 不被 worker TS build 编译，`@ts-expect-error` 根本没生效 → 触发 F-003 → 新增专用 tsconfig。

两者都是**可判定的机器规则**（"被删除的符号不得再出现在导出类型签名"、"类型/负向断言测试必须落在被编译路径内"），却靠人肉 reviewer 在最贵阶段发现。一个小类型问题滚成 RV-001 → T-003 → F-003 三轮收敛。

**建议**：把这类规则前移到 Engine 结构校验或 task brief 的强制 checklist，让 plan 的 readiness gate 或 task review 阶段就能拦截。

### 2.2 Reviewer 输入包未强制核对 → "假 PASS"（严重）

会话 [108]："T-001 首次 reviewer 没拿到引擎实际生成的包路径，因此没有评审代码，结论不代表实现问题。"

Engine 生成的 review package 有 hash 绑定（`engine.ts:4539` 附近的 Frozen Implementer Projection），但**没有校验 reviewer 实际消费的输入就是那个冻结包**。reviewer 可在没看到冻结代码的情况下给出结论，直接动摇整套治理的可信度。

**建议**：评审登记（`execution start ... --context-hash`）时强制核对输入包 hash，路径/hash 不符直接拒绝登记，而非接受空洞通过。

### 2.3 语义精度需机器辅助

知识评审阶段 [205][207] 抓到候选把"**必须**修正一次"弱化成"**可以**修正"。模态动词强弱直接改变契约含义。

**建议**：对保留原始决策的 MUST/EXACTLY 等模态语义做轻量规则校验。

---

## 三、开发效率维度

### 3.1 schema/frontmatter 格式错误反复打断（最高频痛点）

至少 7 次因产物格式被 Engine 拒绝再试：

| 会话 | 被拒原因 |
|---|---|
| [60] | `proposal.md` 的 assumptions 要对象数组，写成字符串列表 |
| [62] | context-package 路径要 change-relative，给了绝对路径 |
| [127] | 验收报告 frontmatter 与当前 schema 不匹配 |
| [135] | `owner_domain` 写成 `acceptance`，应为 `testing` |
| [145] | `owner_domain: plan`，应为 `planning` |
| [206] | `evidence` 写成数组，schema 只接受字符串 |

**根因（已在代码确认）**：Engine 校验失败时直接抛 zod 的 `result.error.issues` 原样（`engine.ts` 十余处 `issues: result.error.issues`），而 CLI 已有的 "Did you mean one of ..." 候选提示（`rockspec.mjs:8512`）**只作用于命令行参数，不作用于产物 schema**。agent 每次都得靠经验猜枚举值和字段类型，猜错就是一次往返。

**建议（ROI 最高，三层次）**：
- 最低成本：artifact 校验失败时也走候选值/did-you-mean（枚举字段列出合法值，类型错误说明期望类型），复用已有 `similar` 逻辑。
- 中等：`rockspec validate` 支持产物级 dry-run，让 agent 在提交 gate **之前**本地自检。
- 最好：产物模板内联 schema 注释和枚举合法值示例，从源头减少猜测。

### 3.2 信噪比偏低

从 [51] 到 [219] 近 170 条助手消息，真正的产品决策交互只有几次审批 + 最后 push。其余大量是路径修正、frontmatter 对账、重试。流程治理开销盖过业务决策本身。

---

## 四、开发成本维度

### 4.1 单个 Change 吃满主上下文，6 次 handoff

会话 [78][102][130][149][208] 等出现 6 次几 KB 的 handoff 长文。

**根因（时间戳证实）**：6 次 handoff 的时间戳与 codex `compacted` 事件**逐毫秒对齐**（如 HANDOFF@08:08:44.657 ↔ compacted@08:08:44.728）。即 handoff **不是 agent 多此一举，而是每个窗口写满触发压缩时被迫产出的续接摘要**。单 Change 生命周期烧了 6 个窗口。

**关键浪费**：对比 handoff 全文与 Engine 持久化字段，handoff 里几乎每项都是 Engine 已存的（change ID、worktree、分支、已完成 commit、开放 Finding F-001~F-005、recovery RV-001、产物路径、下一动作）。agent 在**手工把 Engine 状态重新序列化**，纯冗余，且有失真风险（如把 MUST 写成 CAN）。

**建议（三层次）**：
- **层次一**：给 Engine 加 `rockspec status --view resume`，直接输出可续接快照（当前 change/gate、已批准契约、开放 Finding、recovery、下一动作、worktree 风险）。压缩后新窗口跑一条命令即恢复全部治理状态，且是权威的、hash 可核的，不靠记忆重述。落点：`program.ts:404` 的 `STATUS_VIEWS`。
- **层次二**：从源头压低消耗——把 3.1 的 schema 往返减掉，把只读侦察外包（见第五节）。
- **层次三**：skill references 约定：压缩/handoff 时**不重述 Engine 已持久化状态**，只引用 `--view resume` 输出 + 补充 Engine 不知道的东西（用户口头约束、决策意图，如 [72] 要求 prompt 强化基于真实 beta 会话）。

### 4.2 remediation 循环放大末端成本

一个类型契约小问题滚成 RV-001 → T-003 → F-003 → 加 tsconfig，三轮才收敛（[134]→[137]→[144]→[146]）。与 2.1 同源，质量门前移可直接砍掉。

### 4.3 push 处置：记录决策 ≠ 实际执行

会话 [218]："远端查询没返回该分支引用，说明该处置只记录决策、未实际发布 git ref。"最后 agent 手动补 `git push`。

**建议**：finish 阶段要么 Engine 真正执行 push 并回填远端 SHA，要么在返回处置结果时明确"仅记录决策、需自行推送"。当前靠 agent 兜底，存在静默失败风险。

---

## 五、已落实：只读侦察外包（B 方案）

### 5.1 问题定位

对照所有 skill 的"侦察工作是否外包"：

| Skill | 侦察密集 | 原规定 | 原外包状态 |
|---|---|---|---|
| review / acceptance / implement | 是 | `execution start --context-package` 隔离，不继承父会话 | ✅ 强制外包 |
| design | 是 | 第1步全程主循环读事实 | ❌ 无外包 |
| debug | 是 | "首版保持 Inline，不创建 Subagent" | ❌ 禁止外包 |
| research | 是 | "首版保持 Inline，不创建后台 Research Subagent" | ❌ 禁止外包 |

规律：正式 Gate 全部强制隔离，而三个上游侦察阶段无约束或明确禁止。原设计的顾虑（迭代诊断/用户决策不该盲目外包）是对的，但**把"决策性侦察"和"一次性只读核对"混为一谈**——后者（如会话 [81] 读一堆代码确认硬校验覆盖范围，过程几万 token 结论一句话）恰恰是烧上下文的元凶，且外包零风险。

### 5.2 已做改动

统一判据：**「只读 + 单次 + 无需用户 Authority」→ 可外包；迭代 / 有中间态 / 需拍板 → 保持 Inline**。

- `skills/rockspec-debug/SKILL.md:14-15`：拆成"迭代诊断保持 Inline" + "一次性只读事实核对可外包"。
- `skills/rockspec-research/SKILL.md:17-18`：拆成"研究编排与用户协作保持 Inline" + "只读事实检索可外包"（守住"业务决策归用户"）。
- `skills/rockspec-design/SKILL.md:43`：第1步补充只读 Subagent 核对，主上下文只留结论 + `file:line`。
- `tests/host-assets.test.ts`：3 处断言更新，锁住新语义。

验证：`validate:skills` 14/14、`build:release` 分发副本同步且旧文本清除、`pnpm test` 141/141 全通过。

---

## 六、优先级建议（剩余未落实项）

| 优先级 | 项 | 维度 | 落点 | 风险 |
|---|---|---|---|---|
| P0 | schema 报错候选值 + 产物级 dry-run（3.1） | 效率 | Engine 报错格式化 + CLI validate | 低 |
| P0 | `status --view resume` 消灭手写 handoff（4.1 层次一） | 成本 | `program.ts:404` + engine 投影 | 低（纯增量） |
| P1 | reviewer 输入包 hash 强制核对（2.2） | 质量 | `execution start` 校验 | 中 |
| P1 | 质量门前移，机器规则拦截（2.1） | 质量/成本 | plan gate / task brief checklist | 中 |
| P2 | push 真正执行或明确告知（4.3） | 成本 | finish 阶段 | 低 |
| P2 | 模态语义校验（2.3） | 质量 | knowledge/review 校验 | 中 |

**A 方案（未落实，留待 B 验证后）**：给 `EXECUTION_ROLES`（`packages/protocol/src/constants.ts:69`）加只读 scout/investigator 角色，让侦察外包成为受治理、可追踪 token 的一等公民，并接上 token telemetry 反向检查"外包泄漏"（主 agent 侧 token 远高于子 agent 侧即为泄漏信号）。
