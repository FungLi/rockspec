# PM 编排重构 · 执行计划与进度追踪

> 依据：[pm-orchestration-rearchitecture.md](./pm-orchestration-rearchitecture.md)
> 目标：交付一个**完整可用**的新版本（PM 编排 + 对抗制衡 + 确定性 Hook），除「评测章节（P6 eval）」外全部完成。
> 策略：新建 `@rockspec/ledger` 包**并行构建**，不推翻现有 engine（保可回退、保 146 测试绿）；新版自成体系、可跑可测。

## 交付物清单（Definition of Done）

一个能跑通「起一个 change → BA/SA inline 共创 → RR 评审 → Dev 隔离实现 → CR/TE 制衡 → hook 检测 → Finish 不变式 → 归档」全链路的 CLI + skill 集，且：
- `pnpm build` 通过、新增测试全绿、不破坏现有 146 测试。
- `rockspec` CLI（新命令空间，避免与老 engine 冲突）可跑通全链路。
- 7 角色 prompt + PM 编排 skill 齐备。
- Hook 层可对各产物类型做确定性检测并打 mark。
- Finish 不变式作为唯一硬门生效。

## 阶段与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Ledger 骨架：数据模型 + 追加式存储 + Worklist/resume 投影 | ✅ |
| P1 | Hook 层：`check` 命令 + 各产物确定性检测集 + mark | ✅ |
| P2 | 结论协议：生产者/制衡者结论 schema + subject_hash 校验 | ✅ |
| P3 | PM 编排 skill：控制循环 + inline/隔离双模式 + 打回路由 + 折叠 | ✅ |
| P4 | Finish 不变式：唯一硬门 | ✅ |
| P5 | 放漂分级 + model tier 门 | ✅（L1/L2/L3 已实现；model tier 字段已建模，强制校验留待接入 host adapter） |
| — | 角色 prompt：8 个（PM/BA/SA/RR/Dev/CR/TE + glossary） | ✅ |
| — | CLI 组装 + 端到端冒烟测试 | ✅ |

（P6 eval 按要求不做。）

## 交付验证（2026-08-27）

- **新包 `@rockspec/ledger`**：types/storage/projection/hooks/conclusions/ledger/render/program/bin，全量 `pnpm build` + typecheck 通过。
- **测试**：ledger 9 + skills 4 = 13 个新测试全绿；全量 **159 passed / 15 files**，旧 engine 146 测试零回归。
- **CLI `rockspec`**：端到端冒烟跑通 `new → making(inline) → check(hook) → conclude-maker → conclude-checker(PASS) → finish-check → finish → archive`，并实测 subject_hash 防假 PASS 拦截、L3 放漂免语义制衡。
- **8 个 rockspec-* skill**：PM 编排 + 6 角色 + 词汇表，frontmatter 合规。
- **旧体系隔离**：host-assets 测试排除 rockspec-* 前缀，新旧并存互不干扰。

## 完全重写：删除旧体系（2026-08-27）

按用户「不要兼容代码」要求，在分支 `feat/pm-orchestration-rewrite` 上删除全部旧引擎体系：

- **删包**：`packages/{protocol,engine,cli,capabilities,installer}`。
- **删旧 skill**：14 个 `skills/rockspec-*`。
- **删分发/脚本**：`adapters/`、`distribution/`、`scripts/build-runtime.mjs`、`scripts/build-cli-release.mjs`、`tests/host-assets.test.ts`。
- **ledger 自包含**：hash/change-id/markdown 工具内联为 `packages/ledger/src/util.ts`，切断对 protocol 的依赖；ledger 现只依赖 yaml/zod/commander。
- **重写配置**：根 `package.json`（bin→ledger、删旧 scripts、移除 esbuild）、`.claude-plugin`/`.codex-plugin`（改指 rockspec-*）、`README.md`（新架构说明）。

验证：`pnpm build` + `pnpm typecheck` 通过；`pnpm test` 13 passed（旧 146 测试随删除消失，符合预期）；`rockspec` CLI 端到端可用；全仓库无 `@rockspec/{protocol,engine,cli,capabilities,installer}` 引用残留。规模：138 删除 / 11 新增 / 5 修改。

## 已知边界（诚实记录）

1. **model tier 强制门**：`ModelTier` 已建模、放漂分级已实现，但「制衡者 dispatch 强制声明 tier 且校验不低于 minimum」需 host adapter 传入实际模型信息，当前留接口未强制。
2. **code 产物证据检测**：`evidenceCheck()` 已实现（校验 validation_commands 有绑定 commit 的成功证据），但需 CLI 侧接入 git + 执行记录才能在 `check code` 时自动跑；当前 `check code` 走文档层检测占位。
3. **Ledger 无并发锁**：仅追加事件用 `readEvents` 重算 seq，单进程安全；多进程并发需补文件锁（老 engine 的 storage.ts 有可复用实现）。
4. **未做分发集成**：rockspec-* skill 未接入 installer 的 host 分发（`.codex-plugin`/`.claude-plugin`）；作为独立可跑版本已完整，正式发布时需接入。

## 关键设计决策（落地时固定）

1. **新包 `@rockspec/ledger`**，不改老 engine/protocol 的运行逻辑（可复用其 hash/schema 工具）。
2. **CLI 命令空间 `rockspec <cmd>`**，与老 CLI 并存，交付后可择机切换为默认。
3. **Ledger 是仅追加事件日志 + 投影**，无状态机推进。
4. **唯一硬门 = Finish 不变式**：每个产物需 `制衡PASS + hook clean + subject_hash==current`。
5. 角色 prompt 放 `skills/`（复用现有 host-assets 分发机制）。

## 进度日志

- 2026-08-27：计划创建。
