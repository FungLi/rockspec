# RockSpec

RockSpec is a host-neutral Harness Engineering workflow for repository changes. It keeps lifecycle state in a deterministic Engine while Codex or Claude Code orchestrates bounded authors, implementers, reviewers, acceptance testing, and delivery review.

This repository is an initial working MVP. It provides the protocol and CLI workspace, risk-adaptive workflow contracts, composable capability Skills, role prompts, artifact templates, and Codex/Claude Code plugin manifests.

## What is exposed

RockSpec exposes focused user capabilities rather than internal roles or state-machine steps:

- `rockspec-change`: route or orchestrate a complete governed change.
- `rockspec-triage`: assess risk and select Lite, Standard, or Strict.
- `rockspec-requirements`: create, import, and review behavioral requirements.
- `rockspec-design`: create a repository-grounded technical design.
- `rockspec-prototype`: create a governed or standalone UI/UX prototype.
- `rockspec-plan`: create and review an implementation-ready task plan.
- `rockspec-implement`: execute focused tasks with commits and evidence.
- `rockspec-review`: independently review a Task, branch, or Final CR subject.
- `rockspec-acceptance`: run independent acceptance/TE before Final CR.
- `rockspec-finish`: verify, finish, and archive a completed change.
- `rockspec-evolve`: extract reviewed, reusable product, architecture, and experience knowledge before archive.
- `rockspec-debug`: establish a reproducible feedback loop, confirm root cause, and hand off a governed fix.
- `rockspec-research`: explore a business problem with traceable evidence before requirements are written.
- `rockspec-worktree`: prepare, locate, resume, and safely finish a Change-level isolated Git worktree.

Each Skill owns one useful outcome and may be invoked directly. `rockspec-change` is a thin router over those Skills, not a second implementation of their workflows. Fine-grained state transitions remain internal Action IDs in each owning Skill's `references/`; BA/SA/DEV/CR/TE identities remain Role prompts rather than Skills.

Atomic Skills support two modes:

- Attached: operate on a legal active Change and participate in Engine gates.
- Standalone: start from an existing PRD, Design, Plan, diff, or acceptance target under `.rockspec/workbench/`; the result does not claim governed approvals or end-to-end completion.

The Engine is the only writer for attached change state, events, approvals, hashes, and gate results.

## Workflow profiles

- Lite: narrow local changes such as an unambiguous button-label update; Brief, inline implementation, focused verification, finish.
- Standard: Spec, Design, Plan, three user approvals, per-Task implementation/review, independent Acceptance, then Final CR.
- Strict: Standard plus two independent reviewers at Requirements, Readiness, Task, and Delivery gates and fuller regression evidence.

Profiles only promote automatically: `lite -> standard -> strict`. Final CR always runs after Acceptance so it includes TE-created tests and any Remediation Tasks. Changes created with `--uat required` pause at `UAT_PENDING` after Acceptance until the user confirms the approved Scenarios against the frozen Commit; optional or non-applicable UAT adds no stop.

## Install into a project

Prerequisites are Git and Node.js 20.19 or newer. After `@rockspec/cli` is published, run the installer from the target Git repository:

```bash
npx -y @rockspec/cli@latest
```

The default command opens a guided installer for the project path, Codex/Claude Code hosts, the optional UI prototype Provider, a preview, and final confirmation. CI and reproducible setup can use the non-interactive form:

```bash
npx -y @rockspec/cli@latest install \
  --project . \
  --hosts codex,claude \
  --without ui.prototype \
  --yes
```

To include `ui-ux-pro-max`, point the installer at an existing trusted local copy. Its current License metadata is unknown, so acceptance must be explicit:

```bash
npx -y @rockspec/cli@latest install \
  --project . \
  --hosts codex,claude \
  --external-skill ui-ux-pro-max=/absolute/path/to/ui-ux-pro-max \
  --accept-unknown-license \
  --yes
```

The guided installer can also discover `ui-ux-pro-max` from `~/.agents/skills/` or `~/.claude/skills/`. RockSpec never executes external Skill scripts during installation. It validates the Skill name and path containment, copies transparent files into the project, records provenance and integrity, and then discovers the installed Provider automatically at runtime.

The managed project layout is:

