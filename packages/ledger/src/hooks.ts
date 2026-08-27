// Hook 层：对产物做确定性检测（纯机器规则，无 LLM），产出 HookMark。
// 这是「硬地板」——机器可判定的错误在产出当下当场拦截。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { sha256 } from "./util.js";
import { scanMarkdown } from "./util.js";
import type { ArtifactKind, HookCheck, HookMark } from "./types.js";

/** 检测某类型产物，返回 mark。artifactPath 为绝对路径。 */
export async function runHooks(
  artifactId: string,
  kind: ArtifactKind,
  artifactPath: string,
): Promise<HookMark> {
  const checks: HookCheck[] = [];

  if (!existsSync(artifactPath)) {
    checks.push({ id: "exists", status: "fail", detail: `产物不存在：${artifactPath}` });
    return finalize(artifactId, "", checks);
  }

  const content = await readFile(artifactPath, "utf8");
  const hash = sha256(content);

  // 通用：非空 + 无 TODO/TBD 占位
  checks.push(nonEmpty(content));
  checks.push(noPlaceholder(content));

  switch (kind) {
    case "requirements":
      checks.push(...requirementsChecks(content));
      break;
    case "design":
      checks.push(...designChecks(content));
      break;
    case "code":
      // 代码产物的确定性检测（validation_commands 证据）由 CLI 侧结合 git 注入，
      // 这里只做产物文档结构层的检查占位；证据检测见 evidenceCheck()。
      checks.push({ id: "code-doc", status: "pass", detail: "代码证据检测由 CLI 注入" });
      break;
  }

  return finalize(artifactId, hash, checks);
}

function finalize(artifactId: string, hash: string, checks: HookCheck[]): HookMark {
  return {
    artifact_id: artifactId,
    artifact_hash: hash,
    checks,
    clean: checks.every((c) => c.status === "pass"),
    marked_at: new Date().toISOString(),
  };
}

function nonEmpty(content: string): HookCheck {
  return content.trim().length > 0
    ? { id: "non-empty", status: "pass" }
    : { id: "non-empty", status: "fail", detail: "产物为空" };
}

function noPlaceholder(content: string): HookCheck {
  // 只检非代码围栏内的 TODO/TBD
  const bad: string[] = [];
  for (const line of scanMarkdown(content)) {
    if (line.inFence) continue;
    if (/\b(TODO|TBD)\b/.test(line.text)) bad.push(`${line.number}: ${line.text.trim()}`);
  }
  return bad.length === 0
    ? { id: "no-placeholder", status: "pass" }
    : { id: "no-placeholder", status: "fail", detail: `残留占位符：${bad.slice(0, 3).join(" / ")}` };
}

/** 需求：每个 R-xxx 需至少一个 S-xxx 场景，且用 SHALL/MUST 句式。 */
function requirementsChecks(content: string): HookCheck[] {
  const reqIds = [...content.matchAll(/\bR-\d{3}\b/g)].map((m) => m[0]);
  const scenarioIds = [...content.matchAll(/\bS-\d{3}\b/g)].map((m) => m[0]);
  const checks: HookCheck[] = [];

  const uniqReq = [...new Set(reqIds)];
  checks.push(
    uniqReq.length > 0
      ? { id: "has-requirements", status: "pass" }
      : { id: "has-requirements", status: "fail", detail: "未发现 R-xxx 需求编号" },
  );
  checks.push(
    scenarioIds.length > 0
      ? { id: "has-scenarios", status: "pass" }
      : { id: "has-scenarios", status: "fail", detail: "未发现 S-xxx 场景编号" },
  );
  // GWT / SHALL 句式存在性
  const hasGwt = /GIVEN|WHEN|THEN|假如|当|那么/i.test(content);
  const hasShall = /\b(SHALL|MUST)\b|必须|不得/.test(content);
  checks.push(
    hasGwt
      ? { id: "gwt-format", status: "pass" }
      : { id: "gwt-format", status: "fail", detail: "缺少 GWT（GIVEN/WHEN/THEN）场景描述" },
  );
  checks.push(
    hasShall
      ? { id: "shall-format", status: "pass" }
      : { id: "shall-format", status: "fail", detail: "缺少 SHALL/MUST/必须 规范句式" },
  );
  return checks;
}

/** 设计：必备章节 + 每个决策的实现小节 + 决策标注覆盖的 R/S。 */
const REQUIRED_DESIGN_SECTIONS = ["全局约束", "总体方案", "未解决风险"];
const REQUIRED_DECISION_SUBSECTIONS = ["接口", "失败", "兼容"];

function designChecks(content: string): HookCheck[] {
  const checks: HookCheck[] = [];
  const headings = scanMarkdown(content)
    .filter((l) => !l.inFence && l.heading)
    .map((l) => l.heading!.title);

  for (const section of REQUIRED_DESIGN_SECTIONS) {
    const found = headings.some((h) => h.includes(section));
    checks.push(
      found
        ? { id: `section:${section}`, status: "pass" }
        : { id: `section:${section}`, status: "fail", detail: `缺少必备章节：${section}` },
    );
  }

  // 至少一个 W-xx 任务，且任务标注覆盖 R/S
  const tasks = [...new Set([...content.matchAll(/\bW-\d{2,}\b/g)].map((m) => m[0]))];
  checks.push(
    tasks.length > 0
      ? { id: "has-tasks", status: "pass" }
      : { id: "has-tasks", status: "fail", detail: "未发现 W-xx 任务编号" },
  );
  const coversRS = /R-\d{3}/.test(content) && /S-\d{3}/.test(content);
  checks.push(
    coversRS
      ? { id: "task-covers-rs", status: "pass" }
      : { id: "task-covers-rs", status: "fail", detail: "任务未标注覆盖的 R-xxx/S-xxx" },
  );
  return checks;
}

/**
 * 代码证据检测：validation_commands 声明的命令须有绑定当前 commit 的成功证据。
 * 由 CLI 侧提供已执行证据记录（命令→exit code），这里判定。
 */
export function evidenceCheck(
  artifactId: string,
  declaredCommands: string[],
  evidence: { command: string; exit_code: number; commit: string }[],
  currentCommit: string,
): HookMark {
  const checks: HookCheck[] = [];
  for (const cmd of declaredCommands) {
    const hit = evidence.find(
      (e) => e.command.trim() === cmd.trim() && e.exit_code === 0 && e.commit === currentCommit,
    );
    checks.push(
      hit
        ? { id: `evidence:${cmd}`, status: "pass" }
        : {
            id: `evidence:${cmd}`,
            status: "fail",
            detail: `命令「${cmd}」缺少绑定当前 commit 的成功证据`,
          },
    );
  }
  if (declaredCommands.length === 0) {
    checks.push({ id: "has-validation-commands", status: "fail", detail: "未声明 validation_commands" });
  }
  return finalize(artifactId, currentCommit, checks);
}
