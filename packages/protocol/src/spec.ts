import { z } from "zod";
import { SPEC_OPERATIONS, type SpecOperation } from "./constants.js";
import {
  ProtocolValidationError,
  type ValidationIssue,
  type ValidationResult,
  zodIssues,
} from "./validation.js";

const REQUIREMENT_ID_PATTERN = /^R-\d{3,}$/;
const SCENARIO_ID_PATTERN = /^S-\d{3,}$/;

export const ScenarioSchema = z
  .object({
    id: z.string().regex(SCENARIO_ID_PATTERN, "Scenario ID must use S-001 format"),
    title: z.string().min(1),
    given: z.array(z.string().min(1)).min(1, "Scenario requires at least one GIVEN step"),
    when: z.array(z.string().min(1)).min(1, "Scenario requires at least one WHEN step"),
    then: z.array(z.string().min(1)).min(1, "Scenario requires at least one THEN step"),
    and: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

export const RequirementSchema = z
  .object({
    id: z.string().regex(REQUIREMENT_ID_PATTERN, "Requirement ID must use R-001 format"),
    title: z.string().min(1),
    operation: z.enum(SPEC_OPERATIONS),
    statement: z
      .string()
      .min(1)
      .refine(
        (statement) => /\bMUST(?: NOT)?\b/.test(statement),
        "Requirement statement must contain MUST or MUST NOT",
      ),
    scenarios: z.array(ScenarioSchema).min(1, "Requirement requires at least one Scenario"),
  })
  .strict();

export type Requirement = z.infer<typeof RequirementSchema>;

export const SpecDocumentSchema = z
  .object({
    requirements: z.array(RequirementSchema).min(1, "Spec requires at least one Requirement"),
  })
  .strict();

export type SpecDocument = z.infer<typeof SpecDocumentSchema>;

interface DraftScenario {
  id: string;
  title: string;
  given: string[];
  when: string[];
  then: string[];
  and: string[];
  line: number;
}

interface DraftRequirement {
  id: string;
  title: string;
  operation: SpecOperation;
  body: string[];
  scenarios: DraftScenario[];
  line: number;
}

export function validateSpec(markdown: string): ValidationResult<SpecDocument> {
  const lines = markdown.split(/\r?\n/);
  const issues: ValidationIssue[] = [];
  const drafts: DraftRequirement[] = [];
  let operation: SpecOperation | undefined;
  let requirement: DraftRequirement | undefined;
  let scenario: DraftScenario | undefined;

  const addIssue = (line: number, code: string, message: string): void => {
    issues.push({ code, path: ["lines", line], message });
  };

  const flushScenario = (): void => {
    if (scenario === undefined) return;
    if (requirement === undefined) {
      addIssue(scenario.line, "orphan_scenario", "Scenario must belong to a Requirement");
    } else {
      requirement.scenarios.push(scenario);
    }
    scenario = undefined;
  };

  const flushRequirement = (): void => {
    flushScenario();
    if (requirement !== undefined) {
      drafts.push(requirement);
      requirement = undefined;
    }
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const operationMatch = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/.exec(line);
    if (operationMatch !== null) {
      flushRequirement();
      operation = operationMatch[1] as SpecOperation;
      return;
    }

    const looseOperationMatch =
      /^##\s+(added|modified|removed|renamed) requirements\s*$/i.exec(line);
    if (looseOperationMatch !== null) {
      flushRequirement();
      operation = looseOperationMatch[1]?.toUpperCase() as SpecOperation;
      addIssue(
        lineNumber,
        "invalid_keyword_case",
        "Operation heading must use ADDED/MODIFIED/REMOVED/RENAMED and Requirements exactly",
      );
      return;
    }

    const requirementMatch = /^###\s+(R-\d{3,}) Requirement:\s*(\S.*)\s*$/.exec(line);
    if (requirementMatch !== null) {
      flushRequirement();
      if (operation === undefined) {
        addIssue(
          lineNumber,
          "missing_operation",
          "Requirement must appear under an operation heading",
        );
      }
      requirement = {
        id: requirementMatch[1] ?? "",
        title: requirementMatch[2] ?? "",
        operation: operation ?? "ADDED",
        body: [],
        scenarios: [],
        line: lineNumber,
      };
      return;
    }

    const looseRequirementMatch = /^###\s+(R-[^\s]+)\s+requirement:\s*(.*)$/i.exec(line);
    if (looseRequirementMatch !== null) {
      flushRequirement();
      addIssue(
        lineNumber,
        "invalid_requirement_heading",
        "Requirement heading must use `### R-001 Requirement: <title>`",
      );
      requirement = {
        id: looseRequirementMatch[1] ?? "",
        title: looseRequirementMatch[2] ?? "",
        operation: operation ?? "ADDED",
        body: [],
        scenarios: [],
        line: lineNumber,
      };
      return;
    }

    const scenarioMatch = /^####\s+(S-\d{3,}) Scenario:\s*(\S.*)\s*$/.exec(line);
    if (scenarioMatch !== null) {
      flushScenario();
      scenario = {
        id: scenarioMatch[1] ?? "",
        title: scenarioMatch[2] ?? "",
        given: [],
        when: [],
        then: [],
        and: [],
        line: lineNumber,
      };
      return;
    }

    const looseScenarioMatch = /^####\s+(S-[^\s]+)\s+scenario:\s*(.*)$/i.exec(line);
    if (looseScenarioMatch !== null) {
      flushScenario();
      addIssue(
        lineNumber,
        "invalid_scenario_heading",
        "Scenario heading must use `#### S-001 Scenario: <title>`",
      );
      scenario = {
        id: looseScenarioMatch[1] ?? "",
        title: looseScenarioMatch[2] ?? "",
        given: [],
        when: [],
        then: [],
        and: [],
        line: lineNumber,
      };
      return;
    }

    const stepMatch = /^-\s+(GIVEN|WHEN|THEN|AND)\s+(\S.*)\s*$/.exec(line);
    if (stepMatch !== null && scenario !== undefined) {
      const keyword = stepMatch[1] as "GIVEN" | "WHEN" | "THEN" | "AND";
      const value = stepMatch[2] ?? "";
      scenario[keyword.toLowerCase() as "given" | "when" | "then" | "and"].push(value);
      return;
    }

    const looseStepMatch = /^-\s+(given|when|then|and)\b\s*(.*)$/i.exec(line);
    if (looseStepMatch !== null && scenario !== undefined) {
      const keyword = looseStepMatch[1]?.toUpperCase() as "GIVEN" | "WHEN" | "THEN" | "AND";
      scenario[keyword.toLowerCase() as "given" | "when" | "then" | "and"].push(
        looseStepMatch[2] ?? "",
      );
      addIssue(lineNumber, "invalid_keyword_case", `${keyword} must be uppercase`);
      return;
    }

    if (requirement !== undefined && scenario === undefined && line.trim().length > 0) {
      requirement.body.push(line.trim());
      if (/\bmust(?: not)?\b/i.test(line) && !/\bMUST(?: NOT)?\b/.test(line)) {
        addIssue(lineNumber, "invalid_keyword_case", "MUST and MUST NOT must be uppercase");
      }
    }
  });

  flushRequirement();

  const documentCandidate = {
    requirements: drafts.map((draft) => ({
      id: draft.id,
      title: draft.title,
      operation: draft.operation,
      statement: draft.body.join("\n"),
      scenarios: draft.scenarios.map(({ line: _line, ...item }) => item),
    })),
  };

  const requirementIds = new Set<string>();
  const scenarioIds = new Set<string>();
  for (const draft of drafts) {
    if (requirementIds.has(draft.id)) {
      addIssue(draft.line, "duplicate_requirement_id", `Duplicate Requirement ID ${draft.id}`);
    }
    requirementIds.add(draft.id);
    for (const item of draft.scenarios) {
      if (scenarioIds.has(item.id)) {
        addIssue(item.line, "duplicate_scenario_id", `Duplicate Scenario ID ${item.id}`);
      }
      scenarioIds.add(item.id);
    }
  }

  const schemaResult = SpecDocumentSchema.safeParse(documentCandidate);
  if (!schemaResult.success) {
    issues.push(...zodIssues(schemaResult.error));
  }

  if (issues.length > 0 || !schemaResult.success) {
    return { valid: false, issues };
  }
  return { valid: true, data: schemaResult.data, issues: [] };
}

export function parseSpec(markdown: string): SpecDocument {
  const result = validateSpec(markdown);
  if (result.valid) return result.data;
  throw new ProtocolValidationError("Invalid RockSpec spec", result.issues);
}

export function assertValidSpec(markdown: string): void {
  parseSpec(markdown);
}
