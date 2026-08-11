import type { ZodError, ZodType } from "zod";

export interface ValidationIssue {
  code: string;
  path: Array<string | number>;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; data: T; issues: [] }
  | { valid: false; issues: ValidationIssue[] };

export class ProtocolValidationError extends Error {
  readonly code = "ROCKSPEC_PROTOCOL_VALIDATION_ERROR";
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }

  toJSON(): { code: string; message: string; issues: ValidationIssue[] } {
    return { code: this.code, message: this.message, issues: this.issues };
  }
}

export function zodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map((segment) =>
      typeof segment === "symbol" ? segment.description ?? segment.toString() : segment,
    ),
    message: issue.message,
  }));
}

export function safeParseProtocol<T>(schema: ZodType<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { valid: true, data: result.data, issues: [] };
  }
  return { valid: false, issues: zodIssues(result.error) };
}

export function parseProtocol<T>(schema: ZodType<T>, input: unknown, label: string): T {
  const result = safeParseProtocol(schema, input);
  if (result.valid) {
    return result.data;
  }
  throw new ProtocolValidationError(`Invalid ${label}`, result.issues);
}
