export class RockSpecError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly exitCode: number;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    exitCode = 1,
  ) {
    super(message);
    this.name = "RockSpecError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      exit_code: this.exitCode,
    };
  }
}
