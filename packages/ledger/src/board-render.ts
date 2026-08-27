// 看板渲染：终端 ASCII 视图 + board.md 只读镜像文件。
import type { Board, BoardCard, BoardColumn } from "./types.js";

const COLUMN_LABELS: Record<BoardColumn, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
};

function ownerLabel(card: BoardCard): string {
  if (card.owner === "human") return "👤 人";
  if (card.owner === null) return "—";
  return card.owner.toUpperCase();
}

function cardLine(card: BoardCard): string {
  const owner = ownerLabel(card);
  const dep = card.blocked_by.length ? ` ⟨阻塞:${card.blocked_by.join(",")}⟩` : "";
  const v = card.last_verdict ? ` [${card.last_verdict}]` : "";
  const pull = card.pullable ? " ⟵可拉取" : "";
  const att = card.attempts > 0 ? ` (返工${card.attempts})` : "";
  return `${card.artifact_id}｜${owner}${v}${dep}${pull}${att}`;
}

/** 终端 ASCII 泳道视图。 */
export function renderBoard(board: Board): string {
  const lines = [
    `看板：${board.change_id}  放漂:${board.config.rigor}${board.finished ? "  [已完成]" : ""}${board.archived ? "  [已归档]" : ""}`,
    "",
  ];
  for (const col of ["backlog", "in_progress", "review", "done"] as BoardColumn[]) {
    const cards = board.columns[col];
    lines.push(`【${COLUMN_LABELS[col]}】(${cards.length})`);
    if (cards.length === 0) lines.push("  —");
    else for (const c of cards) lines.push(`  ${cardLine(c)}`);
    lines.push("");
  }

  // Blocked 列分两子区
  const blocked = board.columns.blocked;
  const rework = blocked.filter((c) => c.blocked_lane === "rework");
  const escalated = blocked.filter((c) => c.blocked_lane === "escalated");
  lines.push(`【${COLUMN_LABELS.blocked}】(${blocked.length})`);
  lines.push(`  ▸ 等返工 (${rework.length})`);
  for (const c of rework) lines.push(`    ${cardLine(c)}`);
  lines.push(`  ▸ 等人裁决 (${escalated.length})`);
  for (const c of escalated) lines.push(`    ${cardLine(c)}`);
  lines.push("");

  if (board.critical_path.length > 1) {
    lines.push(`关键链路：${board.critical_path.join(" → ")}`);
  }
  if (board.next_pullable.length > 0) {
    lines.push(`可拉取：${board.next_pullable.join(", ")}`);
  }
  return lines.join("\n");
}

/** board.md 内容：单向派生的只读镜像。任何手动编辑都会在下次命令时被覆盖。 */
export function renderBoardMarkdown(board: Board): string {
  const now = new Date().toISOString();
  const out: string[] = [
    "<!-- 本文件由 rockspec 自动生成，请勿手动编辑；编辑会在下次命令时被覆盖。 -->",
    "",
    `# 看板：${board.change_id}`,
    "",
    `> 放漂级别：${board.config.rigor}　|　状态：${board.archived ? "已归档" : board.finished ? "已完成" : "进行中"}　|　更新：${now}`,
    "",
    "## 泳道",
    "",
    "| Backlog | In Progress | Review | Done |",
    "|---|---|---|---|",
  ];

  const cols: BoardColumn[] = ["backlog", "in_progress", "review", "done"];
  const maxRows = Math.max(...cols.map((c) => board.columns[c].length), 1);
  for (let row = 0; row < maxRows; row++) {
    const cells = cols.map((col) => {
      const card = board.columns[col][row];
      return card ? mdCell(card) : "";
    });
    out.push(`| ${cells.join(" | ")} |`);
  }

  // Blocked 子区
  out.push("", "## Blocked", "");
  const blocked = board.columns.blocked;
  const rework = blocked.filter((c) => c.blocked_lane === "rework");
  const escalated = blocked.filter((c) => c.blocked_lane === "escalated");
  out.push(`### 等返工（${rework.length}）`, "");
  if (rework.length === 0) out.push("无。");
  else for (const c of rework) out.push(`- ${mdCell(c)}`);
  out.push("", `### 等人裁决（${escalated.length}）`, "");
  if (escalated.length === 0) out.push("无。");
  else for (const c of escalated) out.push(`- ⚠ ${mdCell(c)}`);

  // 关键链 + 可拉取
  out.push("", "## 关键链路", "");
  out.push(board.critical_path.length > 1 ? board.critical_path.join(" → ") : "（单节点，无链）");
  out.push("", "## 下一步可拉取", "");
  out.push(board.next_pullable.length > 0 ? board.next_pullable.map((id) => `- ${id}`).join("\n") : "（无——等待进行中的卡完成或全部已 Done）");
  out.push("");
  return out.join("\n");
}

function mdCell(card: BoardCard): string {
  const owner = card.owner === "human" ? "👤人" : card.owner ? card.owner.toUpperCase() : "—";
  const dep = card.blocked_by.length ? ` ⟨阻塞:${card.blocked_by.join(",")}⟩` : "";
  const v = card.last_verdict ? ` \`${card.last_verdict}\`` : "";
  const att = card.attempts > 0 ? ` (返工${card.attempts})` : "";
  const pull = card.pullable ? " ⟵" : "";
  return `**${card.artifact_id}** · ${owner}${v}${dep}${att}${pull}`;
}
