// rockspec2 CLI：PM 编排新架构的命令入口。
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { Ledger, LedgerError } from "./ledger.js";
import type { RigorLevel } from "./types.js";
import { renderFinishCheck, renderMark, renderResume, renderWorklist } from "./render.js";

interface GlobalOpts {
  json?: boolean;
  repo?: string;
}

function ledgerFor(cmd: Command): Ledger {
  const opts = cmd.optsWithGlobals() as GlobalOpts;
  return new Ledger(opts.repo ?? process.cwd());
}

function isJson(cmd: Command): boolean {
  return (cmd.optsWithGlobals() as GlobalOpts).json === true;
}

function emit(cmd: Command, human: string, data: unknown): void {
  if (isJson(cmd)) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
}

/** 读结论：从 --file 读 YAML/JSON，或从 stdin。 */
async function readConclusion(file?: string): Promise<unknown> {
  let raw: string;
  if (file) raw = await readFile(file, "utf8");
  else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return parseYaml(trimmed);
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("rockspec2")
    .description("RockSpec PM 编排架构：Ledger + 对抗制衡 + 确定性 Hook")
    .option("--json", "输出 JSON", false)
    .option("--repo <path>", "仓库根目录（默认当前目录）");

  program
    .command("new")
    .description("创建一个 Change")
    .argument("<change-id>")
    .option("--rigor <level>", "放漂级别 L1|L2|L3", "L1")
    .action(async (changeId: string, opts: { rigor: string }, cmd: Command) => {
      const meta = await ledgerFor(cmd).createChange(changeId, opts.rigor as RigorLevel);
      emit(cmd, `已创建 Change：${meta.id}（放漂 ${meta.config.rigor}）`, meta);
    });

  program
    .command("status")
    .description("查看 Change 状态")
    .argument("<change-id>")
    .option("--view <view>", "worklist|resume", "worklist")
    .action(async (changeId: string, opts: { view: string }, cmd: Command) => {
      const wl = await ledgerFor(cmd).worklist(changeId);
      const human = opts.view === "resume" ? renderResume(wl) : renderWorklist(wl);
      emit(cmd, human, wl);
    });

  program
    .command("making")
    .description("标记进入生产，返回调度模式（inline|subagent）")
    .argument("<change-id>")
    .argument("<artifact-id>")
    .action(async (changeId: string, artifactId: string, _o: unknown, cmd: Command) => {
      const r = await ledgerFor(cmd).startMaking(changeId, artifactId);
      emit(cmd, `${artifactId} 进入生产，模式：${r.mode}`, r);
    });

  program
    .command("conclude-maker")
    .description("提交生产者结论（--file 或 stdin）")
    .argument("<change-id>")
    .option("--file <path>", "结论文件（YAML/JSON）")
    .action(async (changeId: string, opts: { file?: string }, cmd: Command) => {
      const raw = await readConclusion(opts.file);
      const r = await ledgerFor(cmd).submitMaker(changeId, raw);
      emit(cmd, r.escalated ? "已提交，含 blockers → 升级人裁决" : "已提交生产者结论", r);
    });

  program
    .command("check")
    .description("运行 hook 确定性检测并记录 mark")
    .argument("<change-id>")
    .argument("<artifact-id>")
    .action(async (changeId: string, artifactId: string, _o: unknown, cmd: Command) => {
      const mark = await ledgerFor(cmd).check(changeId, artifactId);
      emit(cmd, renderMark(mark), mark);
      if (!mark.clean) process.exitCode = 1;
    });

  program
    .command("conclude-checker")
    .description("提交制衡者结论（校验 subject_hash 绑定）")
    .argument("<change-id>")
    .option("--file <path>", "结论文件（YAML/JSON）")
    .action(async (changeId: string, opts: { file?: string }, cmd: Command) => {
      const raw = await readConclusion(opts.file);
      const r = await ledgerFor(cmd).submitChecker(changeId, raw);
      emit(cmd, `制衡结论已登记，裁决：${r.verdict}`, r);
    });

  program
    .command("finish-check")
    .description("预检 Finish 不变式（不改状态）")
    .argument("<change-id>")
    .action(async (changeId: string, _o: unknown, cmd: Command) => {
      const r = await ledgerFor(cmd).finishCheck(changeId);
      emit(cmd, renderFinishCheck(r), r);
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("finish")
    .description("执行 finish（仅当 Finish 不变式通过）")
    .argument("<change-id>")
    .action(async (changeId: string, _o: unknown, cmd: Command) => {
      await ledgerFor(cmd).finish(changeId);
      emit(cmd, `Change ${changeId} 已 finish`, { finished: true });
    });

  program
    .command("archive")
    .description("归档已 finish 的 Change")
    .argument("<change-id>")
    .action(async (changeId: string, _o: unknown, cmd: Command) => {
      await ledgerFor(cmd).archive(changeId);
      emit(cmd, `Change ${changeId} 已归档`, { archived: true });
    });

  program
    .command("list")
    .description("列出所有 Change")
    .action(async (_o: unknown, cmd: Command) => {
      const ids = await ledgerFor(cmd).list();
      emit(cmd, ids.length ? ids.join("\n") : "（无 Change）", ids);
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof LedgerError) {
      const opts = program.opts() as GlobalOpts;
      if (opts.json) process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details }, null, 2)}\n`);
      else process.stderr.write(`RockSpec2 ${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    // commander 的正常退出（help/version）
    if (error instanceof Error && "code" in error && (error as { code: string }).code.startsWith("commander.")) {
      return;
    }
    throw error;
  }
}
