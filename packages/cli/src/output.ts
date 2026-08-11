export const CLI_SCHEMA_VERSION = 1 as const;

export interface CliSuccess<T> {
  schema_version: typeof CLI_SCHEMA_VERSION;
  ok: true;
  command: string;
  data: T;
}

export interface CliFailure {
  schema_version: typeof CLI_SCHEMA_VERSION;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details: unknown;
  };
}

export function successEnvelope<T>(command: string, data: T): CliSuccess<T> {
  return { schema_version: CLI_SCHEMA_VERSION, ok: true, command, data };
}

export function failureEnvelope(command: string, error: unknown): CliFailure {
  const candidate = asErrorRecord(error);
  return {
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code: typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR",
      message:
        typeof candidate.message === "string" ? candidate.message : "An unexpected error occurred",
      details: candidate.details ?? candidate.issues ?? null,
    },
  };
}

export function errorExitCode(error: unknown): number {
  const value = asErrorRecord(error).exitCode;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

export function formatHuman(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (!isRecord(data)) {
    return JSON.stringify(data, null, 2);
  }

  const lines: string[] = [];
  const change = isRecord(data.change) ? data.change : data;
  const id = stringValue(change.id);
  const state = stringValue(data.current_state) ?? stringValue(change.state);
  const profile = stringValue(change.profile);

  if (id) lines.push(`Change: ${id}`);
  if (profile) lines.push(`Profile: ${profile}`);
  if (state) lines.push(`State: ${state}`);

  const next = isRecord(data.recommended_next) ? data.recommended_next : undefined;
  if (next) {
    const action = stringValue(next.action);
    const reason = stringValue(next.reason);
    if (action) lines.push(`Next: ${action}${reason ? ` - ${reason}` : ""}`);
  }

  const blocked = Array.isArray(data.blocked_by) ? data.blocked_by : [];
  for (const item of blocked) {
    if (typeof item === "string") lines.push(`Blocked: ${item}`);
    else if (isRecord(item)) lines.push(`Blocked: ${stringValue(item.message) ?? JSON.stringify(item)}`);
  }

  if (lines.length > 0) return lines.join("\n");
  if (typeof data.message === "string") return data.message;
  return JSON.stringify(data, null, 2);
}

function asErrorRecord(error: unknown): Record<string, unknown> {
  if (isRecord(error)) return error;
  return { message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
