---
name: rockspec-4class-testing
description: RockSpec 四类测试能力单元；独立验收的测试覆盖纪律——A-API 契约、B-真实浏览器端到端、C-回归、D-工程（构建/类型/lint/validation），每个 Scenario 都要有可执行证据映射。当前由 TE 使用。
---

# 四类测试（能力单元）

这是独立验收时的测试覆盖纪律，当前由 TE 使用。角色 skill 引用本能力，只补充**独立性要求与 FAIL 路由**。共享结构引用 [rockspec-glossary](../rockspec-glossary/SKILL.md)。

## 只对冻结的验收 Subject 执行

只对 PM 用 `rockspec brief` 冻结的验收 Subject 执行；每个 Scenario 都要有可执行证据映射，不留无证据的口头结论。

## 四类测试

- **A — API 测试**：接口级验证请求/响应、错误码、边界与契约，覆盖需求的 R/S。
- **B — 真实浏览器测试**：真实浏览器端到端跑关键用户路径（非 mock、非 headless 假跑），验证真实交互行为。
- **C — 回归测试**：跑既有测试套件确认无回归，改动未破坏原有行为。
- **D — 工程测试**：构建、类型检查、lint、`validation_commands` 退出码为 0，无未提交产物。

## PASS 门槛

`verdict: PASS` 要求四类测试全绿、每个 Scenario 有证据、无 open critical/important；否则判负并至少一条 open finding。