```text
<git-root>/
├── .agents/skills/<skill>/          # canonical project Skills for Codex
├── .claude/skills/<skill>           # relative symlinks; copies on Windows
└── .rockspec/
    ├── bin/rockspec.mjs             # self-contained project Runtime
    ├── config.yaml                  # workflow configuration
    ├── install.lock.yaml            # ownership, source, License and integrity
    └── third-party-notices.md
```

Commit these managed files so new branches and Worktrees inherit the same workflow without rerunning `rockspec init` or `rockspec install`. Maintenance commands are `rockspec doctor`, `rockspec repair`, `rockspec upgrade`, and `rockspec uninstall --yes`. Upgrade and repair refuse to overwrite locally modified managed paths; uninstall removes only unchanged managed files and preserves `.rockspec/config.yaml`, Changes, workbench artifacts, Specs, and evidence.

This repository currently builds the npm-ready package but does not claim that `@rockspec/cli` has been published. For a source checkout, use the same release Runtime directly:

```bash
pnpm build:release
node packages/cli/release/distribution/runtime/rockspec.mjs install \
  --project /path/to/target-repository \
  --hosts codex,claude \
  --without ui.prototype \
  --yes
```

## Development quick start

Prerequisites are Git, Node.js 20.19 or newer, and pnpm 10.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm rockspec --help
```

Use the CLI's current help for exact development arguments:

```bash
rockspec init
rockspec status --view summary --json
```

In an installed project, these `rockspec ...` examples are logical commands rather than a required global executable. Read `rockspec.runtime_path` from `.rockspec/install.lock.yaml`, verify it against the lock integrity, and invoke it from the repository root as `node <runtime_path> ...` (normally `node .rockspec/bin/rockspec.mjs ...`). Do not search the machine or package manifests for another CLI when the install lock exists.

Status defaults to the compact `summary` projection. Use `--view tasks`, `--view recovery`, or `--view hashes` for targeted machine context and `--view full` only for Runtime diagnosis. Other commands that return a status snapshot accept the global `--summary` option, for example `rockspec --summary --json action complete ...`.

CLI invocations append privacy-safe operational telemetry to `.rockspec/telemetry/commands.ndjson`. The log contains command categories, timestamps, duration, result/error codes, response size, and the Change ID when available; it never records command arguments, prompts, source text, or feedback content. Telemetry failure never changes a governed command result. Inspect one Change with:

```bash
rockspec telemetry report <change-id> --json
```

During an attached Standard/Strict Task, the implementation loop uses Engine-owned inputs and evidence:

```bash
rockspec task start T-001 <change-id>
rockspec task brief T-001 <change-id>
rockspec check run --change <change-id> --task T-001 --scenario S-001 -- pnpm test
rockspec review package task <change-id> --task T-001
# Only when the Task contract itself must be revised before a product Commit:
rockspec review package task <change-id> --task T-001 --scope-blocked
rockspec action complete task.review <change-id> --verdict PASS
rockspec task complete T-001 <change-id>
```

Before the first implementation approval or an implementation reconciliation, run the combined preflight:

```bash
rockspec preflight implementation <change-id>

