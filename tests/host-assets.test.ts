import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ACTION_IDS } from "../packages/protocol/src/constants.js";
import {
  ACTION_PROFILES,
  WORKFLOW_APPROVAL_GATES,
  WORKFLOW_PRIMARY_ACTIONS_BY_PROFILE,
} from "../packages/engine/src/workflow.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();

describe("host assets", () => {
  it("publishes the orchestrator and composable capability Skills", async () => {
    const skills = (await readdir(path.join(root, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skills).toEqual([
      "rockspec-acceptance",
      "rockspec-change",
      "rockspec-debug",
      "rockspec-design",
      "rockspec-evolve",
      "rockspec-finish",
      "rockspec-implement",
      "rockspec-plan",
      "rockspec-prototype",
      "rockspec-requirements",
      "rockspec-research",
      "rockspec-review",
      "rockspec-triage",
      "rockspec-worktree",
    ]);
    expect(skills).not.toContain("ui-ux-pro-max");
    for (const skill of skills) {
      const skillRoot = path.join(root, "skills", skill);
      const body = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\n`, "m"));
      expect(body).toMatch(/[\u3400-\u9fff]/);
      expect(body).not.toContain("[TODO:");
      expect(body).not.toContain("rs-");
      const metadataPath = path.join(skillRoot, "agents", "openai.yaml");
      expect((await stat(metadataPath)).isFile()).toBe(true);
      expect(await readFile(metadataPath, "utf8")).toMatch(/[\u3400-\u9fff]/);

      const localReferences = [...body.matchAll(/\]\(((?:references|assets)\/[^)]+)\)/g)]
        .map((match) => match[1])
        .filter((reference): reference is string => reference !== undefined);
      for (const reference of localReferences) {
        expect((await stat(path.join(skillRoot, reference))).isFile()).toBe(true);
      }
    }
  });

  it("makes project-local Runtime resolution deterministic in every governed CLI Skill", async () => {
    const governedCliSkills = [
      "rockspec-acceptance",
      "rockspec-change",
      "rockspec-design",
      "rockspec-evolve",
      "rockspec-finish",
      "rockspec-implement",
      "rockspec-plan",
      "rockspec-prototype",
      "rockspec-requirements",
      "rockspec-review",
      "rockspec-triage",
      "rockspec-worktree",
    ];

    for (const skill of governedCliSkills) {
      const body = await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8");
      expect(body, skill).toContain(".rockspec/install.lock.yaml");
      expect(body, skill).toContain("rockspec.runtime_path");
      expect(body, skill).toContain("node <runtime_path> ...");
      expect(body, skill).toContain("禁止用 `command -v rockspec`");
    }

    const orchestration = await readFile(
      path.join(root, "skills", "rockspec-change", "references", "orchestration.md"),
      "utf8",
    );
    expect(orchestration).toContain("使用结构化 YAML 解析 `.rockspec/install.lock.yaml`");
    expect(orchestration).toContain("不得执行锁外入口");
    expect(orchestration).toContain("`node <runtime_path> <args>`");
    expect(orchestration).toContain("不得再尝试全局 `rockspec`");
  });

  it("keeps every internal Action inside exactly one owning Skill", async () => {
    const ids: string[] = [];

    const skills = await readdir(path.join(root, "skills"), { withFileTypes: true });
    for (const skill of skills.filter((entry) => entry.isDirectory())) {
      const skillRoot = path.join(root, "skills", skill.name);
      const referencesRoot = path.join(skillRoot, "references");
      const files = (await readdir(referencesRoot))
        .filter((file) => file.startsWith("action-") && file.endsWith(".yaml"))
        .sort();

      for (const file of files) {
        const document = parse(await readFile(path.join(referencesRoot, file), "utf8")) as {
          id?: string;
          kind?: string;
          authority?: string;
          engine_authority?: string;
          profiles?: string[];
          executor?: { role_prompt?: string; may_delegate?: boolean };
        };
        expect(document.kind).toBe("engine_action");
        expect(document.authority).toBe("agent-guidance");
        expect(document.engine_authority).toBe("packages/engine/src/workflow.ts");
        expect(document.id).toBe(file.slice("action-".length, -".yaml".length));
        if (document.id && document.id in ACTION_PROFILES) {
          expect(document.profiles).toEqual(ACTION_PROFILES[document.id as keyof typeof ACTION_PROFILES]);
        }
        expect(document.executor?.may_delegate).not.toBe(true);
        if (document.id) ids.push(document.id);
        if (document.executor?.role_prompt) {
          expect(document.executor.role_prompt).toMatch(/^references\/role-/);
          expect((await stat(path.join(skillRoot, document.executor.role_prompt))).isFile()).toBe(true);
        }
      }
    }

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...ACTION_IDS].sort());
  });

  it("adapts model strength only for the existing subagent Actions", async () => {
    const expectedAdaptiveActions = [
      "acceptance.validate",
      "delivery.review",
      "readiness.review",
      "requirements.review",
      "task.execute",
      "task.review",
    ];
    const observedAdaptiveActions: string[] = [];
    const policies = new Map<string, {
      strategy?: string;
      default?: string;
      minimum?: string | Record<string, string>;
      applies_to_profiles?: string[];
      fast_when_all?: string[];
      deep_when_any?: string[];
      record_selection?: boolean;
    }>();

    const skills = await readdir(path.join(root, "skills"), { withFileTypes: true });
    for (const skill of skills.filter((entry) => entry.isDirectory())) {
      const referencesRoot = path.join(root, "skills", skill.name, "references");
      const files = (await readdir(referencesRoot))
        .filter((file) => file.startsWith("action-") && file.endsWith(".yaml"));
      for (const file of files) {
        const document = parse(await readFile(path.join(referencesRoot, file), "utf8")) as {
          id?: string;
          executor?: {
            mode?: string | Record<string, string>;
            model_policy?: {
              strategy?: string;
              default?: string;
              minimum?: string | Record<string, string>;
              applies_to_profiles?: string[];
              fast_when_all?: string[];
              deep_when_any?: string[];
              record_selection?: boolean;
            };
          };
        };
        const modes = typeof document.executor?.mode === "string"
          ? [document.executor.mode]
          : Object.values(document.executor?.mode ?? {});
        const policy = document.executor?.model_policy;
        if (modes.includes("subagent")) {
          expect(policy, `${document.id} model policy`).toBeDefined();
          expect(policy?.strategy).toMatch(/^(auto|fixed)$/);
          expect(policy?.default).toMatch(/^(fast|balanced|deep)$/);
          expect(policy?.record_selection).toBe(true);
          if (document.id && policy) {
            observedAdaptiveActions.push(document.id);
            policies.set(document.id, policy);
          }
        } else {
          expect(policy, `${document.id} must stay outside adaptive routing`).toBeUndefined();
        }
      }
    }

    expect(observedAdaptiveActions.sort()).toEqual(expectedAdaptiveActions);
    expect(policies.get("task.execute")).toMatchObject({
      minimum: { standard: "fast", strict: "balanced" },
      applies_to_profiles: ["standard", "strict"],
    });
    expect(policies.get("task.execute")?.fast_when_all).toHaveLength(3);
    expect(policies.get("delivery.review")).toMatchObject({
      strategy: "fixed",
      default: "deep",
      minimum: "deep",
    });

    const codex = parse(await readFile(path.join(root, "adapters", "codex", "adapter.yaml"), "utf8")) as {
      models?: {
        fallback?: string;
        deep_unavailable?: string;
        tiers?: Record<string, { model?: string; reasoning_effort?: string }>;
      };
    };
    const claude = parse(await readFile(path.join(root, "adapters", "claude", "adapter.yaml"), "utf8")) as {
      models?: {
        fallback?: string;
        deep_unavailable?: string;
        tiers?: Record<string, { model?: string }>;
      };
    };
    expect(Object.keys(codex.models?.tiers ?? {}).sort()).toEqual(["balanced", "deep", "fast"]);
    expect(codex.models?.tiers?.fast?.reasoning_effort).toBe("low");
    expect(codex.models?.tiers?.balanced?.reasoning_effort).toBe("medium");
    expect(codex.models?.tiers?.deep?.reasoning_effort).toBe("high");
    expect(Object.keys(claude.models?.tiers ?? {}).sort()).toEqual(["balanced", "deep", "fast"]);
    expect(claude.models?.tiers?.fast?.model).toBe("haiku");
    expect(claude.models?.tiers?.balanced?.model).toBe("sonnet");
    expect(claude.models?.tiers?.deep?.model).toBe("opus");
    expect(codex.models?.fallback).toContain("upward-only");
    expect(claude.models?.fallback).toContain("upward-only");
    expect(codex.models?.deep_unavailable).toContain("BLOCKED");
    expect(claude.models?.deep_unavailable).toContain("BLOCKED");

    const reviewTemplate = await readFile(
      path.join(root, "skills", "rockspec-review", "assets", "review.md"),
      "utf8",
    );
    const acceptanceReport = await readFile(
      path.join(root, "skills", "rockspec-acceptance", "assets", "test-report.md"),
      "utf8",
    );
    for (const report of [reviewTemplate, acceptanceReport]) {
      expect(report).toContain("Model Tier");
      expect(report).toContain("宿主模型");
      expect(report).toContain("选择原因");
    }
  });

  it("preserves the Requirements, Design, and Plan authoring protocols", async () => {
    const interactiveGate = "<INTERACTIVE-GATE>";
    const requirementsRoot = path.join(root, "skills", "rockspec-requirements");
    const requirements = await readFile(path.join(requirementsRoot, "SKILL.md"), "utf8");
    const requirementsActionText = await readFile(
      path.join(requirementsRoot, "references", "action-requirements.clarify.yaml"),
      "utf8",
    );
    const requirementsAction = parse(requirementsActionText) as {
      executor?: { mode?: string; collaboration?: { mode?: string } };
    };
    expect(requirements).toContain("四项 Authority 测试");
    expect(requirements).toContain(interactiveGate);
    expect(requirements).toContain("章节是最终产物结构，不是会话停点");
    expect(requirements).toContain("## Conversation presentation");
    expect(requirements).toContain("比较、规则和映射用表格");
    expect(requirements).toContain("简单流程、依赖或状态变化用紧凑 ASCII 图");
    expect(requirements).toContain("不要为了丰富形式强制添加图表");
    expect(requirements).toContain("结束当前回复等待");
    expect(requirements).toContain("没有新的产品选择，就不得产生新的确认停点");
    expect(requirements).toContain("没有开放决策时可以直接写入最终 Proposal");
    expect(requirements).toContain("Open Revision");
    expect(requirements).toContain("失效的下游产物、Review 和 Approval");
    expect(requirements).toContain("decision-free authoring");
    expect(requirements).toContain("不运行章节确认循环");
    expect(requirements).toContain("不得在 Hash Approval 前再增加 reviewed Delta 确认");
    expect(requirements).toContain("人工审批强度不决定交互次数");
    expect(requirementsActionText).toContain("章节不是停点");
    expect(requirementsActionText).toContain("从磁盘重读");
    expect(requirementsActionText).toContain("不得用假设绕过");
    expect(requirementsActionText).toContain("没有新的产品选择就不得暂停");
    expect(await readFile(
      path.join(requirementsRoot, "references", "aggregate-root-deletion.md"),
      "utf8",
    )).toContain("Owned dependents");
    expect(requirementsAction.executor?.mode).toBe("inline");
    expect(requirementsAction.executor?.collaboration?.mode).toBe("interactive");

    const designRoot = path.join(root, "skills", "rockspec-design");
    const design = await readFile(path.join(designRoot, "SKILL.md"), "utf8");
    const designActionText = await readFile(
      path.join(designRoot, "references", "action-design.technical.yaml"),
      "utf8",
    );
    const designAction = parse(designActionText) as {
      executor?: { mode?: string; collaboration?: { mode?: string } };
    };
    expect(design).toContain("才把 Change 拆分作为开放决策");
    expect(design).toContain("2 至 3 个真正不同的方案");
    expect(design).toContain(interactiveGate);
    expect(design).toContain("章节是最终产物结构，不是会话停点");
    expect(design).toContain("## Conversation presentation");
    expect(design).toContain("比较、规则和映射用表格");
    expect(design).toContain("简单流程、依赖或状态变化用紧凑 ASCII 图");
    expect(design).toContain("关系复杂或容易产生歧义时");
    expect(design).toContain("UI 布局和视觉交互交给 `$rockspec-prototype`");
    expect(design).toContain("结束当前回复等待");
    expect(design).toContain("没有开放决策时可直接写入最终 `design.md`");
    expect(design).toContain("锁、事务隔离、SQL 顺序");
    expect(design).toContain("rockspec revise --source design.technical --target requirements");
    expect(design).toContain("`inputs.spec_hash`");
    expect(design).toContain("`TODO/TBD`");
    expect(design).toContain("decision-free authoring");
    expect(design).toContain("不得把范围架构、模块、接口、错误并发、安全迁移、测试和原型拆成章节确认");
    expect(designActionText).toContain("首次 Design、human Gate 或 full interaction 都不自动增加交互");
    expect(designActionText).toContain("Decision Package 也不得替代绑定 Hash 的 Design Approval");
    expect(designAction.executor?.mode).toBe("inline");
    expect(designAction.executor?.collaboration?.mode).toBe("interactive");

    const planRoot = path.join(root, "skills", "rockspec-plan");
    const plan = await readFile(path.join(planRoot, "SKILL.md"), "utf8");
    const planActionText = await readFile(
      path.join(planRoot, "references", "action-plan.create.yaml"),
      "utf8",
    );
    const planAction = parse(planActionText) as {
      executor?: { mode?: string; collaboration?: { mode?: string } };
    };
    const readinessReviewer = await readFile(
      path.join(planRoot, "references", "role-readiness-reviewer.md"),
      "utf8",
    );
    expect(plan).toContain("文件职责图");
    expect(plan).toContain("`consumes`/`produces`");
    expect(plan).toContain("`supersedes`");
    expect(plan).toContain("原样保留已经完成的历史 `supersedes` 关系");
    expect(plan).toContain("仍存在于当前 Spec 的 ID 可继续贡献覆盖");
    expect(plan).toContain("不存在永久阻塞路径");
    expect(plan).toContain("预期失败和成功观察");
    expect(planActionText).toContain("不强制按固定分钟数拆分");
    expect(planAction.executor?.mode).toBe("inline");
    expect(planAction.executor?.collaboration?.mode).not.toBe("interactive");
    expect(readinessReviewer).toContain("`consumes`/`produces` 契约");
    expect(readinessReviewer).toContain("模拟完整调度");
    expect(readinessReviewer).toContain("占位");
  });

  it("documents bounded automatic reconciliation without skipping first approvals", async () => {
    const changeRoot = path.join(root, "skills", "rockspec-change");
    const change = await readFile(path.join(changeRoot, "SKILL.md"), "utf8");
    const reconciliation = await readFile(
      path.join(changeRoot, "references", "reconciliation-loop.md"),
      "utf8",
    );
    const requirements = await readFile(
      path.join(root, "skills", "rockspec-requirements", "SKILL.md"),
      "utf8",
    );
    const design = await readFile(
      path.join(root, "skills", "rockspec-design", "SKILL.md"),
      "utf8",
    );
    const plan = await readFile(
      path.join(root, "skills", "rockspec-plan", "SKILL.md"),
      "utf8",
    );
    const review = await readFile(
      path.join(root, "skills", "rockspec-review", "SKILL.md"),
      "utf8",
    );
    const reviewTemplate = await readFile(
      path.join(root, "skills", "rockspec-review", "assets", "review.md"),
      "utf8",
    );
    const reconciliationTemplate = await readFile(
      path.join(root, "skills", "rockspec-review", "assets", "reconciliation-review.md"),
      "utf8",
    );

    expect(change).toContain("references/reconciliation-loop.md");
    expect(change).toContain("首次 Spec、Design 和 Implementation Approval");
    expect(reconciliation).toContain("Content Hash");
    expect(reconciliation).toContain("Authority Baseline");
    expect(reconciliation).toContain("旧报告缺少分类字段");
    expect(reconciliation).toContain("Critical 表示问题在修复前持续阻塞，不等于产品 Authority 已变化");
    for (const classification of [
      "consistency_fix",
      "derived_gap",
      "implementation_fix",
      "decision_change",
      "intent_change",
      "risk_acceptance",
    ]) {
      expect(reconciliation).toContain(classification);
    }
    expect(requirements).toContain("authoring");
    expect(requirements).toContain("reconciliation");
    expect(design).toContain("authoring");
    expect(design).toContain("reconciliation");
    expect(plan).toContain("`gate_policies.implementation: human`");
    expect(review).toContain("Reviewer 必须不同于 Revision Author");
    expect(review).toContain("最多两轮");
    for (const template of [reviewTemplate, reconciliationTemplate]) {
      expect(template).toContain("classification");
      expect(template).toContain("authority_");
    }
  });

  it("ships inline Debug and business Research as independent scene Skills", async () => {
    const debugRoot = path.join(root, "skills", "rockspec-debug");
    const debug = await readFile(path.join(debugRoot, "SKILL.md"), "utf8");
    const debugProtocol = await readFile(
      path.join(debugRoot, "references", "debug-protocol.md"),
      "utf8",
    );
    const debugReport = await readFile(
      path.join(debugRoot, "assets", "debug-report.md"),
      "utf8",
    );
    expect(debug).toContain("首版保持 Inline，不创建 Subagent");
    expect(debug).toContain(".rockspec/workbench/debug/<slug>/report.md");
    expect(debugProtocol).toContain("根因门禁");
    expect(debugProtocol).toContain("每次只改变一个变量");
    expect(debugReport).toContain("可证伪预测");

    const researchRoot = path.join(root, "skills", "rockspec-research");
    const research = await readFile(path.join(researchRoot, "SKILL.md"), "utf8");
    const researchProtocol = await readFile(
      path.join(researchRoot, "references", "research-protocol.md"),
      "utf8",
    );
    const researchReport = await readFile(
      path.join(researchRoot, "assets", "research-report.md"),
      "utf8",
    );
    expect(research).toContain("首版保持 Inline，不创建后台 Research Subagent");
    expect(research).toContain(".rockspec/workbench/research/<slug>/research.md");
    expect(research).toContain("<INTERACTIVE-GATE>");
    expect(research).toContain("1 至 3 条真实可行的研究或证据路径");
    expect(research).toContain("每次只展示一个章节");
    expect(research).toContain("结束当前回复并等待");
    expect(research).toContain("不得写入最终 `research.md`");
    expect(research).toContain("不得启动 Reviewer");
    expect(research).toContain("不得进入 Requirements");
    expect(researchProtocol).toContain("事实能从环境、仓库或来源查到时自行查证");
    expect(researchProtocol).toContain("协作模式为 Interactive");
    expect(researchProtocol).toContain("停止条件");
    for (const label of ["FACT", "USER_REPORT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"]) {
      expect(researchReport).toContain(label);
    }

    for (const sceneRoot of [debugRoot, researchRoot]) {
      const actionFiles = (await readdir(path.join(sceneRoot, "references")))
        .filter((file) => file.startsWith("action-") && file.endsWith(".yaml"));
      expect(actionFiles).toEqual([]);
    }
  });

  it("returns control to the user at interactive capability boundaries", async () => {
    const changeRoot = path.join(root, "skills", "rockspec-change");
    const change = await readFile(path.join(changeRoot, "SKILL.md"), "utf8");
    const recipe = parse(await readFile(
      path.join(changeRoot, "references", "change-recipe.yaml"),
      "utf8",
    )) as { interactive_skills?: string[]; invariants?: string[] };

    expect(recipe.interactive_skills).toEqual([
      "rockspec-research",
      "rockspec-requirements",
      "rockspec-design",
    ]);
    expect(recipe.invariants?.join("\n")).toContain("只有遇到未关闭的 Decision Package 或正式 Approval Package 时才等待用户");
    expect(change).toContain("只有返回尚未关闭的 Decision Package 时才将控制权交还用户");
    expect(change).toContain("没有开放决策时允许当前 Skill 完成产物、Review 准备并重新加载状态");
    expect(change).toContain("端到端执行不构成对尚未展示 Authority 决策或 Hash Package 的预先确认");
    expect(change).toContain("`rockspec revise`");
    expect(change).toContain("不得因文件 Hash 过期直接重新审批");

    const prototype = await readFile(path.join(root, "skills", "rockspec-prototype", "SKILL.md"), "utf8");
    expect(prototype).toContain("Design Draft 文件 Hash");
    expect(prototype).toContain("必须回到 `$rockspec-design`");
    expect(prototype).toContain("`reconciled`");
  });

  it("keeps Finding Recovery explicit across orchestration, review, planning, and acceptance", async () => {
    const change = await readFile(path.join(root, "skills", "rockspec-change", "SKILL.md"), "utf8");
    const review = await readFile(path.join(root, "skills", "rockspec-review", "SKILL.md"), "utf8");
    const implement = await readFile(path.join(root, "skills", "rockspec-implement", "SKILL.md"), "utf8");
    const acceptance = await readFile(path.join(root, "skills", "rockspec-acceptance", "SKILL.md"), "utf8");
    const plan = await readFile(path.join(root, "skills", "rockspec-plan", "SKILL.md"), "utf8");
    const acceptanceReport = await readFile(
      path.join(root, "skills", "rockspec-acceptance", "assets", "test-report.md"),
      "utf8",
    );
    const taskTemplate = await readFile(
      path.join(root, "skills", "rockspec-plan", "assets", "task.md"),
      "utf8",
    );

    expect(change).toContain("`recovery.kind=revision`");
    expect(change).toContain("全部 `finding_ids`");
    expect(change).toContain("绑定已提交的 non-PASS Review 和 Open Finding");
    expect(review).toContain("重新读取 `status.recovery`");
    expect(review).toContain("Delivery 验收资产 Finding 返回 Acceptance");
    expect(implement).toContain("`suspended` Task");
    expect(implement).toContain("`superseded` Task 永不重启");
    expect(acceptance).toContain("结构化 Frontmatter");
    expect(acceptance).toContain("保留已完成 Task/Commit");
    expect(plan).toContain("不得删除或重定义 Completed/Suspended Task");
    expect(plan).toContain("`supersedes: [T-xxx]`");
    expect(taskTemplate).toContain("finding_ids:");
    expect(taskTemplate).toContain("supersedes:");
    expect(taskTemplate).toContain("不得把 Finding 追加到历史 Task");
    expect(acceptanceReport).toContain("只写在正文中的缺陷不能驱动 Recovery");
  });

  it("ships transparent Change-level Worktree isolation without a new Engine Action", async () => {
    const worktreeRoot = path.join(root, "skills", "rockspec-worktree");
    const skill = await readFile(path.join(worktreeRoot, "SKILL.md"), "utf8");
    const protocol = await readFile(
      path.join(worktreeRoot, "references", "worktree-protocol.md"),
      "utf8",
    );
    const receipt = await readFile(
      path.join(worktreeRoot, "assets", "workspace-receipt.yaml"),
      "utf8",
    );
    expect(skill).toContain("以 Change 为隔离单位");
    expect(skill).toContain("用户不需要手动执行 `rockspec new`");
    expect(skill).toContain("不在新 Worktree 中重新安装或执行 `rockspec init`");
    expect(protocol).toContain("优先使用宿主原生 Worktree 能力");
    expect(protocol).toContain("info/exclude");
    expect(protocol).toContain("同一目标分支的更新必须串行");
    expect(receipt).toContain("relative_path");
    expect(receipt).not.toContain("absolute_path");
    const actionFiles = (await readdir(path.join(worktreeRoot, "references")))
      .filter((file) => file.startsWith("action-") && file.endsWith(".yaml"));
    expect(actionFiles).toEqual([]);

    const change = await readFile(path.join(root, "skills", "rockspec-change", "SKILL.md"), "utf8");
    const triage = await readFile(path.join(root, "skills", "rockspec-triage", "SKILL.md"), "utf8");
    const implement = await readFile(path.join(root, "skills", "rockspec-implement", "SKILL.md"), "utf8");
    expect(change).toContain("$rockspec-worktree");
    expect(triage).toContain("--managed-worktree");
    expect(implement).toContain("Workspace Binding");

    for (const adapterPath of [
      path.join(root, "adapters", "codex", "adapter.yaml"),
      path.join(root, "adapters", "claude", "adapter.yaml"),
    ]) {
      const adapter = parse(await readFile(adapterPath, "utf8")) as {
        invocation?: { scenarios?: Record<string, string> };
        subagents?: { cwd?: string };
        worktrees?: { create?: string; cleanup?: string };
      };
      expect(adapter.invocation?.scenarios?.worktree).toContain("rockspec-worktree");
      expect(adapter.subagents?.cwd).toContain("change.workspace");
      expect(adapter.worktrees?.create).toContain("otherwise git worktree add");
      expect(adapter.worktrees?.cleanup).toContain("explicit finish disposition");
    }
  });

  it("keeps Acceptance before Final CR in Standard and Strict recipes", async () => {
    const recipe = parse(await readFile(
      path.join(root, "skills", "rockspec-change", "references", "change-recipe.yaml"),
      "utf8",
    )) as {
      authority?: string;
      engine_authority?: string;
      profiles: Record<string, {
        extends?: string;
        actions?: string[];
        approval_gates?: Array<{ id: string; after_actions: string[] }>;
      }>;
    };

    expect(recipe.authority).toBe("agent-guidance");
    expect(recipe.engine_authority).toBe("packages/engine/src/workflow.ts");

    for (const profile of ["standard", "strict"]) {
      const actions = recipe.profiles[profile]?.actions ?? recipe.profiles.standard?.actions ?? [];
      expect(actions).toEqual(
        WORKFLOW_PRIMARY_ACTIONS_BY_PROFILE[profile as "standard" | "strict"],
      );
      expect(actions.indexOf("acceptance.validate")).toBeGreaterThan(-1);
      expect(actions.indexOf("delivery.review")).toBeGreaterThan(actions.indexOf("acceptance.validate"));
    }

    expect(recipe.profiles.lite?.actions).toEqual(WORKFLOW_PRIMARY_ACTIONS_BY_PROFILE.lite);
    const approvalGates = Object.fromEntries(
      (recipe.profiles.standard?.approval_gates ?? []).map((gate) => [
        gate.id,
        { after_actions: gate.after_actions },
      ]),
    );
    expect(approvalGates).toEqual(WORKFLOW_APPROVAL_GATES);
  });

  it("does not retain pre-composition contract and template duplicates", async () => {
    for (const obsolete of ["actions", "roles", "recipes", "templates"]) {
      await expect(stat(path.join(root, obsolete))).rejects.toThrow();
    }
    await expect(stat(path.join(root, "scripts", "sync-skill-contracts.mjs"))).rejects.toThrow();
  });

  it("ships valid host manifests without bundling the external UI provider", async () => {
    const codex = JSON.parse(
      await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const claude = JSON.parse(
      await readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(codex).toMatchObject({ name: "rockspec", skills: "./skills/" });
    expect(codex).not.toHaveProperty("hooks");
    expect(claude).toMatchObject({
      name: "rockspec",
      skills: [
        "./skills/rockspec-change",
        "./skills/rockspec-triage",
        "./skills/rockspec-requirements",
        "./skills/rockspec-design",
        "./skills/rockspec-prototype",
        "./skills/rockspec-plan",
        "./skills/rockspec-implement",
        "./skills/rockspec-review",
        "./skills/rockspec-acceptance",
        "./skills/rockspec-finish",
        "./skills/rockspec-debug",
        "./skills/rockspec-research",
        "./skills/rockspec-worktree",
      ],
    });
    await expect(stat(path.join(root, "skills", "ui-ux-pro-max"))).rejects.toThrow();
  });
});
