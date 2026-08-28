---
name: rockspec-tdd
description: RockSpec 强制 TDD 能力单元；按 Task 严格执行红→绿→重构→build→post-verify 循环，测试落在被编译路径、validation_commands 退出码 0 且证据绑定当前 commit、不留未提交产物、删符号不残留在导出。
---

# 强制 TDD（能力单元）

这是按 Task 实现代码的执行纪律，当前由 Dev 使用。角色 skill 引用本能力，只补充**输入从哪来、硬约束是什么**。共享结构引用 [rockspec-glossary](../rockspec-glossary/SKILL.md)。

## 每个 Task 内的 TDD 循环

严格按顺序执行，不跳步：

1. **写测试 FAIL（红）**：先写覆盖该 Task 对应 Scenario 的测试，运行确认它因功能未实现而失败。
2. **实现 PASS（绿）**：写最小实现让测试通过，运行确认。
3. **重构**：在测试保护下清理实现，保持测试通过。
4. **build-test**：跑项目构建与相关测试套件，确认全绿。
5. **post-verify**：跑 Task 的 `validation_commands`，确认退出码为 0，证据绑定当前 commit。

## 测试真实有效的硬要求

- 测试文件必须落在**被编译/被执行的路径**内，否则等于没测。
- 断言必须真实（非空跑、非永真）。
- 被删除的符号不得出现在导出签名里。
- 不留未提交产物。

## 收尾自查

`validation_commands` 有绑定当前 commit 的 exit=0 证据、测试在被编译路径内、无未提交产物、无删符号残留在导出。产物落盘后 hook 自动触发 `rockspec check <task-id>` 跑确定性检测，失败当场改，不留到 CR/TE。
