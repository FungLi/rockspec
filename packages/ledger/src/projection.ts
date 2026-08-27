// 投影层：把仅追加事件日志重建为当前 Worklist 全景。
// 纯函数：events + meta -> WorklistProjection，无副作用、无状态机。
import type {
  ChangeMeta,
  CheckerConclusion,
  HookMark,
  LedgerEvent,
  MakerConclusion,
  WorklistItem,
  WorklistProjection,
} from "./types.js";

export interface ProjectionInput {
  meta: ChangeMeta;
  events: LedgerEvent[];
}

/** 从事件流投影出 Worklist 全景。 */
export function projectWorklist({ meta, events }: ProjectionInput): WorklistProjection {
  const items = new Map<string, WorklistItem>();
  let finished = false;
  let archived = false;

  for (const event of events) {
    const id = event.artifact_id;
    switch (event.type) {
      case "item.registered": {
        const d = event.data as unknown as Omit<WorklistItem, "status" | "attempts">;
        items.set(d.artifact_id, {
          ...d,
          status: "pending",
          attempts: 0,
        });
        break;
      }
      case "item.making": {
        const item = id ? items.get(id) : undefined;
        if (item) item.status = "making";
        break;
      }
      case "maker.concluded": {
        const item = id ? items.get(id) : undefined;
        const c = event.data?.conclusion as MakerConclusion | undefined;
        if (item && c) {
          item.output_hash = c.output_hash;
          // 有 blockers → 升级；否则待制衡
          item.status = c.blockers.length > 0 ? "escalated" : "made";
        }
        break;
      }
      case "hook.marked": {
        // hook 结果不直接改 status，但脏 mark 会在制衡时被读取
        break;
      }
      case "item.checking": {
        const item = id ? items.get(id) : undefined;
        if (item) item.status = "checking";
        break;
      }
      case "checker.concluded": {
        const item = id ? items.get(id) : undefined;
        const c = event.data?.conclusion as CheckerConclusion | undefined;
        if (item && c) {
          item.last_verdict = c.verdict;
          if (c.verdict === "PASS") {
            item.status = "passed";
          } else {
            item.status = "blocked";
            item.attempts += 1;
          }
        }
        break;
      }
      case "item.escalated": {
        const item = id ? items.get(id) : undefined;
        if (item) item.status = "escalated";
        break;
      }
      case "item.passed": {
        const item = id ? items.get(id) : undefined;
        if (item) item.status = "passed";
        break;
      }
      case "change.finished":
        finished = true;
        break;
      case "change.archived":
        archived = true;
        break;
      default:
        break;
    }
  }

  return {
    change_id: meta.id,
    config: meta.config,
    items: [...items.values()],
    finished,
    archived,
  };
}

/** 取某产物最新的 hook mark（若有）。 */
export function latestHookMark(events: LedgerEvent[], artifactId: string): HookMark | undefined {
  let mark: HookMark | undefined;
  for (const event of events) {
    if (event.type === "hook.marked" && event.artifact_id === artifactId) {
      mark = event.data?.mark as HookMark | undefined;
    }
  }
  return mark;
}

/** 取某产物最新的制衡结论（若有）。 */
export function latestCheckerConclusion(
  events: LedgerEvent[],
  artifactId: string,
): CheckerConclusion | undefined {
  let conclusion: CheckerConclusion | undefined;
  for (const event of events) {
    if (event.type === "checker.concluded" && event.artifact_id === artifactId) {
      conclusion = event.data?.conclusion as CheckerConclusion | undefined;
    }
  }
  return conclusion;
}

/** 取某产物最新的生产者结论（若有）。 */
export function latestMakerConclusion(
  events: LedgerEvent[],
  artifactId: string,
): MakerConclusion | undefined {
  let conclusion: MakerConclusion | undefined;
  for (const event of events) {
    if (event.type === "maker.concluded" && event.artifact_id === artifactId) {
      conclusion = event.data?.conclusion as MakerConclusion | undefined;
    }
  }
  return conclusion;
}
