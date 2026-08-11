---
name: rockspec-requirements
description: 为 RockSpec Change 创建、细化、导入并独立评审业务需求和行为 Spec Delta。用户提供想法、Brief、PRD、Issue 或现有需求，需要转换为可测试的 Requirement 与 GIVEN/WHEN/THEN Scenario，或 Engine 推荐 requirements.clarify、requirements.review 或 Spec 审批时使用。
---

# RockSpec 需求

只产出一个结果：经过评审、可供用户确认的行为需求基线。

## 选择模式

- 活动 Change 合法允许 `requirements.clarify`、`requirements.review` 或 `approve.spec` 时使用 **Attached（挂接）** 模式。只写入声明的产物，并通过 CLI 提交结果。
- 用户提供外部 PRD、Issue、Brief 或对话，且没有受治理 Change 时使用 **Standalone（独立）** 模式。保留来源归属，将输出和 `receipt.yaml` 写入 `.rockspec/workbench/requirements/<slug>/`，并设置 `governed_change: false`。

## 执行

1. 从磁盘重新读取 Brief 或外部来源、基线 Spec 和已有需求产物；不要依赖聊天记忆。检查可观察的当前行为和领域术语。
2. 识别会实质改变范围、外部可观察行为、兼容性或验收标准的歧义。只有这类歧义才阻塞并向用户提问；每次只问当前最重要的一个问题。次要细节采用最保守的合理假设，并记录依据和假设错误时的影响。
3. 分离业务行为与实施选择，记录目标、范围、非目标、假设和开放问题。不得用假设掩盖实质歧义；将开放问题标记为阻塞或非阻塞。
4. 编写 Proposal 和 Spec Delta。强制使用英文关键字 `ADDED/MODIFIED/REMOVED/RENAMED`、`Requirement`、`Scenario`、`MUST/MUST NOT`、`GIVEN/WHEN/THEN`；解释性正文可使用项目语言。
5. 为每个 Requirement 提供至少一个可测试 Scenario，并使用稳定的 `R-`/`S-` ID。覆盖成功、失败、边界和兼容行为中与需求相关的部分。
6. 调度规定数量的独立 Reviewer 前，按 `requirements.review` 的 `model_policy` 从 Brief、Spec 和 Profile 选择 Tier，再由当前 Host Adapter 映射并显式指定模型。不得低于 `minimum` 或静默使用更弱 Tier；Strict 的两个 Reviewer 使用同一 Tier。保持 Reviewer 只读、与作者隔离且不得委派。Reviewer 提出变更后，重新读取磁盘产物并修订，不得只在对话中解释。
7. Attached 模式依次提交 `requirements.clarify` 和 `requirements.review`，随后为绑定 Hash 的 Spec 审批暂停；绝不替用户审批。

可从 [proposal.md](assets/proposal.md) 和 [spec.md](assets/spec.md) 起草产物。对应工作前读取 [action-requirements.clarify.yaml](references/action-requirements.clarify.yaml)、[action-requirements.review.yaml](references/action-requirements.review.yaml) 和 [role-requirements-reviewer.md](references/role-requirements-reviewer.md)。

报告来源、产物、评审结论、审批状态、开放问题，并将 `$rockspec-design` 作为通常的下一能力。
