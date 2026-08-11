# Worktree 协议

## 1. 检测

先读取 Git 的确定性事实：

```bash
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree
git symbolic-ref --quiet --short HEAD
git status --short
git worktree list --porcelain
```

`git-dir` 与 `git-common-dir` 不同时通常位于 linked Worktree，但 Submodule 也可能产生相似形态；`--show-superproject-working-tree` 非空时按 Submodule 处理，不把它误认成 RockSpec 隔离工作区。Detached HEAD 可以读取和调查，但全新受治理 Change 需要明确分支。

## 2. 选择规则

按以下优先级选择：

1. 用户或项目配置明确指定的模式。
2. 用户点名 Change 已绑定的已注册 Worktree。
3. 当前目录已绑定目标 Change。
4. 存在其他 Active Change、当前目录有未归属改动或用户要求并行时创建 Worktree。
5. 仓库干净且没有其他 Active Change 时，Lite 可以使用 current；Standard 推荐 Worktree，Strict 默认推荐 Worktree。

一个 Worktree 同时只能推进一个 Active Change。同一个 Change 也不能由多个 Worktree 或多个编码会话并发推进。

## 3. 创建

默认值：

```text
branch = rockspec/<change-id>
path   = <repo-root>/.worktrees/<change-id>
base   = 用户指定目标分支，否则当前已确认目标分支
```

创建前验证：

- `git check-ref-format --branch <branch>` 成功。
- 分支、路径和已注册 Worktree 不与其他 Change 冲突。
- Base 是明确 Commit，且包含项目管理的 RockSpec Skill、`.rockspec/config.yaml` 和需要的基线 Specs。
- `.worktrees/` 已被 `git check-ignore` 忽略。未忽略时把 `/.worktrees/` 写入 Git common directory 下的 `info/exclude`；不要修改 `.gitignore`。
- 当前未提交修改得到归属。无关修改留在原目录；可能属于目标 Change 的修改必须由用户决定如何保留。

优先使用宿主原生 Worktree 能力。没有原生能力时才执行：

```bash
git worktree add <path> -b rockspec/<change-id> <base-commit>
```

创建失败时报告 Git 原始错误和已产生资源，不自动回退到共享工作目录，也不删除无法证明由本次创建的路径。

## 4. Setup 与基线

读取仓库说明、锁文件和已有脚本，使用项目规定的包管理器和命令。不得因为看到 `package.json` 就默认运行 `npm install`。Setup 或基线测试未配置时记录 `SKIPPED` 和原因；执行失败时记录 `FAILED` 并停止实施。

全新 Change 必须在目标 Worktree 中创建，使 `change.yaml`、事件、审批和后续 Commit 从一开始属于同一分支。项目资产已由 Git 继承，因此不得重新执行 `rockspec init`。已有 Change 恢复时不得再次创建。

## 5. 绑定与续作

`change.yaml.workspace` 绑定模式和分支；绝对路径不进入版本控制。每个修改型 Engine 操作必须比较当前 Git 上下文与绑定：

- `mode=worktree` 时当前目录必须是 linked Worktree。
- 有绑定分支时当前分支必须完全相等。
- Detached HEAD、错误分支或普通 Checkout 不能推进绑定 Worktree 的 Change。

恢复时只扫描 `git worktree list --porcelain` 返回的已注册根目录。Change ID 唯一匹配时继续；零个、多个、损坏或无法读取时 Fail Closed。不要扫描任意父目录或全磁盘。

## 6. Subagent

Task Brief、Reviewer Brief 和 Acceptance Brief 必须携带绑定工作区根目录。Host Adapter 必须把 Worker 的实际 `cwd` 固定在该目录；宿主无法保证时阻塞并行实施，不得回退到调用方当前目录。Engine 仍通过分支、Commit 和工作区绑定验证提交归属。

## 7. 收尾与冲突

多个 Change 可以独立达到 `READY_TO_FINISH`，但同一目标分支的更新必须串行。每次本地合并都基于目标分支最新 Commit，合并后运行与风险匹配的验证。

只允许自动处理不改变已批准行为的机械冲突。冲突需要改变 Requirement、Design 或验收结果时停止，保留 Change 分支和 Worktree，并由用户决定是否创建集成 Change。

删除 Worktree 的必要条件：

- 用户的 Finish 选择明确授权清理。
- Worktree 没有未提交或未归属修改。
- Change 分支已经按选择合并、推送或明确不再需要本地工作区。
- 路径和分支仍唯一绑定当前 Change。

清理失败不触发强制删除、分支删除或重试式破坏操作。
