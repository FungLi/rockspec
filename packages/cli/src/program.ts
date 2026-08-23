import { RockSpecEngine } from "@rockspec/engine";
import {
  doctorProject,
  installProject,
  listInstalledProviders,
  repairProject,
  uninstallProject,
  upgradeProject,
} from "@rockspec/installer";
import {
  ACTION_IDS,
  AUTHORITY_IMPACTS,
  CHANGE_KINDS,
  FEEDBACK_INTERACTION_MODES,
  PROFILES,
  REVISION_CLASSIFICATIONS,
  REVISION_TARGETS,
  type ActionId,
  type ChangeKind,
  type WorkflowProfile,
  triageProfile,
  type InstallHost,
} from "@rockspec/protocol";
import { Command, CommanderError, Option } from "commander";
import {
  STATUS_VIEWS,
  errorExitCode,
  failureEnvelope,
  formatHuman,
  isFullStatusResult,
  projectStatus,
  successEnvelope,
  type StatusView,
} from "./output.js";
import { runInstallWizard } from "./install-wizard.js";

interface WritableTarget {
  write(value: string): unknown;
}

export interface CliDependencies {
  stdout?: WritableTarget;
  stderr?: WritableTarget;
  engineFactory?: (cwd?: string, availableProviders?: readonly string[]) => RockSpecEngine;
  setExitCode?: (code: number) => void;
}

interface GlobalOptions {
  cwd?: string;
  json?: boolean;
  provider?: string[];
  summary?: boolean;
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const engineFactory = dependencies.engineFactory ?? ((cwd, providers) => new RockSpecEngine({
    ...(cwd ? { cwd } : {}),
    availableProviders: new Set(providers),
  }));
  const setExitCode = dependencies.setExitCode ?? ((code) => {
    process.exitCode = code;
  });

  const program = new Command()
    .name("rockspec")
    .description("Deterministic Harness Engineering workflow for coding agents")
    .version("0.1.0")
    .option("--cwd <path>", "run as if started in this directory")
    .option("--provider <skill-name>", "external Skill available in this host; repeat as needed", collect, [])
    .option("--json", "emit a versioned JSON envelope", false)
    .option("--summary", "project status-like command results to a compact summary", false)
    .showHelpAfterError();

  const execute = async <T>(
    commandName: string,
    command: Command,
    operation: (engine: RockSpecEngine) => Promise<T>,
  ): Promise<void> => {
    const options = command.optsWithGlobals<GlobalOptions>();
    try {
      const configuredProviders = process.env.ROCKSPEC_AVAILABLE_PROVIDERS
        ?.split(",")
        .map((provider) => provider.trim())
        .filter(Boolean) ?? [];
      const installedProviders = await listInstalledProviders(options.cwd ?? process.cwd());
      const result = await operation(
        engineFactory(options.cwd, [
          ...new Set([...installedProviders, ...configuredProviders, ...(options.provider ?? [])]),
        ]),
      );
      const output = options.summary && isFullStatusResult(result)
        ? projectStatus(result, "summary")
        : result;
      const rendered = options.json
        ? JSON.stringify(successEnvelope(commandName, output), null, 2)
        : formatHuman(output);
      stdout.write(`${rendered}\n`);
    } catch (error) {
      const failure = failureEnvelope(commandName, error);
      if (options.json) {
        stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
      } else {
        stderr.write(`RockSpec ${failure.error.code}: ${failure.error.message}\n`);
        if (failure.error.details !== null) {
          stderr.write(`${JSON.stringify(failure.error.details, null, 2)}\n`);
        }
      }
      setExitCode(errorExitCode(error));
    }
  };

  program.action(async (_options: unknown, command: Command) => {
    const cwd = command.optsWithGlobals<GlobalOptions>().cwd;
    await execute("install", command, () => runInstallWizard({ ...(cwd ? { cwd } : {}) }));
  });