Projects may declare non-secret environment probes in `.rockspec/config.yaml` under `environment_preflight` (database, browser, credential, or custom). Run `rockspec preflight environment <change-id>` before implementation; failed required probes stop the gate without printing probe output. Run `rockspec preflight acceptance <change-id>` before submitting Acceptance so report, Scenario, Evidence, Artifact, Commit, and execution bindings are checked together.
```

It verifies the installed Runtime/Skill hashes, approval and Readiness freshness, Task graph viability, active Recovery state, and availability of both normal product Review and zero-Diff scope-blocked Review paths.

Task `allowed_paths` are the Plan's expected paths, not a product Diff whitelist. Task Review Packages report `planned_paths`, `changed_paths`, and `expanded_paths`; Reviewers record one structured `scope_assessment` for every expanded path, accept justified expansions, and raise Findings for unrelated changes or genuine Task-contract gaps. After Acceptance, use `rockspec review package delivery <change-id>` for the Final CR subject. Review reports bind the exact base commit, head commit, and Diff hash. `rockspec check run` executes the command itself and binds the stored log, Scenario/Finding IDs, and produced artifacts to the current Commit; Acceptance requires exact coverage of every approved Scenario. `rockspec evidence add` remains available for manual or external evidence but cannot satisfy Standard/Strict executed-evidence gates.

Human approvals are bound to a deterministic summary rather than a conversational acknowledgement:

```bash
rockspec approval package spec <change-id>
rockspec approve spec <change-id> --package <sha256>
```

The same two-step command applies to Design and Implementation. Reviewer and author executions are registered through `rockspec execution start`; `task start` registers its Implementer directly and binds the frozen Brief as a Role Context Package. As soon as an Agent returns and its output is persisted, record `rockspec execution complete <execution-id> <change-id> --outcome success|error|cancelled` and, when available, the Host Adapter usage receipt (`--input-tokens`, `--cached-input-tokens`, `--output-tokens`, `--reasoning-tokens`); this keeps Agent time and cost separate from Runtime and human wait. The Engine validates role/action compatibility and report identity against that registry, while Skills and Host Adapters remain responsible for selecting the configured model tier and passing only a Role-specific Context Package. Plain-text Stage Review `PASS` reports and placeholder content are rejected.

Cross-stage Findings declare `classification` and `authority_impact`. Changes to intent, approved Authority decisions, accepted risk, or unknown authority return to the user. Severity controls how strongly a Finding blocks and how deeply it is verified; it does not by itself turn an internal technical correction into a product decision. A consistency, derived, or implementation fix can automatically renew a Gate only when that Gate already has a human-approved Authority Baseline and an independent Reviewer confirms that the boundary is unchanged. Critical automatic reconciliation remains blocked until a Deep independent review proves the correction:

```bash
rockspec revise <change-id> \
  --source design.technical \
  --target design \
  --reason "Synchronize an approved derived detail" \
  --affected D-001 \
  --classification consistency_fix \
  --authority-impact unchanged \
  --author-execution <execution-id>

rockspec reconcile prepare design <change-id>
rockspec reconcile complete design <change-id> --verdict PASS
```

For implementation-time Finding recovery, use the fail-closed command below instead of copying Review IDs, Finding IDs, source, target, classification, and Authority Impact from status output:

```bash
rockspec recover apply <change-id> \
  --affected D-001 \
  --author-execution <revision-author-execution-id>
