// 校验 rockspec-* skill 齐备且 frontmatter 合法。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const RS2_SKILLS = [
  "rockspec-pm",
  "rockspec-ba",
  "rockspec-sa",
  "rockspec-rr",
  "rockspec-dev",
  "rockspec-cr",
  "rockspec-te",
  "rockspec-glossary",
];

function frontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return m ? (parse(m[1]!) as { name?: string; description?: string }) : {};
}

describe("rockspec skills", () => {
  it("发布全部 7 角色 + 词汇表 skill", () => {
    for (const skill of RS2_SKILLS) {
      expect(existsSync(path.join(repoRoot, "skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  it("每个 skill 的 frontmatter 含 name 且与目录一致", async () => {
    for (const skill of RS2_SKILLS) {
      const md = await readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
      const fm = frontmatter(md);
      expect(fm.name).toBe(skill);
      expect(typeof fm.description).toBe("string");
      expect((fm.description ?? "").length).toBeGreaterThan(10);
    }
  });

  it("制衡者 skill 声明「先读 hook mark 脏则直接打回」", async () => {
    for (const skill of ["rockspec-rr", "rockspec-cr", "rockspec-te"]) {
      const md = await readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(md).toMatch(/hook mark|Hook mark|hook 标记/);
    }
  });

  it("PM skill 声明双模式切换与三铁律", async () => {
    const md = await readFile(path.join(repoRoot, "skills", "rockspec-pm", "SKILL.md"), "utf8");
    expect(md).toMatch(/inline/);
    expect(md).toMatch(/折叠|fold/);
  });
});
