// Ledger 存储层：仅追加事件日志 + change 元数据。
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { ChangeMeta, LedgerEvent } from "./types.js";

const ROCKS_DIR = ".rockspec";
const CHANGES_DIR = "changes";
const EVENTS_FILE = "events.ndjson";
const META_FILE = "change.yaml";

export function rocksRoot(repoRoot: string): string {
  return path.join(repoRoot, ROCKS_DIR);
}

export function changeDir(repoRoot: string, changeId: string): string {
  return path.join(rocksRoot(repoRoot), CHANGES_DIR, changeId);
}

export function changeExists(repoRoot: string, changeId: string): boolean {
  return existsSync(path.join(changeDir(repoRoot, changeId), META_FILE));
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

export async function writeMeta(repoRoot: string, meta: ChangeMeta): Promise<void> {
  const dir = changeDir(repoRoot, meta.id);
  await atomicWrite(path.join(dir, META_FILE), stringify(meta, { lineWidth: 0 }));
}

export async function readMeta(repoRoot: string, changeId: string): Promise<ChangeMeta> {
  const file = path.join(changeDir(repoRoot, changeId), META_FILE);
  const raw = await readFile(file, "utf8");
  return parse(raw) as ChangeMeta;
}

/** 追加一个事件，seq 自动分配。返回写入的事件。 */
export async function appendEvent(
  repoRoot: string,
  changeId: string,
  event: Omit<LedgerEvent, "seq" | "at">,
): Promise<LedgerEvent> {
  const dir = changeDir(repoRoot, changeId);
  await mkdir(dir, { recursive: true });
  const existing = await readEvents(repoRoot, changeId);
  const seq = existing.length > 0 ? existing[existing.length - 1]!.seq + 1 : 1;
  const full: LedgerEvent = { seq, at: new Date().toISOString(), ...event };
  await appendFile(path.join(dir, EVENTS_FILE), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** 读取全部事件（按 seq 顺序）。 */
export async function readEvents(repoRoot: string, changeId: string): Promise<LedgerEvent[]> {
  const file = path.join(changeDir(repoRoot, changeId), EVENTS_FILE);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerEvent)
    .sort((a, b) => a.seq - b.seq);
}

/** 列出所有 change id。 */
export async function listChanges(repoRoot: string): Promise<string[]> {
  const dir = path.join(rocksRoot(repoRoot), CHANGES_DIR);
  if (!existsSync(dir)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, META_FILE)))
    .map((e) => e.name)
    .sort();
}