```

The Engine consumes every current Open Finding and automatically chooses whether to open a Revision or append an Amendment to the existing audit chain. `--author-execution` remains mandatory when the resulting Revision is eligible for automatic reconciliation.

Requirements and Readiness Reviewer reports use structured Frontmatter. Non-PASS reports must contain at least one Open Finding; the Engine preserves every Reviewer source and Finding and rejects unstructured non-PASS reports.

The first Spec, Design, and Implementation approvals are always human. Automatic reconciliation only renews approvals invalidated by the active Revision, uses a Reviewer execution different from the Revision Author, and escalates after two unsuccessful rounds.

Requirements and Design use decision-driven interaction. Artifact sections remain complete, but they are not conversation checkpoints. The author pauses only when multiple reasonable choices would produce different product outcomes, compatibility commitments, irreversible architecture/migration commitments, operating-cost boundaries, or accepted risk, and the answer cannot be derived from approved intent or repository policy. Related choices are grouped into one Decision Package; ordinary engineering choices are documented and independently reviewed. No new Authority choice means no new confirmation stop.

Commit the project-managed RockSpec Skills, Runtime, install lock, `.rockspec/config.yaml`, and baseline Specs before starting parallel work. A linked worktree inherits those assets from Git and must not run `rockspec init` or reinstall RockSpec.

Invoke `$rockspec-change` for end-to-end delivery. It calls `$rockspec-worktree` when isolation or cross-worktree resume is needed, then creates a new Change through the Engine inside the selected workspace. Users do not run `rockspec new` during the normal workflow; it remains a low-level CLI for orchestration and tests. Invoke an atomic Skill such as `$rockspec-design`, `$rockspec-review`, or `$rockspec-acceptance` to begin at a specific capability. In Attached mode, every CLI status result names both `recommended_next.action` and the atomic `recommended_next.entry_skill` responsible for it.

Worktree isolation is Change-level in the MVP. The default managed branch is `rockspec/<change-id>` and the default project-local path is `.worktrees/<change-id>`. Requirements, Design, and Plan stay inline in that workspace; every Implementer, Reviewer, and Acceptance worker receives its bound `cwd`. Task-level parallel worktrees, automatic stash/rebase, and semantic conflict resolution remain out of scope.

Use `$rockspec-debug` and `$rockspec-research` as independent scene capabilities. They run inline, do not add Engine Actions, and do not enter the main Change Recipe automatically. Debug artifacts are written under `.rockspec/workbench/debug/<slug>/`; business research artifacts are written under `.rockspec/workbench/research/<slug>/`. A confirmed diagnosis can be handed to the appropriate governed change capability, while research enters `$rockspec-requirements` only after the user decides to proceed.

## UI prototype Provider

RockSpec binds the capability `ui.prototype` to `ui-ux-pro-max` by default. The npm distribution does not bundle or redistribute this Provider. The installer may copy a user-supplied or locally discovered Skill into the target project's canonical Skill root after explicit License acceptance; the install lock then makes it available to both hosts and automatic capability discovery. If it is unavailable, the Engine blocks that action with recovery guidance.

Installer-managed Providers are discovered automatically. The repeatable global option and comma-separated environment variable remain available for temporary host-provided Skills:

```bash
node packages/cli/dist/bin.js --provider ui-ux-pro-max status --view summary --json
ROCKSPEC_AVAILABLE_PROVIDERS=ui-ux-pro-max node packages/cli/dist/bin.js status --view summary --json
```

Use the same declaration on the action-completion/gate invocation after Provider output is written.

Prototype artifacts live under the target repository root:

```text
.rockspec/changes/<change-id>/prototype/
├── brief.md
├── design-system.md
├── prototype.md
└── assets/
```

## Repository map

```text
packages/                 Protocol, Engine, capabilities, and CLI
skills/                   Self-contained orchestrator and capability Skills
adapters/                 Codex and Claude Code host contracts
.codex-plugin/            Codex plugin manifest
.claude-plugin/           Claude Code plugin manifest
```

All target-project artifacts are rooted at `<git-root>/.rockspec/`. The MVP supports one RockSpec root per Git repository and does not require a GitHub or GitLab PR.

## MVP boundaries

- Atomic Skills call each host's native Agent/Task primitives through the documented adapters. The Engine records execution ownership and validates outputs, but it does not embed a host-specific Agent SDK.
- New Changes persist a portable current/worktree and branch binding. Mutating Engine operations fail closed when invoked from the wrong workspace, and one workspace cannot host two active Changes.
- Each published Skill directly owns its Action/Role contracts and reusable artifact templates under `references/` and `assets/`. `pnpm check:skills` validates that Action ownership, local references, and host manifests remain complete, so copying one Skill directory does not leave broken repository-relative dependencies.
- Archive currently promotes validated Change Spec files into the baseline by deterministic file copy. Semantic conflict handling across complex `MODIFIED`, `REMOVED`, and `RENAMED` deltas is deferred.
- Proposal, Design, Task, Review, Acceptance, and UAT Frontmatter are validated. Cross-file R/S/D traceability, exact Scenario-to-executed-Evidence coverage, whole-plan DAG cycles, producer/consumer dependency contracts, scope-expansion assessments, one-Task-one-Commit history, and executed-evidence gates are enforced. Individual UT/IT/E2E IDs remain report metadata; the mandatory machine boundary is approved Scenario to executed Evidence.
- Task and Delivery Review source reports are parsed as structured Markdown Frontmatter. Reviewer execution identity, immutable Review Subject, rounds, Findings, strict source independence, source hashes, and blocking verdict rules are enforced; Strict aggregate prose remains a presentation layer over the preserved source reports.
- State mutations use a recovery journal so interrupted snapshot/event writes converge or fail closed on conflict. This is crash-consistency protection, not a cryptographic defense against a writer with repository access.
- Verification freezes `delivery_head`. Finish and Archive accept later descendant commits from sequential Changes in a shared Worktree, but reject rewritten or diverged history that no longer contains the frozen delivery Commit.
- Plugin manifests and shared Skills are validated locally. The npm release package and isolated project installation are tested; marketplace publication and live discovery/dispatch tests inside both host applications remain release work.
- Action and Recipe YAML files are transparent Agent guidance, not an executable configuration language. Engine behavior is authoritative in `packages/engine/src/workflow.ts` and is checked against those YAML contracts in `tests/host-assets.test.ts`.
- `ui-ux-pro-max` is not included in the RockSpec source or npm distribution. The installer can copy an explicitly accepted local source into a target project and records it as externally owned.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm check:skills
pnpm validate:skills
pnpm validate:plugin
```

RockSpec is licensed under MIT. External projects were studied as design references but are not runtime dependencies or redistributed plugin content; see `THIRD_PARTY_NOTICES.md`.