  program
    .command("install")
    .description("install RockSpec Runtime, project Skills, host adapters, and external Skill dependencies")
    .option("--project <path>", "target Git repository", ".")
    .option("--hosts <hosts>", "comma-separated hosts", "codex,claude")
    .option("--with <capability>", "install a capability; repeat as needed", collect, [])
    .option("--without <capability>", "exclude a capability; repeat as needed", collect, [])
    .option("--external-skill <name=path>", "external Skill source; repeat as needed", collect, [])
    .option("--accept-unknown-license", "accept an external Skill whose License metadata is UNKNOWN", false)
    .option("--plan", "show the installation plan without writing files", false)
    .option("--yes", "run non-interactively", false)
    .option("--source-root <path>", "development distribution root")
    .action(async (options: {
      project: string;
      hosts: string;
      with: string[];
      without: string[];
      externalSkill: string[];
      acceptUnknownLicense: boolean;
      plan: boolean;
      yes: boolean;
      sourceRoot?: string;
    }, command: Command) => {
      await execute("install", command, async () => {
        if (!options.yes && !options.plan) {
          return runInstallWizard({ cwd: options.project, ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}) });
        }
        return installProject({
          projectRoot: options.project,
          hosts: parseInstallHosts(options.hosts),
          withCapabilities: options.with,
          withoutCapabilities: options.without,
          externalSkills: parseExternalSkills(options.externalSkill),
          acceptUnknownLicense: options.acceptUnknownLicense,
          dryRun: options.plan,
          ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
        });
      });
    });

  program
    .command("doctor")
    .description("validate the installed Runtime, Skills, adapters, and install lock")
    .option("--project <path>", "target Git repository", ".")
    .action(async (options: { project: string }, command: Command) => {
      await execute("doctor", command, async () => {
        const result = await doctorProject(options.project);
        if (!result.valid) {
          throw Object.assign(new Error("RockSpec installation validation failed"), {
            code: "INSTALL_DOCTOR_FAILED",
            details: result,
            exitCode: 1,
          });
        }
        return result;
      });
    });

  program
    .command("repair")
    .description("restore missing managed installation files without overwriting modified files")
    .option("--project <path>", "target Git repository", ".")
    .option("--source-root <path>", "development distribution root")
    .option("--accept-unknown-license", "accept an external Skill whose License metadata is UNKNOWN", false)
    .action(async (options: { project: string; sourceRoot?: string; acceptUnknownLicense: boolean }, command: Command) => {
      await execute("repair", command, () => repairProject({
        projectRoot: options.project,
        acceptUnknownLicense: options.acceptUnknownLicense,
        ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
      }));
    });

  program
    .command("upgrade")
    .description("upgrade RockSpec from the current distribution while preserving locked external Skills")
    .option("--project <path>", "target Git repository", ".")
    .option("--dependencies", "also refresh external Skill dependencies", false)
    .option("--source-root <path>", "development distribution root")
    .option("--accept-unknown-license", "accept an external Skill whose License metadata is UNKNOWN", false)
    .action(async (options: { project: string; dependencies: boolean; sourceRoot?: string; acceptUnknownLicense: boolean }, command: Command) => {
      await execute("upgrade", command, () => upgradeProject({
        projectRoot: options.project,
        upgradeDependencies: options.dependencies,
        acceptUnknownLicense: options.acceptUnknownLicense,
        ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
      }));
    });

  program
    .command("uninstall")
    .description("remove unchanged files owned by the RockSpec installer and retain project workflow data")
    .option("--project <path>", "target Git repository", ".")
    .option("--yes", "confirm removal of installer-managed files", false)
    .action(async (options: { project: string; yes: boolean }, command: Command) => {
      await execute("uninstall", command, () => {
        if (!options.yes) {
          throw Object.assign(new Error("Uninstall requires --yes"), { code: "CONFIRMATION_REQUIRED" });
        }
        return uninstallProject(options.project);
      });
    });

  program
    .command("init")
    .description("initialize .rockspec at the Git repository root")
    .action(async (_options: unknown, command: Command) => {
      await execute("init", command, (engine) => engine.init());
    });

  program
    .command("new")
    .description("low-level: create a Change in the workspace selected by RockSpec Skills")
    .argument("<change-id>", "stable English kebab-case change ID")
    .option("--title <title>", "human-readable title")
    .option("--base <ref>", "target branch or ref used as the Change baseline")
    .option("--managed-worktree", "record that RockSpec prepared this linked Worktree", false)
    .option("--based-on-change <change-id>", "parent Change whose frozen delivery snapshot this Change extends")
    .option("--reuse-workspace", "explicitly confirm sequential reuse of the current Worktree", false)
    .option("--confirm-boundary", "confirm that this feedback is an independent Change", false)
    .addOption(new Option("--kind <kind>", "change kind used for triage").choices([...CHANGE_KINDS]).default("feature"))
    .addOption(new Option("--profile <profile>", "explicitly promote the selected profile").choices([...PROFILES]))
    .option("--risk <risk>", "risk tag; repeat for multiple tags", collect, [])
    .option("--ui-impact", "require a UI/UX prototype", false)
    .action(async (changeId: string, options: {
      title?: string;
      base?: string;
      managedWorktree: boolean;
      kind: ChangeKind;
      profile?: WorkflowProfile;
      risk: string[];
      uiImpact: boolean;
      basedOnChange?: string;
      reuseWorkspace: boolean;
      confirmBoundary: boolean;
    }, command: Command) => {
      await execute("new", command, async (engine) => {
        const triage = triageProfile({
          kind: options.kind,
          ...(options.profile ? { requestedProfile: options.profile } : {}),
          riskTags: options.risk,
        });
        const status = await engine.newChange({
          id: changeId,
          ...(options.title ? { title: options.title } : {}),
          ...(options.base ? { baseRef: options.base } : {}),
          profile: triage.profile,
          prototypeRequired: options.uiImpact,
          workspaceManaged: options.managedWorktree,
          ...(options.basedOnChange ? { basedOnChange: options.basedOnChange } : {}),
          ...(options.basedOnChange ? { reuseWorkspace: options.reuseWorkspace } : {}),
          ...(options.basedOnChange ? { confirmBoundary: options.confirmBoundary } : {}),
        });
        return { ...status, triage };
      });
    });

  program
    .command("status")
    .description("show current state without modifying it")
    .argument("[change-id]")
    .option("--change <change-id>", "compatibility alias for the positional Change ID")
    .addOption(new Option("--view <view>", "select a compact status projection").choices([...STATUS_VIEWS]).default("summary"))
    .option("--full", "emit the complete Change snapshot", false)
    .action(async (
      positionalId: string | undefined,
      options: { change?: string; view: StatusView; full: boolean },
      command: Command,
    ) => {
      const view = options.full ? "full" : options.view;
      await execute("status", command, async (engine) => {
        const changeId = resolveChangeId(positionalId, options.change);
        return projectStatus(
          await engine.getStatus({ ...(changeId ? { changeId } : {}) }),
          view,
        );
      });
    });

  const feedback = program.command("feedback").description("record user acceptance feedback and route it within or beyond a Change");
  feedback
    .command("submit")
    .argument("[change-id]")
    .addOption(new Option("--route <route>", "feedback boundary").choices(["same_change", "new_change"]).default("same_change"))
    .addOption(new Option("--interaction <mode>", "feedback interaction mode").choices([...FEEDBACK_INTERACTION_MODES]).default("compact"))
    .requiredOption("--reason <reason>", "why the accepted product needs adjustment")
    .requiredOption("--item <description>", "one feedback item; repeat for a batch", collect, [])
    .addOption(new Option("--target <capability>", "earliest affected capability").choices([...REVISION_TARGETS]))
    .option("--affected <id>", "affected R-/S-/D- ID; repeat as needed", collect, [])
    .option("--by <identity>", "feedback author", "user")
    .option("--related-change <change-id>", "related Change when routing to a new Change")
    .option("--author-execution <execution-id>", "feedback author execution ID required for reconcile mode")
    .action(async (changeId: string | undefined, options: {
      route: "same_change" | "new_change";
      interaction: "reconcile" | "compact" | "full";
      reason: string;
      item: string[];
      target?: "requirements" | "design" | "prototype" | "plan";
      affected: string[];
      by: string;
      relatedChange?: string;
      authorExecution?: string;
    }, command: Command) => {
      await execute("feedback.submit", command, (engine) => engine.submitFeedback({
        route: options.route,
        interactionMode: options.interaction,
        reason: options.reason,
        items: options.item,
        ...(options.target ? { target: options.target } : {}),
        affectedIds: options.affected,
        submittedBy: options.by,
        ...(options.relatedChange ? { relatedChangeId: options.relatedChange } : {}),
        ...(options.authorExecution ? { authorExecutionId: options.authorExecution } : {}),
        ...(changeId ? { changeId } : {}),
      }));
    });

  program
    .command("continue")
    .description("resume by reading the engine's recommended next action")
    .argument("[change-id]")
    .option("--change <change-id>", "compatibility alias for the positional Change ID")
    .addOption(new Option("--view <view>", "select a compact status projection").choices([...STATUS_VIEWS]).default("summary"))
    .option("--full", "emit the complete Change snapshot", false)
    .action(async (
      positionalId: string | undefined,
      options: { change?: string; view: StatusView; full: boolean },
      command: Command,
    ) => {
      const view = options.full ? "full" : options.view;
      await execute("continue", command, async (engine) => {
        const changeId = resolveChangeId(positionalId, options.change);
        return projectStatus(
          await engine.getStatus({ ...(changeId ? { changeId } : {}) }),
          view,
        );
      });
    });

  const action = program
    .command("action")
    .description("submit an internal action result from a capability Skill");
  action
    .command("complete")
    .argument("<action-id>")
    .argument("[change-id]")
    .addOption(new Option("--verdict <verdict>").choices(["PASS", "CHANGES_REQUIRED", "BLOCKED"]))
    .action(async (actionId: ActionId, changeId: string | undefined, options: { verdict?: "PASS" | "CHANGES_REQUIRED" | "BLOCKED" }, command: Command) => {
      await execute("action.complete", command, (engine) => {
        if (!ACTION_IDS.includes(actionId)) {
          throw Object.assign(new Error(`Unknown action: ${actionId}`), { code: "INVALID_ACTION", details: { action_id: actionId } });
        }
        return engine.completeAction({
          action: actionId,
          ...(changeId ? { changeId } : {}),
          ...(options.verdict ? { verdict: options.verdict } : {}),
        });
      });
    });

  program
    .command("approve")
    .description("record a hash-bound user approval")
    .argument("<artifact-id>", "spec, design, or implementation")
    .argument("[change-id]")
    .option("--by <identity>", "approver identity", "user")
    .action(async (artifactId: string, changeId: string | undefined, options: { by: string }, command: Command) => {
      await execute("approve", command, (engine) => {
        if (!isApprovalGate(artifactId)) {
          throw Object.assign(new Error(`Unknown approval artifact: ${artifactId}`), {
            code: "INVALID_APPROVAL_GATE",
            details: { artifact_id: artifactId, allowed: ["spec", "design", "implementation"] },
          });
        }
        return engine.approve({ gate: artifactId, approvedBy: options.by, ...(changeId ? { changeId } : {}) });
      });
    });

  program
    .command("promote")
    .description("promote a change to a more rigorous workflow profile")
    .argument("<profile>", "standard or strict")
    .argument("[change-id]")
    .action(async (profile: string, changeId: string | undefined, _options: unknown, command: Command) => {
      await execute("promote", command, (engine) => {
        if (profile !== "standard" && profile !== "strict") {
          throw Object.assign(new Error("Promotion target must be standard or strict"), { code: "INVALID_PROFILE", details: { profile } });
        }
        return engine.promote({ profile, ...(changeId ? { changeId } : {}) });
      });
    });

  program
    .command("revise")
    .description("open a controlled Revision or amend the active Revision with new Review Findings")
    .argument("[change-id]")
    .option("--amend", "append new Review Findings to the active Revision")
    .option("--source <action-id>", "action where the inconsistency was discovered")
    .addOption(new Option("--target <capability>", "earliest capability that must change").choices([...REVISION_TARGETS]))
    .option("--review <review-id>", "triggering Review ID for implementation recovery")
    .option("--finding <finding-id>", "triggering Open Finding ID; repeat for all recommended Findings", collect, [])
    .addOption(new Option("--classification <classification>", "Revision materiality classification").choices([...REVISION_CLASSIFICATIONS]))
    .addOption(new Option("--authority-impact <impact>", "whether approved intent or decisions change").choices([...AUTHORITY_IMPACTS]))
    .option("--author-execution <execution-id>", "Revision Author execution ID required for automatic reconciliation")
    .requiredOption("--reason <reason>", "why the approved or derived content must change")
    .option("--affected <id>", "affected R-/S-/D- ID; repeat as needed", collect, [])
    .action(async (changeId: string | undefined, options: {
      amend?: boolean;
      source?: string;
      target?: "requirements" | "design" | "prototype" | "plan";
      review?: string;
      finding: string[];
      classification?: (typeof REVISION_CLASSIFICATIONS)[number];
      authorityImpact?: (typeof AUTHORITY_IMPACTS)[number];
      authorExecution?: string;
      reason: string;
      affected: string[];
    }, command: Command) => {
      await execute(options.amend ? "revise.amend" : "revise", command, (engine) => {
        if (options.source && !ACTION_IDS.includes(options.source as ActionId)) {
          throw Object.assign(new Error(`Unknown Revision source action: ${options.source}`), {
            code: "INVALID_ACTION",
            details: { action_id: options.source },
          });
        }
        const input = {
          ...(options.source ? { source: options.source as ActionId } : {}),
          ...(options.target ? { target: options.target } : {}),
          reason: options.reason,
          affectedIds: options.affected,
          ...(options.review ? { reviewId: options.review } : {}),
          ...(options.finding.length > 0 ? { findingIds: options.finding } : {}),
          ...(options.classification ? { classification: options.classification } : {}),
          ...(options.authorityImpact ? { authorityDelta: options.authorityImpact } : {}),
          ...(options.authorExecution ? { authorExecutionId: options.authorExecution } : {}),
          ...(changeId ? { changeId } : {}),
        };
        return options.amend ? engine.amendRevision(input) : engine.revise(input);
      });
    });

  const reconcile = program
    .command("reconcile")
    .description("prepare or complete an independent automatic Reconciliation Review");
  reconcile
    .command("prepare")
    .argument("<artifact-id>", "spec, design, or implementation")
    .argument("[change-id]")
    .action(async (artifactId: string, changeId: string | undefined, _options: unknown, command: Command) => {
      await execute("reconcile.prepare", command, (engine) => {
        if (!isApprovalGate(artifactId)) {
          throw Object.assign(new Error(`Unknown reconciliation artifact: ${artifactId}`), {
            code: "INVALID_APPROVAL_GATE",
            details: { artifact_id: artifactId, allowed: ["spec", "design", "implementation"] },
          });
        }
        return engine.prepareReconciliation({ gate: artifactId, ...(changeId ? { changeId } : {}) });
      });
    });
  reconcile
    .command("complete")
    .argument("<artifact-id>", "spec, design, or implementation")
    .argument("[change-id]")
    .addOption(new Option("--verdict <verdict>").choices(["PASS", "CHANGES_REQUIRED", "BLOCKED"]))
    .action(async (
      artifactId: string,
      changeId: string | undefined,
      options: { verdict?: "PASS" | "CHANGES_REQUIRED" | "BLOCKED" },
      command: Command,
    ) => {
      await execute("reconcile.complete", command, (engine) => {
        if (!isApprovalGate(artifactId)) {
          throw Object.assign(new Error(`Unknown reconciliation artifact: ${artifactId}`), {
            code: "INVALID_APPROVAL_GATE",
            details: { artifact_id: artifactId, allowed: ["spec", "design", "implementation"] },
          });
        }
        return engine.completeReconciliation({
          gate: artifactId,
          ...(changeId ? { changeId } : {}),
          ...(options.verdict ? { verdict: options.verdict } : {}),
        });
      });
    });

  program
    .command("validate")
    .description("validate a change and its current gate")
    .argument("[change-id]")
    .option("--strict", "treat warnings as errors", false)
    .action(async (changeId: string | undefined, options: { strict: boolean }, command: Command) => {
      await execute("validate", command, async (engine) => requireValid(
        await engine.validate({ ...(changeId ? { changeId } : {}), strict: options.strict }),
        "VALIDATION_FAILED",
      ));
    });

  program
    .command("preflight")
    .description("validate Runtime installation and a stage before entering it")
    .argument("<stage>", "currently: implementation")
    .argument("[change-id]")
    .option("--change <change-id>", "compatibility alias for the positional Change ID")
    .action(async (
      stage: string,
      positionalId: string | undefined,
      options: { change?: string },
      command: Command,
    ) => {
      await execute("preflight", command, async (engine) => {
        const changeId = resolveChangeId(positionalId, options.change);
        if (stage !== "implementation") {
          throw Object.assign(new Error(`Unknown preflight stage: ${stage}`), {
            code: "INVALID_PREFLIGHT_STAGE",
            details: { stage, allowed: ["implementation"] },
          });
        }
        const cwd = command.optsWithGlobals<GlobalOptions>().cwd ?? process.cwd();
        const installation = await doctorProject(cwd);
        if (!installation.valid) {
          throw Object.assign(new Error("RockSpec installation is not consistent with install.lock.yaml"), {
            code: "PREFLIGHT_INSTALLATION_INVALID",
            details: installation,
          });
        }
        return {
          ...await engine.preflightImplementation({ ...(changeId ? { changeId } : {}) }),
          installation: {
            valid: installation.valid,
            rockspec_version: installation.rockspec_version,
            project_root: installation.project_root,
          },
        };
      });
    });

  program
    .command("gate")
    .description("evaluate a deterministic workflow gate")
    .argument("<gate-id>")
    .argument("[change-id]")
    .action(async (gateId: string, changeId: string | undefined, _options: unknown, command: Command) => {
      await execute("gate", command, async (engine) => requireValid(
        await engine.gate({ gate: gateId, ...(changeId ? { changeId } : {}) }),
        "GATE_FAILED",
      ));
    });

  program
    .command("apply")
    .description("enter implementation after readiness approval")
    .argument("[change-id]")
    .action(async (changeId: string | undefined, _options: unknown, command: Command) => {
      await execute("apply", command, (engine) => engine.apply({ ...(changeId ? { changeId } : {}) }));
    });

  const task = program.command("task").description("manage implementation tasks");
  task.command("list").argument("[change-id]").action(async (changeId: string | undefined, _options: unknown, command: Command) => {
    await execute("task.list", command, (engine) => engine.listTasks({ ...(changeId ? { changeId } : {}) }));
  });
  task.command("next").argument("[change-id]").action(async (changeId: string | undefined, _options: unknown, command: Command) => {
    await execute("task.next", command, (engine) => engine.nextTask({ ...(changeId ? { changeId } : {}) }));
  });
  task.command("brief").argument("<task-id>").argument("[change-id]").action(async (taskId: string, changeId: string | undefined, _options: unknown, command: Command) => {
    await execute("task.brief", command, (engine) => engine.getTaskBrief({ taskId, ...(changeId ? { changeId } : {}) }));
  });
  task.command("start").argument("<task-id>").argument("[change-id]").action(async (taskId: string, changeId: string | undefined, _options: unknown, command: Command) => {
    await execute("task.start", command, (engine) => engine.startTask({ taskId, ...(changeId ? { changeId } : {}) }));
  });
  task.command("complete").argument("<task-id>").argument("[change-id]").option("--commit <sha>").action(async (taskId: string, changeId: string | undefined, options: { commit?: string }, command: Command) => {
    await execute("task.complete", command, (engine) => engine.completeTask({
      taskId,
      ...(changeId ? { changeId } : {}),
      ...(options.commit ? { commitSha: options.commit } : {}),
    }));
  });

  const review = program.command("review").description("prepare immutable Review inputs");
  review
    .command("package")
    .argument("<kind>", "task or delivery")
    .argument("[change-id]")
    .option("--task <task-id>")
    .option("--scope-blocked", "prepare a scope-blocked Task Review package with no product Diff")
    .action(async (
      kind: string,
      changeId: string | undefined,
      options: { task?: string; scopeBlocked?: boolean },
      command: Command,
    ) => {
      await execute("review.package", command, (engine) => {
        if (kind !== "task" && kind !== "delivery") {
          throw Object.assign(new Error("Review package kind must be task or delivery"), {
            code: "INVALID_REVIEW_KIND",
            details: { kind },
          });
        }
        return engine.prepareReviewPackage({
          kind,
          ...(changeId ? { changeId } : {}),
          ...(options.task ? { taskId: options.task } : {}),
          ...(options.scopeBlocked ? { mode: "scope_blocked" as const } : {}),
        });
      });
    });

  const knowledge = program.command("knowledge").description("prepare and inspect reusable knowledge evolution");
  knowledge
    .command("package")
    .description("bind the Knowledge Delta and candidate files for review")
    .argument("[change-id]")
    .action(async (changeId: string | undefined, _options: unknown, command: Command) => {
      await execute("knowledge.package", command, (engine) => engine.prepareKnowledgePackage({
        ...(changeId ? { changeId } : {}),
      }));
    });

  const check = program.command("check").description("execute checks and record bound evidence");
  check
    .command("run")
    .argument("<executable>")
    .argument("[args...]")
    .option("--change <change-id>")
    .option("--kind <kind>", "evidence kind", "verification")
    .option("--task <task-id>")
    .option("--action <action-id>")
    .action(async (
      executable: string,
      args: string[],
      options: { change?: string; kind: string; task?: string; action?: string },
      command: Command,
    ) => {
      await execute("check.run", command, async (engine) => {
        if (options.action && !ACTION_IDS.includes(options.action as ActionId)) {
          throw Object.assign(new Error(`Unknown action: ${options.action}`), {
            code: "INVALID_ACTION",
            details: { action_id: options.action },
          });
        }
        const result = await engine.runCheck({
          executable,
          args,
          kind: options.kind,
          ...(options.change ? { changeId: options.change } : {}),
          ...(options.task ? { taskId: options.task } : {}),
          ...(options.action ? { actionId: options.action as ActionId } : {}),
        });
        if (result.check.exit_code !== 0) {
          throw Object.assign(new Error(`Check failed with exit code ${result.check.exit_code}`), {
            code: "CHECK_FAILED",
            details: result.check,
          });
        }
        return result;
      });
    });

  const evidence = program.command("evidence").description("record fresh verification evidence");
  evidence
    .command("add")
    .argument("[change-id]")
    .requiredOption("--command <command>")
    .requiredOption("--exit-code <number>", "process exit code", integer)
    .option("--kind <kind>", "evidence kind", "verification")
    .option("--workdir <path>")
    .option("--started-at <iso-time>")
    .option("--finished-at <iso-time>")
    .option("--commit <sha>")
    .option("--task <task-id>")
    .option("--action <action-id>")
    .option("--report <path>")
    .action(async (changeId: string | undefined, options: {
      command: string;
      exitCode: number;
      kind: string;
      workdir?: string;
      startedAt?: string;
      finishedAt?: string;
      commit?: string;
      task?: string;
      action?: string;
      report?: string;
    }, command: Command) => {
      await execute("evidence.add", command, (engine) => {
        if (options.action && !ACTION_IDS.includes(options.action as ActionId)) {
          throw Object.assign(new Error(`Unknown action: ${options.action}`), {
            code: "INVALID_ACTION",
            details: { action_id: options.action },
          });
        }
        return engine.recordEvidence({
          command: options.command,
          exitCode: options.exitCode,
          kind: options.kind,
          ...(changeId ? { changeId } : {}),
          ...(options.workdir ? { cwd: options.workdir } : {}),
          ...(options.startedAt ? { startedAt: options.startedAt } : {}),
          ...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
          ...(options.commit ? { commit: options.commit } : {}),
          ...(options.task ? { taskId: options.task } : {}),
          ...(options.action ? { actionId: options.action as ActionId } : {}),
          ...(options.report ? { reportPath: options.report } : {}),
        });
      });
    });

  program.command("verify").argument("[change-id]").action(async (changeId: string | undefined, _options: unknown, command: Command) => {
    await execute("verify", command, (engine) => engine.verify({ ...(changeId ? { changeId } : {}) }));
  });

  program
    .command("finish")
    .argument("[change-id]")
    .addOption(new Option("--disposition <choice>").choices(["local_merge", "push", "keep"]).default("keep"))
    .action(async (changeId: string | undefined, options: { disposition: "local_merge" | "push" | "keep" }, command: Command) => {
      await execute("finish", command, (engine) => engine.finish({ disposition: options.disposition, ...(changeId ? { changeId } : {}) }));
    });

  program.command("archive").argument("[change-id]").action(async (changeId: string | undefined, _options: unknown, command: Command) => {
    await execute("archive", command, (engine) => engine.archive({ ...(changeId ? { changeId } : {}) }));
  });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = error.exitCode;
      return;
    }
    const failure = failureEnvelope("parse", error);
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = errorExitCode(error);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function integer(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${value} is not an integer`);
  return parsed;
}

function isApprovalGate(value: string): value is "spec" | "design" | "implementation" {
  return value === "spec" || value === "design" || value === "implementation";
}

function resolveChangeId(positionalId?: string, optionId?: string): string | undefined {
  if (positionalId && optionId && positionalId !== optionId) {
    throw Object.assign(new Error("Positional Change ID and --change must identify the same Change"), {
      code: "CHANGE_ID_CONFLICT",
      details: { positional_change_id: positionalId, option_change_id: optionId },
    });
  }
  return optionId ?? positionalId;
}

function parseInstallHosts(value: string): InstallHost[] {
  const hosts = value.split(",").map((host) => host.trim()).filter(Boolean);
  for (const host of hosts) {
    if (host !== "codex" && host !== "claude") {
      throw Object.assign(new Error(`Unknown host: ${host}`), {
        code: "INVALID_HOST",
        details: { host, allowed: ["codex", "claude"] },
      });
    }
  }
  return [...new Set(hosts)] as InstallHost[];
}

function parseExternalSkills(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw Object.assign(new Error(`External Skill must use name=path: ${value}`), {
        code: "INVALID_EXTERNAL_SKILL",
        details: { value },
      });
    }
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function requireValid<T extends { valid: boolean; errors: unknown[] }>(result: T, code: string): T {
  if (result.valid) return result;
  throw Object.assign(new Error("RockSpec validation did not pass"), {
    code,
    details: { errors: result.errors, result },
    exitCode: 1,
  });
}
