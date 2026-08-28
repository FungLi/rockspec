// 校验 rockspec-* skill 齐备且 frontmatter 合法。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// 角色层（身份+边界+引用能力）
const ROLE_SKILLS = [
  "rockspec-pm",
  "rockspec-ba",
  "rockspec-sa",
  "rockspec-rr",
  "rockspec-dev",
  "rockspec-cr",
  "rockspec-te",
];
// 引用层（共享词汇 + PM 组织图）
const REFERENCE_SKILLS = ["rockspec-glossary", "rockspec-team"];
// 能力层（可复用动词，跨角色共享）
const CAPABILITY_SKILLS = [
  "rockspec-adversarial-review",
  "rockspec-inline-cocreation",
  "rockspec-isolated-rework",
  "rockspec-tdd",
  "rockspec-gwt-requirements",
  "rockspec-4class-testing",
];
const ALL_SKILLS = [...ROLE_SKILLS, ...REFERENCE_SKILLS, ...CAPABILITY_SKILLS];

function frontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return m ? (parse(m[1]!) as { name?: string; description?: string }) : {};
}

describe("rockspec skills", () => {
  it("发布三层全部 skill（7 角色 + 2 引用 + 6 能力）", () => {
    for (const skill of ALL_SKILLS) {
      expect(existsSync(path.join(repoRoot, "skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  it("每个 skill 的 frontmatter 含 name 且与目录一致", async () => {
    for (const skill of ALL_SKILLS) {
      const md = await readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
      const fm = frontmatter(md);
      expect(fm.name).toBe(skill);
      expect(typeof fm.description).toBe("string");
      expect((fm.description ?? "").length).toBeGreaterThan(10);
    }
  });

  it("制衡者角色 skill 引用对抗式评审能力，不再自带评审流程", async () => {
    for (const skill of ["rockspec-rr", "rockspec-cr", "rockspec-te"]) {
      const md = await readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(md).toMatch(/rockspec-adversarial-review/);
    }
  });

  it("对抗式评审能力单元承载「先读 hook mark 脏则直接判负」与 subject_hash 校验", async () => {
    const md = await readFile(
      path.join(repoRoot, "skills", "rockspec-adversarial-review", "SKILL.md"),
      "utf8",
    );
    expect(md).toMatch(/hook mark|Hook mark/);
    expect(md).toMatch(/subject_hash/);
  });

  it("BA/SA 角色 skill 引用共创与返工能力", async () => {
    for (const skill of ["rockspec-ba", "rockspec-sa"]) {
      const md = await readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(md).toMatch(/rockspec-inline-cocreation/);
      expect(md).toMatch(/rockspec-isolated-rework/);
    }
  });

  it("PM skill 声明三铁律并把拓扑/调度模式外链到 rockspec-team", async () => {
    const md = await readFile(path.join(repoRoot, "skills", "rockspec-pm", "SKILL.md"), "utf8");
    expect(md).toMatch(/inline/);
    expect(md).toMatch(/折叠|fold/);
    expect(md).toMatch(/rockspec-team/);
  });

  it("rockspec-team 承载 7 角色拓扑与制衡矩阵", async () => {
    const md = await readFile(path.join(repoRoot, "skills", "rockspec-team", "SKILL.md"), "utf8");
    expect(md).toMatch(/制衡矩阵/);
    for (const role of ["BA", "SA", "RR", "Dev", "CR", "TE"]) {
      expect(md).toContain(role);
    }
  });
});
