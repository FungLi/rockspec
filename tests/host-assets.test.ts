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
    const requirementsRoot = path.join(root, "skills", "rockspec-requirements");
    const requirements = await readFile(path.join(requirementsRoot, "SKILL.md"), "utf8");
    const requirementsAction = await readFile(
      path.join(requirementsRoot, "references", "action-requirements.clarify.yaml"),
      "utf8",
    );
    expect(requirements).toContain("只有这类歧义才阻塞");
    expect(requirements).toContain("每次只问当前最重要的一个问题");
    expect(requirementsAction).toContain("从磁盘重读");
    expect(requirementsAction).toContain("不得用假设绕过");

    const designRoot = path.join(root, "skills", "rockspec-design");
    const design = await readFile(path.join(designRoot, "SKILL.md"), "utf8");
    const designAction = await readFile(
      path.join(designRoot, "references", "action-design.technical.yaml"),
      "utf8",
    );
    expect(design).toContain("拆成多个 Change");
    expect(design).toContain("2 至 3 个真正不同的方案");
    expect(design).toContain("分段展示");
    expect(design).toContain("`TODO/TBD`");
    expect(designAction).toContain("分段确认不得替代绑定 Hash 的 Design Approval");

    const planRoot = path.join(root, "skills", "rockspec-plan");
    const plan = await readFile(path.join(planRoot, "SKILL.md"), "utf8");
    const planAction = await readFile(
      path.join(planRoot, "references", "action-plan.create.yaml"),
      "utf8",
    );
    const readinessReviewer = await readFile(
      path.join(planRoot, "references", "role-readiness-reviewer.md"),
      "utf8",
    );
    expect(plan).toContain("文件职责图");
    expect(plan).toContain("`consumes`/`produces`");
    expect(plan).toContain("预期失败和成功观察");
    expect(planAction).toContain("不强制按固定分钟数拆分");
    expect(readinessReviewer).toContain("`consumes`/`produces` 契约");
    expect(readinessReviewer).toContain("占位");
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
    expect(researchProtocol).toContain("事实能从环境、仓库或来源查到时自行查证");
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
