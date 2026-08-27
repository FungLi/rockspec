// 看板投影：把 WorklistProjection 投影成列式看板。
// 纯函数、只读、确定性。看板是事件流的镜子，不是第二份真相。
import type {
  Board,
  BoardCard,
  BoardColumn,
  CardOwner,
  ItemStatus,
  WorklistItem,
  WorklistProjection,
} from "./types.js";
import { BOARD_COLUMNS } from "./types.js";

/** status → 看板列。 */
function columnOf(status: ItemStatus): BoardColumn {
  switch (status) {
    case "pending":
      return "backlog";
    case "making":
      return "in_progress";
    case "made":
    case "checking":
      return "review";
    case "passed":
      return "done";
    case "blocked":
    case "escalated":
      return "blocked";
  }
}

/** 列 + status → owner（责任人）。 */
function ownerOf(item: WorklistItem, column: BoardColumn): CardOwner {
  switch (column) {
    case "in_progress":
      return item.maker_role; // 生产中，maker 负责
    case "review":
      return item.checker_role; // 待制衡，checker 负责
    case "blocked":
      return item.status === "escalated" ? "human" : item.maker_role; // 升级人 / 返工回 maker
    case "backlog":
    case "done":
      return null;
  }
}

/** 一张卡是否可被 PM 拉取：在 backlog 且所有依赖都已 done。 */
function isPullable(item: WorklistItem, doneIds: Set<string>): boolean {
  return item.status === "pending" && item.depends_on.every((dep) => doneIds.has(dep));
}

/** depends_on 中尚未 done 的卡（阻塞源，用于关键链可视）。 */
function blockedBy(item: WorklistItem, doneIds: Set<string>): string[] {
  return item.depends_on.filter((dep) => !doneIds.has(dep));
}

/** 计算最长依赖链（关键路径）。 */
function criticalPath(items: WorklistItem[]): string[] {
  const byId = new Map(items.map((i) => [i.artifact_id, i]));
  const memo = new Map<string, string[]>();

  function longestTo(id: string, seen: Set<string>): string[] {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return [id]; // 防环
    const item = byId.get(id);
    if (!item || item.depends_on.length === 0) {
      const path = [id];
      memo.set(id, path);
      return path;
    }
    const nextSeen = new Set(seen).add(id);
    let longest: string[] = [];
    for (const dep of item.depends_on) {
      const depPath = longestTo(dep, nextSeen);
      if (depPath.length > longest.length) longest = depPath;
    }
    const path = [...longest, id];
    memo.set(id, path);
    return path;
  }

  let best: string[] = [];
  for (const item of items) {
    const path = longestTo(item.artifact_id, new Set());
    if (path.length > best.length) best = path;
  }
  return best;
}

/** 把 Worklist 投影为看板。 */
export function projectBoard(wl: WorklistProjection): Board {
  const doneIds = new Set(wl.items.filter((i) => i.status === "passed").map((i) => i.artifact_id));

  const cards: BoardCard[] = wl.items.map((item) => {
    const column = columnOf(item.status);
    return {
      artifact_id: item.artifact_id,
      kind: item.kind,
      phase: item.phase,
      column,
      ...(column === "blocked"
        ? { blocked_lane: item.status === "escalated" ? ("escalated" as const) : ("rework" as const) }
        : {}),
      owner: ownerOf(item, column),
      maker_role: item.maker_role,
      checker_role: item.checker_role,
      depends_on: item.depends_on,
      blocked_by: blockedBy(item, doneIds),
      pullable: isPullable(item, doneIds),
      attempts: item.attempts,
      ...(item.last_verdict ? { last_verdict: item.last_verdict } : {}),
    };
  });

  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as BoardCard[]])) as Record<
    BoardColumn,
    BoardCard[]
  >;
  for (const card of cards) columns[card.column].push(card);

  return {
    change_id: wl.change_id,
    config: wl.config,
    cards,
    columns,
    next_pullable: cards.filter((c) => c.pullable).map((c) => c.artifact_id),
    critical_path: criticalPath(wl.items),
    finished: wl.finished,
    archived: wl.archived,
  };
}

/** 确定性的「下一张可拉取的卡」集合。 */
export function nextPullable(board: Board): string[] {
  return board.next_pullable;
}
