import { describe, expect, it } from "vitest";
import {
  ProtocolValidationError,
  canonicalStringify,
  hashCanonical,
  parseSpec,
  parseSpecSource,
  sha256,
  validateSpec,
} from "../src/index.js";

const VALID_SPEC = `## ADDED Requirements

### R-001 Requirement: 用户可以保存资料
系统 MUST 允许用户保存已通过校验的资料。

#### S-001 Scenario: 保存有效资料
- GIVEN 用户正在编辑有效资料
- WHEN 用户执行保存操作
- THEN 系统持久化资料
- AND 页面显示保存成功结果
`;

describe("hash helpers", () => {
  it("uses an explicit sha256 prefix", () => {
    expect(sha256("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("canonicalizes object keys while preserving array order", () => {
    expect(canonicalStringify({ z: 1, a: [2, 1] })).toBe('{"a":[2,1],"z":1}');
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });

  it("rejects values that JSON cannot hash deterministically", () => {
    expect(() => hashCanonical({ value: undefined })).toThrow(ProtocolValidationError);
    expect(() => hashCanonical(new Date())).toThrow(ProtocolValidationError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => hashCanonical(circular)).toThrow(ProtocolValidationError);
  });
});

describe("RockSpec markdown specs", () => {
  it("parses requirements, scenarios, and normative keywords", () => {
    const result = parseSpec(VALID_SPEC);
    expect(result.requirements[0]).toMatchObject({
      id: "R-001",
      operation: "ADDED",
      scenarios: [{ id: "S-001" }],
    });
  });

  it("requires exact English keyword casing", () => {
    const result = validateSpec(
      VALID_SPEC.replace("## ADDED Requirements", "## added requirements").replace(
        "- GIVEN",
        "- Given",
      ),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toContain("invalid_keyword_case");
    }
  });

  it("requires MUST and the GIVEN/WHEN/THEN sequence", () => {
    const result = validateSpec(`## ADDED Requirements
### R-001 Requirement: 缺少规范关键字
系统允许保存。
#### S-001 Scenario: 缺少结果
- GIVEN 已登录
- WHEN 点击保存
`);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.message.includes("MUST"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("THEN"))).toBe(true);
    }
  });

  it("rejects duplicate stable IDs", () => {
    const duplicate = `${VALID_SPEC}
### R-001 Requirement: 第二条需求
系统 MUST 拒绝重复资料。
#### S-001 Scenario: 重复编号
- GIVEN 资料已存在
- WHEN 用户保存
- THEN 系统拒绝保存
`;
    const result = validateSpec(duplicate);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["duplicate_requirement_id", "duplicate_scenario_id"]),
      );
    }
  });

  it("ignores headings inside backtick and tilde fences while preserving source spans", () => {
    const markdown = `## ADDED Requirements

### R-001 Requirement: Fence-aware projection
The system MUST preserve examples.

#### S-001 Scenario: Backtick example
- GIVEN a command example
- WHEN it is projected

\`\`\`bash
# not a Markdown heading
#### S-999 Scenario: not authority
\`\`\`

- THEN content after the fence remains

#### S-002 Scenario: Tilde example
- GIVEN another command example
- WHEN it is projected

~~~bash
# still not a Markdown heading
~~~

- THEN the second scenario remains
Trailing scenario guidance remains owned by S-002.
`;
    const parsed = parseSpecSource(markdown);
    expect(parsed.document.requirements[0]?.scenarios.map((scenario) => scenario.id)).toEqual(["S-001", "S-002"]);
    const first = parsed.requirements[0]?.scenarios[0];
    const second = parsed.requirements[0]?.scenarios[1];
    expect(parsed.lines.slice(first?.span.startLine, first?.span.endLine).join("\n"))
      .toContain("content after the fence remains");
    expect(parsed.lines.slice(second?.span.startLine, second?.span.endLine).join("\n"))
      .toContain("Trailing scenario guidance remains owned by S-002.");
  });
});
