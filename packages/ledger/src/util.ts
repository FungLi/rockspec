// 自包含工具：hash、change-id、markdown 扫描。
// （PM 编排架构不依赖旧 protocol 包，这些能力内联于此。）
import { createHash } from "node:crypto";
import { z } from "zod";

// --- hash ---------------------------------------------------------------
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// --- change id ----------------------------------------------------------
const CHANGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(["archive", "changes", "specs", "config", "current", "new"]);

export const ChangeIdSchema = z
  .string()
  .min(3, "Change ID 至少 3 个字符")
  .max(64, "Change ID 至多 64 个字符")
  .regex(CHANGE_ID_PATTERN, "Change ID 必须为小写 kebab-case，以字母开头，仅含字母数字与连字符")
  .refine((value) => !RESERVED.has(value), "Change ID 为保留字");

// --- markdown 扫描 ------------------------------------------------------
export interface MarkdownHeading {
  level: number;
  title: string;
}

export interface MarkdownLine {
  index: number;
  number: number;
  text: string;
  inFence: boolean;
  heading?: MarkdownHeading;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

export function parseMarkdownHeading(line: string): MarkdownHeading | undefined {
  const match = /^ {0,3}(#{1,6})\s+(\S.*)\s*$/.exec(line);
  return match ? { level: match[1]!.length, title: match[2]! } : undefined;
}

export function scanMarkdown(markdown: string): MarkdownLine[] {
  const lines = markdown.split(/\r?\n/);
  let fence: Fence | undefined;
  return lines.map((text, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    const wasInFence = fence !== undefined;
    if (!fence && marker) {
      fence = { marker: marker[1]![0] as Fence["marker"], length: marker[1]!.length };
    } else if (
      fence &&
      marker &&
      marker[1]![0] === fence.marker &&
      marker[1]!.length >= fence.length &&
      marker[2]!.trim() === ""
    ) {
      fence = undefined;
    }
    const inFence = wasInFence || marker !== null;
    return {
      index,
      number: index + 1,
      text,
      inFence,
      ...(!inFence && parseMarkdownHeading(text) ? { heading: parseMarkdownHeading(text)! } : {}),
    };
  });
}
