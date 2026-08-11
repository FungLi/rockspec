import { createHash } from "node:crypto";
import { ProtocolValidationError } from "./validation.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export const hashContent = sha256;

export function canonicalStringify(value: unknown): string {
  const ancestors = new Set<object>();

  const visit = (current: unknown, path: Array<string | number>): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      return current;
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) {
        throw invalidCanonicalValue(path, "Circular values cannot be hashed canonically");
      }
      ancestors.add(current);
      const result = current.map((item, index) => visit(item, [...path, index]));
      ancestors.delete(current);
      return result;
    }
    if (typeof current === "object") {
      const object = current as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(object) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidCanonicalValue(
          path,
          "Only plain objects, arrays, and JSON primitives can be hashed canonically",
        );
      }
      if (ancestors.has(object)) {
        throw invalidCanonicalValue(path, "Circular values cannot be hashed canonically");
      }
      ancestors.add(object);
      const result: Record<string, JsonValue> = {};
      for (const key of Object.keys(object).sort()) {
        result[key] = visit(object[key], [...path, key]);
      }
      ancestors.delete(object);
      return result;
    }
    throw invalidCanonicalValue(path, `Unsupported canonical value type: ${typeof current}`);
  };

  return JSON.stringify(visit(value, []));
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalStringify(value));
}

function invalidCanonicalValue(
  path: Array<string | number>,
  message: string,
): ProtocolValidationError {
  return new ProtocolValidationError("Cannot hash value canonically", [
    { code: "invalid_canonical_value", path, message },
  ]);
}
